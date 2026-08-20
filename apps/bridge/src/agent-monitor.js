import { sendPushNotification } from "./push.js";

const ACTIVE_POLL_INTERVAL_MS = 5000; // 5s when active conversations exist
const IDLE_POLL_INTERVAL_MS = 15000;  // 15s when all conversations are idle
const IDLE_DETACH_GRACE_MS = 30000;   // Keep stream attached 30s after IDLE

export class AgentMonitor {
  constructor({ agy, hub, logger = console }) {
    this.agy = agy;
    this.hub = hub;
    this.logger = logger;

    this.monitored = new Map(); // conversationId -> { stop: fn, lastActiveAt: number, status: string }
    this.pushedKeys = new Set(); // pushKey -> timestamp
    this.activeConversations = new Set();

    this.running = false;
    this.pollTimer = null;
    this.backoffMs = 2000;
    this.lsStatus = "unknown"; // "connected" | "degraded" | "waiting_for_antigravity"
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.logger.info?.("[AgentMonitor] Starting persistent agent monitor...");
    await this.reconcile();
    this.scheduleNextPoll();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [id, entry] of this.monitored.entries()) {
      try { entry.stop?.(); } catch {}
    }
    this.monitored.clear();
    this.activeConversations.clear();
    this.logger.info?.("[AgentMonitor] Stopped persistent agent monitor.");
  }

  scheduleNextPoll(delayMs) {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    const interval = delayMs || (this.activeConversations.size > 0 ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      await this.reconcile();
      this.scheduleNextPoll();
    }, interval);
  }

  async reconcile() {
    try {
      const rawList = await this.agy.conversations.list().catch((err) => {
        throw new Error(`LS list failed: ${err.message}`);
      });
      const conversations = Array.isArray(rawList) ? rawList : (rawList.conversations || []);

      this.lsStatus = "connected";
      this.backoffMs = 2000; // Reset backoff on success

      const now = Date.now();
      const currentActive = new Set();

      for (const conv of conversations) {
        const id = conv.id || conv.cascadeId;
        const status = String(conv.status || "").toLowerCase();
        const isActive = status === "running" || status === "waiting" || status.includes("waiting");

        if (isActive) {
          currentActive.add(id);
          this.ensureMonitored(id);
        } else if (this.monitored.has(id)) {
          // Conversation is IDLE
          const entry = this.monitored.get(id);
          if (entry.status !== "idle") {
            entry.status = "idle";
            entry.lastActiveAt = now;
          } else if (now - entry.lastActiveAt > IDLE_DETACH_GRACE_MS) {
            // Grace period exceeded: detach stream
            try { entry.stop?.(); } catch {}
            this.monitored.delete(id);
            this.logger.debug?.(`[AgentMonitor] Detached idle stream for conversation ${id.slice(0, 10)}`);
          }
        }
      }

      this.activeConversations = currentActive;
    } catch (err) {
      this.lsStatus = "degraded";
      this.logger.warn?.(`[AgentMonitor] Language Server unreachable (${err.message}). Retrying in ${this.backoffMs}ms...`);
      
      // Exponential backoff up to 20s
      const nextDelay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 1.5, 20000);

      // Attempt router rediscover
      this.agy.router?.refresh().catch(() => {});
      this.scheduleNextPoll(nextDelay);
    }
  }

  ensureMonitored(conversationId) {
    if (!conversationId || this.monitored.has(conversationId)) return;

    this.logger.debug?.(`[AgentMonitor] Attaching persistent stream for conversation ${conversationId.slice(0, 10)}`);

    const stopFn = this.agy.streams.subscribe(conversationId, (event) => {
      this.handleStreamEvent(conversationId, event);
    });

    this.monitored.set(conversationId, {
      stop: stopFn,
      lastActiveAt: Date.now(),
      status: "running",
    });
  }

  handleStreamEvent(conversationId, event) {
    // 1. Always publish event to EventHub for any connected WebSocket clients
    this.hub.publish("conversation", conversationId, event);

    const now = Date.now();
    const entry = this.monitored.get(conversationId);
    if (entry) entry.lastActiveAt = now;

    // 2. Track activity state
    if (event.type === "conversation.state") {
      const st = String(event.state?.status || "").toLowerCase();
      if (st === "running" || st === "waiting" || st.includes("waiting")) {
        this.activeConversations.add(conversationId);
        if (entry) entry.status = st;
      } else if (st === "idle") {
        this.activeConversations.delete(conversationId);
        if (entry) entry.status = "idle";
      }
    }

    // 3. Precise Web Push Notification with Trajectory-Aware Deduplication
    const isApproval = event.type === "approval.required";
    const isQuestion = event.type === "agent.question";

    if (isApproval || isQuestion) {
      const trajectoryId = event.trajectoryId || "main";
      const stepIndex = event.stepIndex ?? 0;
      const kind = event.interaction?.kind || (isQuestion ? "question" : "action");

      // Unique push key: conversationId:trajectoryId:stepIndex:kind
      const pushKey = `${conversationId}:${trajectoryId}:${stepIndex}:${kind}`;

      if (!this.pushedKeys.has(pushKey)) {
        this.pushedKeys.add(pushKey);
        this.logger.info?.(`[AgentMonitor] Triggering Push Notification: ${pushKey}`);

        const title = isApproval ? "Antigravity Approval Required" : "Question from Agent";
        const body = event.interaction?.kind
          ? `Action needed: ${event.interaction.kind}`
          : (event.text?.slice(0, 120) || "Agent is waiting for your response.");

        sendPushNotification({
          title,
          body,
          data: {
            conversationId,
            trajectoryId,
            stepIndex,
            kind,
            url: `/#conv=${conversationId}`,
          },
        }).catch((pushErr) => {
          this.logger.warn?.(`[AgentMonitor] Push dispatch failed: ${pushErr.message}`);
        });
      }
    } else if (event.type === "assistant.message" || (event.type === "conversation.state" && event.state?.status === "running")) {
      // Step progressed or resumed: clear dedupe keys for previous steps in this conversation
      for (const k of this.pushedKeys) {
        if (k.startsWith(`${conversationId}:`)) {
          this.pushedKeys.delete(k);
        }
      }
    }
  }

  status() {
    return {
      running: this.running,
      lsStatus: this.lsStatus,
      monitoredCount: this.monitored.size,
      activeCount: this.activeConversations.size,
      monitoredConversations: [...this.monitored.keys()],
    };
  }
}
