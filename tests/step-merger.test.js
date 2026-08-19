import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStepsUpdate } from '../packages/agy-ls/src/step-merger.js';

test('index delta replaces in place and grows to totalLength', () => {
  const start = [{ id: 0 }, { id: 1 }];
  const next = mergeStepsUpdate(start, { indices: [1, 3], steps: [{ id: 'one' }, { id: 'three' }], totalLength: 4 });
  assert.equal(next.length, 4);
  assert.deepEqual(next[0], { id: 0 });
  assert.deepEqual(next[1], { id: 'one' });
  assert.deepEqual(next[3], { id: 'three' });
});

test('full replace works without indices', () => {
  const next = mergeStepsUpdate([{ id: 0 }], { steps: [{ id: 1 }, { id: 2 }], totalLength: 2 });
  assert.deepEqual(next, [{ id: 1 }, { id: 2 }]);
});
