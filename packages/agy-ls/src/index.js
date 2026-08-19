import { ConnectTransport } from './transport.js';
import { AgyRouter } from './router.js';
import { ConversationService } from './conversations.js';
import { AgentStreamManager } from './agent-stream.js';
import { ModelService } from './models.js';
import { InteractionService } from './interactions.js';
import { TerminalService } from './terminal.js';
import { BrowserService } from './browser.js';
import { CapabilityService } from './capabilities.js';

export function createAgyClient({ logger = console } = {}) {
  const transport = new ConnectTransport({ logger });
  const router = new AgyRouter(transport, { logger });
  const models = new ModelService({ transport, router });
  return {
    transport,
    router,
    models,
    conversations: new ConversationService({ transport, router, logger, models }),
    streams: new AgentStreamManager({ transport, router, logger }),
    interactions: new InteractionService({ transport, router }),
    terminals: new TerminalService({ transport, router }),
    browser: new BrowserService({ transport, router }),
    capabilities: new CapabilityService({ transport, router }),
  };
}

export { buildConnectEnvelope, parseConnectEnvelopes, ConnectTransport, RpcError } from './transport.js';
export { mergeStepsUpdate } from './step-merger.js';
export { projectStep, projectSteps } from './projector.js';
export { discoverLanguageServers } from './discovery.js';
