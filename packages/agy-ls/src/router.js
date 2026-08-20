import { discoverLanguageServers } from './discovery.js';
import { entriesLike, fileUriToPath } from './utils.js';

function summaryEntries(response) {
  return entriesLike(response?.trajectorySummaries ?? response?.trajectory_summaries ?? response?.summaries);
}

export class AgyRouter {
  constructor(transport, { logger = console } = {}) {
    this.transport = transport;
    this.logger = logger;
    this.instances = [];
    this.ownerMap = new Map();
    this.pinned = new Map();
    this.refreshPromise = null;
    this.lastRefreshAt = 0;
  }

  async refresh({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs > 0 && this.instances.length && Date.now() - this.lastRefreshAt < maxAgeMs) return this.instances;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const discovered = await discoverLanguageServers(this.transport, { logger: this.logger });
      if (discovered.length === 0) {
        this.lastRefreshAt = Date.now();
        if (this.instances.length) {
          this.logger.warn?.('[router] discovery returned no instances; keeping last known Language Server routes');
          return this.instances;
        }
        throw new Error('No reachable Antigravity Language Server found');
      }
      this.instances = discovered;
      await this.refreshOwners();
      this.lastRefreshAt = Date.now();
      return this.instances;
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async ensure() {
    if (!this.instances.length) await this.refresh();
    return this.instances;
  }

  async refreshOwners() {
    const next = new Map();
    await Promise.all(this.instances.map(async (instance) => {
      try {
        const response = await this.transport.unary(instance, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false });
        for (const [id] of summaryEntries(response)) if (id) next.set(id, instance);
      } catch (error) {
        this.logger.debug?.(`[router] owner refresh failed on ${instance.port}: ${error.message}`);
      }
    }));
    this.ownerMap = next;
  }

  pinConversation(cascadeId, instance) {
    this.pinned.set(cascadeId, instance);
    this.ownerMap.set(cascadeId, instance);
  }

  async forConversation(cascadeId, { write = false } = {}) {
    await this.ensure();
    const cached = this.pinned.get(cascadeId) || this.ownerMap.get(cascadeId);
    if (cached) return cached;

    const owners = [];
    await Promise.all(this.instances.map(async (instance) => {
      try {
        const response = await this.transport.unary(instance, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false });
        if (summaryEntries(response).some(([id]) => id === cascadeId)) owners.push(instance);
      } catch {}
    }));
    if (owners.length === 1) {
      this.pinConversation(cascadeId, owners[0]);
      return owners[0];
    }
    if (write) throw new Error(`Cannot safely route write for conversation ${cascadeId}; owners=${owners.length}`);
    if (owners.length > 0) return owners[0];
    return this.instances[0];
  }

  async forWorkspace(workspaceUri) {
    await this.ensure();
    if (!workspaceUri) return this.instances[0];
    const needle = fileUriToPath(workspaceUri).toLowerCase();
    const exact = this.instances.find((instance) => (instance.workspaceUris || []).some((uri) => fileUriToPath(uri).toLowerCase() === needle));
    if (exact) return exact;
    const containing = this.instances.find((instance) => (instance.workspaceUris || []).some((uri) => {
      const current = fileUriToPath(uri).toLowerCase();
      return needle.startsWith(current) || current.startsWith(needle);
    }));
    return containing || this.instances.find((instance) => !instance.workspaceUris?.length) || this.instances[0];
  }
}
