import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ConnectTransport } from '../packages/agy-ls/src/transport.js';
import { discoverLanguageServers } from '../packages/agy-ls/src/discovery.js';

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

test('manual discovery override probes GetWorkspaceInfos and rediscovers protocol', async (t) => {
  const csrf = 'manual-csrf';
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-codeium-csrf-token'], csrf);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ workspaceInfos: [{ workspaceUri: 'file:///manual' }], homeDirPath: '/home/test' }));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const old = { ...process.env };
  process.env.AGY_LS_PORT = String(port);
  process.env.AGY_LS_CSRF = csrf;
  process.env.AGY_LS_PROTOCOL = 'http';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  });

  const found = await discoverLanguageServers(new ConnectTransport({ timeoutMs: 1000 }), { logger: { debug() {} } });
  assert.equal(found.length, 1);
  assert.equal(found[0].workspaceUris[0], 'file:///manual');
  assert.equal(found[0].protocol, 'http');
});
