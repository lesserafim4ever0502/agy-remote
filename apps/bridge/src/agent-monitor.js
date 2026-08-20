import { sendPushNotification } from "./push.js";

const ACTIVE_POLL_INTERVAL_MS = 5000; // 5s when active conversations exist
const IDLE_POLL_INTERVAL_MS = 15000;  // 15s when all conversations are idle
const IDLE_DETACH_GRACE_MS = 30000;   // Keep stream attached 30s after IDLE

export class AgentMonitor {
  constructor({ agy, hub, logger = console, pushSender = sendPushNotification }) {
    this.agy = agy;
    this.hub = hub;
    this.logger = logger;
    this.pushSender = pushSender;

    this.monitored = new Map(); // conversationId -> { stop: fn, lastActiveAt: number, status: string }
    this.pushedKeys = new Map(); // pushKey -> { conversationId, trajectoryId, stepIndex, kind, timestamp }
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
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

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

        // Verify that existing monitored entries are genuinely subscribed at the LS layer
        if (this.monitored.has(id)) {
          const isAlive = this.agy.streams?.isSubscribed?.(id) ?? true;
          if (!isAlive) {
            this.logger.warn?.(`[AgentMonitor] Detected stale dead stream for ${id.slice(0, 10)}. Evicting to re-subscribe.`);
            this.monitored.delete(id);
          }
        }

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
    if (!conversationId) return;

    // Check if genuinely active
    if (this.monitored.has(conversationId)) {
      const isAlive = this.agy.streams?.isSubscribed?.(conversationId) ?? true;
      if (isAlive) return;
      this.monitored.delete(conversationId);
    }

    this.logger.debug?.(`[AgentMonitor] Attaching persistent stream for conversation ${conversationId.slice(0, 10)}`);

    const stopFn = this.agy.streams.subscribe(
      conversationId,
      (event) => this.handleStreamEvent(conversationId, event),
      {
        onClose: (id) => {
          this.monitored.delete(id);
          this.logger.debug?.(`[AgentMonitor] Stream closed by LS layer for ${id.slice(0, 10)}. Removed from monitored map.`);
        },
        onError: (err, id) => {
          this.logger.warn?.(`[AgentMonitor] Stream error for ${id.slice(0, 10)}: ${err.message}`);
        },
      }
    );

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
        // When conversation becomes IDLE, clear all pending push keys for this conversation
        for (const [key, item] of this.pushedKeys.entries()) {
          if (item.conversationId === conversationId) {
            this.pushedKeys.delete(key);
          }
        }
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
        this.pushedKeys.set(pushKey, {
          conversationId,
          trajectoryId,
          stepIndex,
          kind,
          timestamp: Date.now(),
        });
        this.logger.info?.(`[AgentMonitor] Triggering Push Notification: ${pushKey}`);

        const title = isApproval ? "Antigravity Approval Required" : "Question from Agent";
        const body = event.interaction?.kind
          ? `Action needed: ${event.interaction.kind}`
          : (event.text?.slice(0, 120) || "Agent is waiting for your response.");

        this.pushSender({
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
    } else if (event.stepIndex !== undefined) {
      // Step advanced on this trajectory: clean up keys for older steps on the same trajectory
      const trajectoryId = event.trajectoryId || "main";
      const currentStep = event.stepIndex;
      for (const [key, item] of this.pushedKeys.entries()) {
        if (item.conversationId === conversationId && item.trajectoryId === trajectoryId && item.stepIndex < currentStep) {
          this.pushedKeys.delete(key);
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
