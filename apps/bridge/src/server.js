import http from 'node:http';
import { createAgyClient } from '../../../packages/agy-ls/src/index.js';
import { redactInstance } from '../../../packages/agy-ls/src/utils.js';
import { DEFAULT_REMOTE_PORT } from '../../../packages/agy-ls/src/constants.js';
import { loadOrCreateToken, isAuthorized, assertSafeBind } from './auth.js';
import { EventHub } from './event-hub.js';
import { acceptWebSocket } from './websocket.js';
import { readJson, sendJson, sendError } from './http-utils.js';
import { serveStatic } from './static.js';

const host = process.env.AGY_REMOTE_HOST || '0.0.0.0';
const port = Number(process.env.AGY_REMOTE_PORT || DEFAULT_REMOTE_PORT);
assertSafeBind(host);

const auth = loadOrCreateToken();
const agy = createAgyClient({ logger: console });
const hub = new EventHub({ maxEvents: 2000 });
const watchers = new Map();
const clientResources = new WeakMap();

import {
  initWebPush,
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushNotification,
} from './push.js';

initWebPush();

function watcherKey(channel, resourceId) { return `${channel}:${resourceId}`; }

async function acquireWatcher(channel, resourceId) {
  const key = watcherKey(channel, resourceId);
  let watcher = watchers.get(key);
  if (watcher) { watcher.refs += 1; return watcher; }
  watcher = { channel, resourceId, refs: 1, stop: null, pending: true };
  watchers.set(key, watcher);

  try {
    if (channel === 'conversation') {
      watcher.stop = agy.streams.subscribe(resourceId, (event) => {
        hub.publish('conversation', resourceId, event);
        if (event.type === 'approval.required' || event.type === 'agent.question') {
          sendPushNotification({
            title: event.type === 'approval.required' ? 'Antigravity Approval Required' : 'Question from Agent',
            body: event.interaction?.kind ? `Action needed: ${event.interaction.kind}` : 'Agent is waiting for your response.',
            data: { conversationId: resourceId, url: `/#conv=${resourceId}` },
          }).catch((err) => console.warn('[Push]', err.message));
        }
      });
    } else if (channel === 'terminal') {
      const controller = await agy.terminals.stream(resourceId, {
        onMessage: (event) => hub.publish('terminal', resourceId, { type: 'terminal.output', ...event }),
        onError: (error) => hub.publish('terminal', resourceId, { type: 'error', message: error.message }),
        onEnd: () => hub.publish('terminal', resourceId, { type: 'terminal.end' }),
      });
      watcher.stop = () => controller?.abort?.();
    }
  } catch (error) {
    hub.publish(channel, resourceId, { type: 'error', message: error.message });
  } finally {
    watcher.pending = false;
  }
  return watcher;
}

function releaseWatcher(channel, resourceId) {
  const key = watcherKey(channel, resourceId);
  const watcher = watchers.get(key);
  if (!watcher) return;
  watcher.refs -= 1;
  if (watcher.refs <= 0) {
    try { watcher.stop?.(); } catch {}
    watchers.delete(key);
  }
}

async function handleWsMessage(message, client) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'resume') {
    hub.resume(client, message.lastSeq);
    return;
  }
  if (message.type === 'subscribe') {
    const channel = String(message.channel || '');
    const resourceId = String(message.resourceId || '');
    if (!['conversation', 'terminal'].includes(channel) || !resourceId) throw new Error('Invalid subscription');
    const resourceKey = watcherKey(channel, resourceId);
    const resources = clientResources.get(client) || new Set();
    if (!resources.has(resourceKey)) {
      resources.add(resourceKey);
      clientResources.set(client, resources);
      hub.subscribe(client, channel, resourceId);
      await acquireWatcher(channel, resourceId);
    }
    client.sendJson({ type: 'subscribed', channel, resourceId, currentSeq: hub.seq });
    return;
  }
  if (message.type === 'unsubscribe') {
    const channel = String(message.channel || '');
    const resourceId = String(message.resourceId || '');
    const resourceKey = watcherKey(channel, resourceId);
    const resources = clientResources.get(client);
    if (resources?.delete(resourceKey)) releaseWatcher(channel, resourceId);
    hub.unsubscribe(client, channel, resourceId);
    return;
  }
  if (message.type === 'ping') client.sendJson({ type: 'pong', currentSeq: hub.seq });
}

function cleanupClient(client) {
  hub.removeClient(client);
  const resources = clientResources.get(client) || new Set();
  for (const key of resources) {
    const split = key.indexOf(':');
    releaseWatcher(key.slice(0, split), key.slice(split + 1));
  }
  clientResources.delete(client);
}

async function api(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/v1/ping') return sendJson(res, 200, { name: 'agy-remote', version: '0.1.0-dev' });
  if (pathname === '/api/v1/health') return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
  
  if (method === 'POST' && pathname === '/api/v1/auth/pair') {
    const body = await readJson(req);
    const session = exchangePairingSecret(body.pairSecret, body.deviceLabel || req.headers['user-agent']);
    return sendJson(res, 200, session);
  }

  if (!isAuthorized(req, url, auth.token)) {
    return sendJson(res, 401, { error: 'unauthorized', message: 'Invalid or missing bearer token' });
  }

  if (method === 'GET' && pathname === '/api/v1/push/vapid-public-key') {
    return sendJson(res, 200, { publicKey: getVapidPublicKey() });
  }
  if (method === 'POST' && pathname === '/api/v1/push/subscribe') {
    const body = await readJson(req);
    return sendJson(res, 200, saveSubscription(body));
  }
  if (method === 'POST' && pathname === '/api/v1/push/unsubscribe') {
    const body = await readJson(req);
    return sendJson(res, 200, removeSubscription(body.endpoint));
  }
  if (method === 'POST' && pathname === '/api/v1/push/test') {
    const body = await readJson(req);
    return sendJson(res, 200, await sendPushNotification(body));
  }

  if (method === 'POST' && pathname === '/api/v1/auth/pair-secret') {
    return sendJson(res, 200, createPairingSecret());
  }
  if (method === 'GET' && pathname === '/api/v1/status') {
    const instances = await agy.router.refresh();
    const capabilities = await agy.capabilities.probe();
    return sendJson(res, 200, {
      ok: true,
      instances: instances.map(redactInstance),
      capabilities,
      eventSeq: hub.seq,
    });
  }

  if (method === 'GET' && pathname === '/api/v1/workspaces') {
    await agy.router.ensure();
    const values = [...new Set(agy.router.instances.flatMap((instance) => instance.workspaceUris || []))];
    return sendJson(res, 200, { workspaces: values });
  }

  if (method === 'GET' && pathname === '/api/v1/conversations') return sendJson(res, 200, { conversations: await agy.conversations.list() });
  if (method === 'POST' && pathname === '/api/v1/conversations') return sendJson(res, 201, await agy.conversations.create(await readJson(req)));
  if (method === 'GET' && pathname === '/api/v1/models') return sendJson(res, 200, { models: await agy.models.list() });
  if (method === 'GET' && pathname === '/api/v1/quota') return sendJson(res, 200, { quota: await agy.models.quota() });

  let match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
  if (match && method === 'GET') return sendJson(res, 200, await agy.conversations.snapshot(decodeURIComponent(match[1])));
  if (match && method === 'DELETE') return sendJson(res, 200, await agy.conversations.delete(decodeURIComponent(match[1])));

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (match && method === 'POST') return sendJson(res, 200, await agy.conversations.send(decodeURIComponent(match[1]), await readJson(req)));

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/stop$/);
  if (match && method === 'POST') return sendJson(res, 200, await agy.conversations.stop(decodeURIComponent(match[1])));

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/revert$/);
  if (match && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.conversations.revert(decodeURIComponent(match[1]), body.stepIndex, body));
  }

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/artifacts\/approve$/);
  if (match && method === 'POST') return sendJson(res, 200, await agy.conversations.approveArtifact(decodeURIComponent(match[1]), await readJson(req)));

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/artifacts\/reject$/);
  if (match && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.conversations.approveArtifact(decodeURIComponent(match[1]), { ...body, approved: false }));
  }

  match = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/interactions\/respond$/);
  if (match && method === 'POST') return sendJson(res, 200, await agy.interactions.respond(decodeURIComponent(match[1]), await readJson(req)));

  if (method === 'GET' && pathname === '/api/v1/terminals') {
    return sendJson(res, 200, { terminals: await agy.terminals.list(url.searchParams.get('conversationId') || '') });
  }
  if (method === 'POST' && pathname === '/api/v1/terminals') return sendJson(res, 201, await agy.terminals.create(await readJson(req)));
  match = pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/input$/);
  if (match && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.terminals.input(decodeURIComponent(match[1]), body.input || ''));
  }
  match = pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/resize$/);
  if (match && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.terminals.resize(decodeURIComponent(match[1]), body.cols, body.rows));
  }
  match = pathname.match(/^\/api\/v1\/terminals\/([^/]+)$/);
  if (match && method === 'DELETE') return sendJson(res, 200, await agy.terminals.close(decodeURIComponent(match[1]), url.searchParams.get('force') === '1'));

  if (method === 'GET' && pathname === '/api/v1/browser/pages') return sendJson(res, 200, { pages: await agy.browser.listPages() });
  if (method === 'POST' && pathname === '/api/v1/browser/open') {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.browser.open(body.url, body.isOnboarded ?? true));
  }
  match = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/focus$/);
  if (match && method === 'POST') return sendJson(res, 200, await agy.browser.focus(decodeURIComponent(match[1])));
  match = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/screenshot$/);
  if (match && method === 'GET') return sendJson(res, 200, await agy.browser.screenshot(decodeURIComponent(match[1])));
  match = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/console$/);
  if (match && method === 'GET') return sendJson(res, 200, await agy.browser.consoleLogs(decodeURIComponent(match[1])));

  sendJson(res, 404, { error: 'not_found', message: `${method} ${pathname}` });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (serveStatic(url.pathname, res)) return;
    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname !== '/api/v1/events' || !isAuthorized(req, url, auth.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    acceptWebSocket(req, socket, head, {
      onOpen(client) {
        hub.addClient(client);
        clientResources.set(client, new Set());
        client.sendJson({ type: 'ready', currentSeq: hub.seq });
      },
      onMessage(message, client) { handleWsMessage(message, client).catch((error) => client.sendJson({ type: 'error', message: error.message })); },
      onClose: cleanupClient,
      onError(error) { console.warn('[ws]', error.message); },
    });
  } catch (error) {
    console.warn('[ws upgrade]', error.message);
    socket.destroy();
  }
});

import os from 'node:os';
import { formatPairingTerminal } from './qr.js';
import { createPairingSecret, exchangePairingSecret } from './auth.js';

function getNetworkAddresses(port) {
  const nets = os.networkInterfaces();
  const addresses = [];
  let tailscaleIp = null;
  let lanIp = null;

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        const isTailscale = name.toLowerCase().includes('tailscale') || net.address.startsWith('100.');
        if (isTailscale && !tailscaleIp) tailscaleIp = net.address;
        else if (!lanIp) lanIp = net.address;
        addresses.push({ name, address: net.address, isTailscale });
      }
    }
  }
  const preferredIp = tailscaleIp || lanIp || host;
  return { addresses, preferredIp, tailscaleIp, lanIp };
}

server.listen(port, host, async () => {
  const isBackground = process.env.AGY_BACKGROUND === '1' || process.env.NODE_ENV === 'production';
  const { preferredIp, tailscaleIp, lanIp } = getNetworkAddresses(port);
  const localUrl = `http://127.0.0.1:${port}`;

  if (isBackground) {
    console.log(`[Bridge] Background daemon active on http://${preferredIp}:${port}`);
    console.log(`[Bridge] Local loopback: ${localUrl}`);
    if (tailscaleIp) console.log(`[Bridge] Tailscale: http://${tailscaleIp}:${port}`);
    console.log('[Bridge] Pairing secrets and QR code suppressed in daemon log mode.');
  } else {
    const pairing = createPairingSecret();
    const pairingUrl = `http://${preferredIp}:${port}/#pair=${pairing.secret}`;

    console.log('\n==================================================');
    console.log('   AGY REMOTE - MOBILE BRIDGE READY');
    console.log('==================================================');
    console.log(`Local Access:     ${localUrl}`);
    if (tailscaleIp) console.log(`Tailscale Access: http://${tailscaleIp}:${port}`);
    if (lanIp)       console.log(`LAN Access:       http://${lanIp}:${port}`);
    console.log(`One-Time Pairing: ${pairingUrl}\n`);

    try {
      const qr = await formatPairingTerminal(pairingUrl);
      if (qr) {
        console.log('Scan with your phone to pair (One-time secret):');
        console.log(qr);
        console.log('');
      }
    } catch {}
    console.log('==================================================\n');
  }

  try {
    const instances = await agy.router.refresh();
    console.log(`[Status] Connected to ${instances.length} Antigravity Language Server instance(s).`);
  } catch (error) {
    console.warn(`[Status] Antigravity discovery not ready: ${error.message}`);
  }
});
