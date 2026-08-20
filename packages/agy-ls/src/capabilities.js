export class CapabilityService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
    this.cached = null;
    this.cachedAt = 0;
    this.probePromise = null;
  }

  async probe({ maxAgeMs = 30000 } = {}) {
    if (this.cached && Date.now() - this.cachedAt < maxAgeMs) return this.cached;
    if (this.probePromise) return this.probePromise;

    this.probePromise = this.#probe();
    try {
      this.cached = await this.probePromise;
      this.cachedAt = Date.now();
      return this.cached;
    } finally {
      this.probePromise = null;
    }
  }

  async #probe() {
    await this.router.ensure();
    const instance = this.router.instances[0];
    const capabilities = {
      agentStream: true,
      conversations: true,
      models: false,
      integratedTerminal: false,
      browser: false,
      mcp: false,
      skills: false,
      subagents: true,
    };

    const harmless = async (method, body, key) => {
      try { await this.transport.unary(instance, method, body); capabilities[key] = true; }
      catch { capabilities[key] = false; }
    };
    await Promise.all([
      harmless('GetCascadeModelConfigData', {}, 'models'),
      harmless('ListTerminals', { conversationId: '' }, 'integratedTerminal'),
      harmless('ListPages', {}, 'browser'),
      harmless('GetMcpServerStates', {}, 'mcp'),
      harmless('GetAllSkills', {}, 'skills'),
    ]);
    return capabilities;
  }
}
