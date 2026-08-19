export class TerminalService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
    this.terminalOwners = new Map();
  }

  async list(conversationId = '') {
    const instance = conversationId
      ? await this.router.forConversation(conversationId)
      : (await this.router.ensure(), this.router.instances[0]);
    const response = await this.transport.unary(instance, 'ListTerminals', { conversationId });
    const terminals = response.terminals || [];
    for (const terminal of terminals) if (terminal.terminalId) this.terminalOwners.set(terminal.terminalId, instance);
    return terminals;
  }

  async create({ workspaceUri, conversationId = '' }) {
    const instance = conversationId
      ? await this.router.forConversation(conversationId, { write: true })
      : await this.router.forWorkspace(workspaceUri);
    const response = await this.transport.unary(instance, 'CreateTerminal', { workspaceUri, conversationId });
    const terminal = response.terminal || response;
    if (terminal.terminalId) this.terminalOwners.set(terminal.terminalId, instance);
    return terminal;
  }

  async owner(terminalId) {
    const cached = this.terminalOwners.get(terminalId);
    if (cached) return cached;
    await this.router.ensure();
    for (const instance of this.router.instances) {
      try {
        const response = await this.transport.unary(instance, 'ListTerminals', { conversationId: '' });
        if ((response.terminals || []).some((terminal) => terminal.terminalId === terminalId)) {
          this.terminalOwners.set(terminalId, instance);
          return instance;
        }
      } catch {}
    }
    throw new Error(`Terminal ${terminalId} not found`);
  }

  async input(terminalId, input, inputStreamId = terminalId) {
    const instance = await this.owner(terminalId);
    const encoded = Buffer.from(String(input), 'utf8').toString('base64');
    return this.transport.unary(instance, 'SendTerminalInput', {
      terminalId,
      inputStreamId: inputStreamId || terminalId,
      input: encoded,
    });
  }

  async resize(terminalId, cols, rows, inputStreamId = terminalId) {
    const instance = await this.owner(terminalId);
    return this.transport.unary(instance, 'SendTerminalInput', {
      terminalId,
      inputStreamId: inputStreamId || terminalId,
      resize: { cols: Number(cols), rows: Number(rows) },
    });
  }

  async close(terminalId, force = false) {
    const instance = await this.owner(terminalId);
    await this.transport.unary(instance, 'CloseTerminal', { terminalId, force: !!force });
    this.terminalOwners.delete(terminalId);
    return { ok: true };
  }

  async stream(terminalId, handlers = {}) {
    const instance = await this.owner(terminalId);
    return this.transport.stream(instance, 'StreamTerminalOutput', { terminalId }, {
      onOpen: handlers.onOpen,
      onError: handlers.onError,
      onEnd: handlers.onEnd,
      onMessage: (message) => {
        const event = { terminalId };
        if (message.output !== undefined) {
          try { event.output = Buffer.from(message.output, 'base64').toString('utf8'); }
          catch { event.output = String(message.output); }
        }
        if (message.exitCode !== undefined) event.exitCode = message.exitCode;
        if (message.title !== undefined) event.title = message.title;
        handlers.onMessage?.(event);
      },
    });
  }
}
