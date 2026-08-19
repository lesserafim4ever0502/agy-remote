import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ConnectTransport, buildConnectEnvelope } from '../packages/agy-ls/src/transport.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('ConnectTransport performs unary JSON and server streaming', async (t) => {
  const csrf = 'test-csrf';
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-codeium-csrf-token'], csrf);
    if (req.url.endsWith('/GetWorkspaceInfos')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ workspaceInfos: [{ workspaceUri: 'file:///demo' }] }));
      return;
    }
    if (req.url.endsWith('/StreamAgentStateUpdates')) {
      res.setHeader('content-type', 'application/connect+json');
      const frame = buildConnectEnvelope({ update: { conversationId: 'c1', status: 'CASCADE_RUN_STATUS_RUNNING' } });
      const end = buildConnectEnvelope({ metadata: {} }, 0x02);
      res.write(frame.subarray(0, 3));
      setTimeout(() => { res.write(frame.subarray(3)); res.end(end); }, 10);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  const transport = new ConnectTransport({ timeoutMs: 1000 });
  const instance = { host: '127.0.0.1', port, protocol: 'http', csrfToken: csrf };
  const unary = await transport.unary(instance, 'GetWorkspaceInfos', {});
  assert.equal(unary.workspaceInfos[0].workspaceUri, 'file:///demo');

  const streamed = await new Promise((resolve, reject) => {
    const seen = [];
    const controller = transport.stream(instance, 'StreamAgentStateUpdates', { conversationId: 'c1', subscriberId: 's1' }, {
      onMessage(value) { seen.push(value); },
      onError: reject,
      onEnd() { controller.abort(); resolve(seen); },
    });
  });
  assert.equal(streamed[0].update.conversationId, 'c1');
});
