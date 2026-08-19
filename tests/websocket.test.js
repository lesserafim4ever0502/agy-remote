import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrames } from '../apps/bridge/src/websocket.js';

test('minimal websocket encoder/decoder handles server text frames', () => {
  const frame = encodeFrame('{"ok":true}');
  const parsed = decodeFrames(frame);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].opcode, 1);
  assert.equal(parsed.frames[0].payload.toString('utf8'), '{"ok":true}');
});

test('minimal websocket decoder handles masked client text frames', () => {
  const payload = Buffer.from('{"type":"ping"}');
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ mask[i % 4];
  const parsed = decodeFrames(frame);
  assert.equal(parsed.frames[0].payload.toString('utf8'), '{"type":"ping"}');
});
