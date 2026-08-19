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
  }

  async refresh() {
    this.instances = await discoverLanguageServers(this.transport, { logger: this.logger });
    if (this.instances.length === 0) throw new Error('No reachable Antigravity Language Server found');
    await this.refreshOwners();
    return this.instances;
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
