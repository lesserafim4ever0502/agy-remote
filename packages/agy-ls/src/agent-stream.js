import { randomUUID } from 'node:crypto';
import { mergeStepsUpdate, changedIndices } from './step-merger.js';
import { projectStep } from './projector.js';
import { normalizeStatus } from './utils.js';

export class AgentStreamManager {
  constructor({ transport, router, logger = console }) {
    this.transport = transport;
    this.router = router;
    this.logger = logger;
    this.entries = new Map();
  }

  subscribe(conversationId, listener) {
    let entry = this.entries.get(conversationId);
    if (!entry) {
      entry = {
        conversationId,
        state: { conversationId, steps: [], status: 'unknown', totalLength: 0 },
        listeners: new Set(),
        controller: null,
        reconnectTimer: null,
        stopped: false,
        reconnectAttempt: 0,
      };
      this.entries.set(conversationId, entry);
      this.#open(entry).catch((error) => this.#streamError(entry, error));
    }
    entry.listeners.add(listener);
    listener({ type: 'conversation.state', state: this.publicState(entry.state) });

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.#close(entry);
    };
  }

  publicState(state) {
    return {
      conversationId: state.conversationId,
      trajectoryId: state.trajectoryId,
      status: state.status,
      fullyIdle: state.fullyIdle,
      hasActiveChildren: state.hasActiveChildren,
      totalLength: state.totalLength,
      costSummary: state.costSummary,
      creditUsageSummary: state.creditUsageSummary,
    };
  }

  getState(conversationId) {
    const state = this.entries.get(conversationId)?.state;
    return state ? { ...this.publicState(state), steps: [...state.steps] } : null;
  }

  async #open(entry) {
    const instance = await this.router.forConversation(entry.conversationId);
    if (entry.stopped || entry.listeners.size === 0) return;
    const subscriberId = `agy-remote-${randomUUID()}`;
    const body = {
      conversationId: entry.conversationId,
      subscriberId,
      initialStepsPageBounds: { startIndex: 0, endIndexExclusive: 10000 },
      trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
    };
    entry.controller = this.transport.stream(instance, 'StreamAgentStateUpdates', body, {
      onOpen: () => { entry.reconnectAttempt = 0; },
      onMessage: (message) => this.#apply(entry, message?.update || message),
      onError: (error) => this.#streamError(entry, error),
      onEnd: () => this.#streamError(entry, new Error('agent state stream ended')),
    });
  }

  #apply(entry, update) {
    if (!update || entry.stopped) return;
    const state = entry.state;
    state.trajectoryId = update.trajectoryId || state.trajectoryId;
    state.status = normalizeStatus(update.status || state.status);
    state.fullyIdle = update.fullyIdle ?? state.fullyIdle;
    state.hasActiveChildren = update.hasActiveChildren ?? state.hasActiveChildren;
    state.costSummary = update.costSummary ?? state.costSummary;
    state.creditUsageSummary = update.creditUsageSummary ?? state.creditUsageSummary;

    const stepsUpdate = update.mainTrajectoryUpdate?.stepsUpdate;
    const projected = [];
    if (stepsUpdate) {
      const before = state.steps.length;
      state.steps = mergeStepsUpdate(state.steps, stepsUpdate);
      state.totalLength = Number(stepsUpdate.totalLength ?? state.steps.length);
      for (const index of changedIndices(stepsUpdate, before)) {
        projected.push(...projectStep(state.steps[index], index, {
          conversationId: entry.conversationId,
          trajectoryId: state.trajectoryId,
        }));
      }
    }

    this.#emit(entry, { type: 'conversation.state', state: this.publicState(state) });
    for (const event of projected) this.#emit(entry, event);
  }

  #emit(entry, payload) {
    for (const listener of entry.listeners) {
      try { listener(payload); } catch (error) { this.logger.error?.('[agent-stream] listener error', error); }
    }
  }

  #streamError(entry, error) {
    if (entry.stopped || entry.listeners.size === 0) return;
    this.logger.warn?.(`[agent-stream] ${entry.conversationId}: ${error.message}`);
    entry.controller?.abort();
    if (String(error.message || '').includes('not found') || error.statusCode === 404 || entry.reconnectAttempt >= 5) {
      this.#close(entry);
      return;
    }
    if (entry.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** entry.reconnectAttempt, 10000);
    entry.reconnectAttempt += 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      this.#open(entry).catch((nextError) => this.#streamError(entry, nextError));
    }, delay);
    entry.reconnectTimer.unref?.();
  }

  #close(entry) {
    entry.stopped = true;
    entry.controller?.abort();
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    this.entries.delete(entry.conversationId);
  }
}
