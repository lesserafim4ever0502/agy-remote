const ALLOWED_SCOPES = new Set([
  'PERMISSION_SCOPE_UNSPECIFIED',
  'PERMISSION_SCOPE_ONCE',
  'PERMISSION_SCOPE_CONVERSATION',
  'PERMISSION_SCOPE_WORKSPACE',
  'PERMISSION_SCOPE_GLOBAL',
  'PERMISSION_SCOPE_PROJECT',
  'PERMISSION_SCOPE_SESSION',
  'PERMISSION_SCOPE_ALWAYS',
]);

export class InteractionService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
  }

  async respond(cascadeId, input) {
    const instance = await this.router.forConversation(cascadeId, { write: true });
    const interaction = {
      trajectoryId: input.trajectoryId,
      stepIndex: Number(input.stepIndex),
    };
    const kind = input.kind;

    if (kind === 'filePermission') {
      const scope = input.scope || 'PERMISSION_SCOPE_ONCE';
      if (!ALLOWED_SCOPES.has(scope)) throw new Error('Invalid permission scope');
      interaction.filePermission = {
        allow: !!input.allow,
        scope,
        absolutePathUri: String(input.absolutePathUri || ''),
      };
    } else if (kind === 'runCommand') {
      interaction.runCommand = {
        confirm: !!input.confirm,
        proposedCommandLine: input.proposedCommandLine || '',
        submittedCommandLine: input.submittedCommandLine || input.proposedCommandLine || '',
        sandboxOverride: !!input.sandboxOverride,
      };
    } else if (['browserAction', 'openBrowserUrl', 'executeBrowserJavascript', 'captureBrowserScreenshot', 'clickBrowserPixel', 'openBrowserSetup', 'confirmBrowserSetup', 'sendCommandInput', 'readUrlContent', 'mcp', 'approvalInteraction'].includes(kind)) {
      interaction[kind] = { confirm: !!input.confirm };
    } else if (kind === 'permission') {
      const scope = input.scope || 'PERMISSION_SCOPE_ONCE';
      if (!ALLOWED_SCOPES.has(scope)) throw new Error('Invalid permission scope');
      interaction.permission = {
        allow: !!input.allow,
        editedTarget: input.editedTarget || '',
        userDenyInstruction: input.userDenyInstruction || '',
        scope,
        sandboxOverride: !!input.sandboxOverride,
      };
    } else if (kind === 'askQuestion') {
      const formattedResponses = Array.isArray(input.responses)
        ? input.responses.map((r) => {
          if (typeof r === 'string') return { answers: [r] };
          if (Array.isArray(r?.answers)) return { answers: r.answers };
          if (r?.answer) return { answers: [String(r.answer)] };
          if (r?.text) return { answers: [String(r.text)] };
          return r || {};
        })
        : [];
      interaction.askQuestion = {
        responses: formattedResponses,
        cancelled: !!input.cancelled,
      };
    } else {
      throw new Error(`Unsupported interaction kind: ${kind}`);
    }

    await this.transport.unary(instance, 'HandleCascadeUserInteraction', { cascadeId, interaction });
    return { ok: true };
  }
}
