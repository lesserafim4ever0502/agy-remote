import { createAgyClient } from '../packages/agy-ls/src/index.js';
import { redactInstance } from '../packages/agy-ls/src/utils.js';

const agy = createAgyClient();
const instances = await agy.router.refresh();
const output = [];
for (const instance of instances) {
  const item = { instance: redactInstance(instance), calls: {} };
  for (const [method, body] of [
    ['GetWorkspaceInfos', {}],
    ['GetAllCascadeTrajectories', { excludeSubtrajectories: false }],
    ['GetCascadeModelConfigData', {}],
    ['ListTerminals', { conversationId: '' }],
    ['ListPages', {}],
    ['GetMcpServerStates', {}],
  ]) {
    try {
      const value = await agy.transport.unary(instance, method, body);
      item.calls[method] = { ok: true, topLevelKeys: Object.keys(value || {}) };
    } catch (error) {
      item.calls[method] = { ok: false, error: error.message, statusCode: error.statusCode };
    }
  }
  output.push(item);
}
console.log(JSON.stringify(output, null, 2));
