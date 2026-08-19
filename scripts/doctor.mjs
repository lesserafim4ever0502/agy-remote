import { createAgyClient } from '../packages/agy-ls/src/index.js';
import { redactInstance } from '../packages/agy-ls/src/utils.js';
import { getApiKey } from '../packages/agy-ls/src/metadata.js';

const agy = createAgyClient();
console.log('Agy Remote doctor');
console.log(`platform=${process.platform} node=${process.version}`);
console.log(`apiKeyDiscovery=${getApiKey() ? 'found' : 'not-found (may still work for local-only RPCs)'}`);
try {
  const instances = await agy.router.refresh();
  console.log(JSON.stringify({ instances: instances.map(redactInstance) }, null, 2));
  const capabilities = await agy.capabilities.probe();
  console.log(JSON.stringify({ capabilities }, null, 2));
  const conversations = await agy.conversations.list();
  console.log(JSON.stringify({ conversationCount: conversations.length, sample: conversations.slice(0, 3) }, null, 2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
