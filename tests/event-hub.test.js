import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../apps/bridge/src/event-hub.js';

function client() {
  return { subscriptions: new Set(), messages: [], sendJson(value) { this.messages.push(value); } };
}

test('event hub filters subscriptions and supports resume', () => {
  const hub = new EventHub({ maxEvents: 10 });
  const a = client();
  hub.addClient(a);
  hub.subscribe(a, 'conversation', 'c1');
  hub.publish('conversation', 'c1', { type: 'one' });
  hub.publish('conversation', 'c2', { type: 'two' });
  assert.equal(a.messages.length, 1);
  assert.equal(a.messages[0].event.type, 'one');

  const b = client();
  hub.addClient(b);
  hub.subscribe(b, 'conversation', 'c1');
  hub.resume(b, 0);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].seq, 1);
});
