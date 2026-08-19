import { createAgyClient } from '../packages/agy-ls/src/index.js';

const agy = createAgyClient();
const instances = await agy.router.refresh();
console.log(`reachable_language_servers=${instances.length}`);
const models = await agy.models.list().catch(() => []);
console.log(`models=${models.length}`);
const conversations = await agy.conversations.list();
console.log(`conversations=${conversations.length}`);
if (conversations[0]) {
  const snapshot = await agy.conversations.snapshot(conversations[0].id);
  console.log(`sample_events=${snapshot.events.length}`);
}
