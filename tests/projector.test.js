import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStep } from '../packages/agy-ls/src/projector.js';

test('planner projection omits private thinking fields', () => {
  const events = projectStep({
    status: 'CORTEX_STEP_STATUS_GENERATING',
    plannerResponse: {
      response: 'visible',
      modifiedResponse: 'visible edited',
      thinking: 'must never leave bridge',
      rawThinking: 'also private',
    },
  }, 4);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant.message');
  assert.equal(events[0].text, 'visible edited');
  assert.equal('thinking' in events[0], false);
  assert.equal(JSON.stringify(events[0]).includes('must never leave bridge'), false);
});

test('file permission interaction becomes stable approval event', () => {
  const events = projectStep({
    status: 'CORTEX_STEP_STATUS_WAITING',
    requestedInteraction: {
      filePermission: {
        absolutePathUri: 'file:///tmp/a',
        isDirectory: false,
        blockReason: 'BLOCK_REASON_OUTSIDE_WORKSPACE',
      },
    },
  }, 9, { conversationId: 'c', trajectoryId: 't' });
  assert.deepEqual(events[0], {
    type: 'approval.required',
    stepIndex: 9,
    status: 'cortex_step_status_waiting',
    conversationId: 'c',
    trajectoryId: 't',
    interaction: {
      kind: 'filePermission',
      path: 'file:///tmp/a',
      isDirectory: false,
      reason: 'BLOCK_REASON_OUTSIDE_WORKSPACE',
    },
  });
});

test('subagent data is projected without raw step coupling', () => {
  const [event] = projectStep({ invokeSubagent: {
    subagentName: 'researcher',
    prompt: 'inspect docs',
    subagents: [{ role: 'Research', initialPrompt: 'inspect docs', modelTier: 'MODEL_TIER_FLASH' }],
    results: [{ conversationId: 'child-1', workspaceUris: ['file:///repo'] }],
  } }, 12);
  assert.equal(event.type, 'subagent.update');
  assert.equal(event.results[0].conversationId, 'child-1');
});
