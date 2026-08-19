export class CapabilityService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
  }

  async probe() {
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
