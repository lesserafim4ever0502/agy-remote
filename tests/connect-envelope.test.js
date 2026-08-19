import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectEnvelope, parseConnectEnvelopes } from '../packages/agy-ls/src/transport.js';

test('Connect envelope round-trips JSON', () => {
  const frame = buildConnectEnvelope({ hello: 'world', n: 3 });
  const parsed = parseConnectEnvelopes(frame);
  assert.equal(parsed.remaining.length, 0);
  assert.deepEqual(parsed.messages, [{ flags: 0, value: { hello: 'world', n: 3 } }]);
});

test('Connect parser keeps incomplete tail', () => {
  const a = buildConnectEnvelope({ a: 1 });
  const b = buildConnectEnvelope({ b: 2 });
  const joined = Buffer.concat([a, b.subarray(0, 4)]);
  const parsed = parseConnectEnvelopes(joined);
  assert.equal(parsed.messages.length, 1);
  assert.deepEqual(parsed.messages[0].value, { a: 1 });
  assert.equal(parsed.remaining.length, 4);
});
