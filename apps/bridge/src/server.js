import http from "node:http";
import { createAgyClient } from "../../../packages/agy-ls/src/index.js";
import { redactInstance } from "../../../packages/agy-ls/src/utils.js";
import { DEFAULT_REMOTE_PORT } from "../../../packages/agy-ls/src/constants.js";
import {
  loadOrCreateToken,
  isAuthorized,
  assertSafeBind,
  createPairingSecret,
  exchangePairingSecret,
  listSessions,
  revokeSession,
  revokeAllSessions,
  createWsTicket,
  consumeWsTicket,
} from "./auth.js";
import { EventHub } from "./event-hub.js";
import { acceptWebSocket } from "./websocket.js";
import { readJson, sendJson, sendError } from "./http-utils.js";
import { serveStatic } from "./static.js";
import {
  initWebPush,
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushNotification,
} from "./push.js";
import { AgentMonitor } from "./agent-monitor.js";
import { TailscaleManager } from "./tailscale.js";
import { formatPairingTerminal } from "./qr.js";

const host = process.env.AGY_REMOTE_HOST || "127.0.0.1";
const port = Number(process.env.AGY_REMOTE_PORT || DEFAULT_REMOTE_PORT);
assertSafeBind(host);

const auth = loadOrCreateToken();
const agy = createAgyClient({ logger: console });
const hub = new EventHub({ maxEvents: 2000 });
const ts = new TailscaleManager();
const terminalWatchers = new Map();
const clientResources = new WeakMap();

initWebPush();

// Persistent Agent Monitor: Sole Owner of Conversation Streams
const monitor = new AgentMonitor({ agy, hub, logger: console });
monitor.start().catch((err) => console.warn("[Bridge] AgentMonitor initial error:", err.message));

async function acquireTerminalWatcher(terminalId) {
  let watcher = terminalWatchers.get(terminalId);
  if (watcher) { watcher.refs += 1; return watcher; }
  watcher = { terminalId, refs: 1, stop: null, pending: true };
  terminalWatchers.set(terminalId, watcher);

  try {
    const controller = await agy.terminals.stream(terminalId, {
      onMessage: (event) => hub.publish("terminal", terminalId, { type: "terminal.output", ...event }),
      onError: (error) => hub.publish("terminal", terminalId, { type: "error", message: error.message }),
      onEnd: () => hub.publish("terminal", terminalId, { type: "terminal.end" }),
    });
    watcher.stop = () => controller?.abort?.();
  } catch (error) {
    hub.publish("terminal", terminalId, { type: "error", message: error.message });
  } finally {
    watcher.pending = false;
  }
  return watcher;
}

function releaseTerminalWatcher(terminalId) {
  const watcher = terminalWatchers.get(terminalId);
  if (!watcher) return;
  watcher.refs -= 1;
  if (watcher.refs <= 0) {
    terminalWatchers.delete(terminalId);
    try { watcher.stop?.(); } catch {}
  }
}

function cleanupClient(client) {
  hub.removeClient(client);
  const resources = clientResources.get(client);
  if (!resources) return;
  for (const item of resources) {
    if (item.channel === "terminal") {
      releaseTerminalWatcher(item.resourceId);
    }
  }
  clientResources.delete(client);
}

async function handleWsMessage(message, client) {
  if (!message || typeof message !== "object") return;
  if (message.type === "subscribe") {
    const { channel, resourceId } = message;
    if (!channel || !resourceId) return;

    hub.subscribe(client, channel, resourceId);
    const set = clientResources.get(client);
    set?.add({ channel, resourceId });

    if (channel === "terminal") {
      await acquireTerminalWatcher(resourceId);
    } else if (channel === "conversation") {
      monitor.ensureMonitored(resourceId);
    }
  } else if (message.type === "unsubscribe") {
    const { channel, resourceId } = message;
    hub.unsubscribe(client, channel, resourceId);
    const set = clientResources.get(client);
    if (set) {
      for (const item of set) {
        if (item.channel === channel && item.resourceId === resourceId) {
          set.delete(item);
          if (channel === "terminal") releaseTerminalWatcher(resourceId);
        }
      }
    }
  } else if (message.type === "resume") {
    hub.resume(client, message.lastSeq);
  }
}

async function api(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (pathname === "/api/v1/ping") return sendJson(res, 200, { name: "agy-remote", version: "0.1.0-dev" });
  if (pathname === "/api/v1/health") return sendJson(res, 200, { ok: true, now: new Date().toISOString() });

  // Public Pairing Exchange Endpoint (Single-use secret -> Hashed Device Session)
  if (method === "POST" && pathname === "/api/v1/auth/pair") {
    const body = await readJson(req);
    const session = exchangePairingSecret(body.pairSecret, body.deviceLabel || req.headers["user-agent"]);
    return sendJson(res, 200, session);
  }

  // All endpoints below require Bearer Authorization (Master Token or Hashed Device Session)
  if (!isAuthorized(req, url, auth.token)) {
    return sendJson(res, 401, { error: "unauthorized", message: "Invalid or missing bearer token" });
  }

  // Auth & Session Management API
  if (method === "POST" && pathname === "/api/v1/auth/pair-secret") {
    return sendJson(res, 200, createPairingSecret());
  }
  if (method === "POST" && pathname === "/api/v1/auth/ws-ticket") {
    return sendJson(res, 200, createWsTicket());
  }
  if (method === "GET" && pathname === "/api/v1/auth/devices") {
    return sendJson(res, 200, { devices: listSessions() });
  }
  if (method === "POST" && pathname === "/api/v1/auth/devices/revoke") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: revokeSession(body.id) });
  }
  if (method === "POST" && pathname === "/api/v1/auth/devices/revoke-all") {
    return sendJson(res, 200, revokeAllSessions());
  }

  // Web Push Endpoints
  if (method === "GET" && pathname === "/api/v1/push/vapid-public-key") {
    return sendJson(res, 200, { publicKey: getVapidPublicKey() });
  }
  if (method === "POST" && pathname === "/api/v1/push/subscribe") {
    const body = await readJson(req);
    return sendJson(res, 200, saveSubscription(body));
  }
  if (method === "POST" && pathname === "/api/v1/push/unsubscribe") {
    const body = await readJson(req);
    return sendJson(res, 200, removeSubscription(body.endpoint));
  }
  if (method === "POST" && pathname === "/api/v1/push/test") {
    const body = await readJson(req);
    return sendJson(res, 200, await sendPushNotification(body));
  }

  // Status & Health
  if (method === "GET" && pathname === "/api/v1/status") {
    const instances = await agy.router.refresh();
    const capabilities = await agy.capabilities.probe();
    const tsHealth = await ts.health();
    return sendJson(res, 200, {
      ok: true,
      instances: instances.map(redactInstance),
      capabilities,
      eventSeq: hub.seq,
      agentMonitor: monitor.status(),
      tailscale: tsHealth,
    });
  }

  if (method === "GET" && pathname === "/api/v1/workspaces") {
    await agy.router.ensure();
    const workspaces = [
      ...new Set(
        agy.router.instances.flatMap((instance) => instance.workspaceUris || [])
      ),
    ];
    return sendJson(res, 200, { workspaces });
  }
  if (method === "GET" && pathname === "/api/v1/models") {
    return sendJson(res, 200, { models: await agy.models.list() });
  }
  if (method === "GET" && pathname === "/api/v1/quota") {
    return sendJson(res, 200, { quota: await agy.models.quota() });
  }

  // Conversations
  if (method === "GET" && pathname === "/api/v1/conversations") {
    return sendJson(res, 200, { conversations: await agy.conversations.list() });
  }
  if (method === "POST" && pathname === "/api/v1/conversations") {
    const body = await readJson(req);
    const created = await agy.conversations.create(body);
    monitor.ensureMonitored(created.cascadeId);
    return sendJson(res, 200, created);
  }

  const convMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
  if (convMatch && method === "GET") {
    const cascadeId = decodeURIComponent(convMatch[1]);
    monitor.ensureMonitored(cascadeId);
    return sendJson(res, 200, await agy.conversations.snapshot(cascadeId));
  }
  if (convMatch && method === "DELETE") {
    const cascadeId = decodeURIComponent(convMatch[1]);
    return sendJson(res, 200, await agy.conversations.delete(cascadeId));
  }

  const msgMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (msgMatch && method === "POST") {
    const cascadeId = decodeURIComponent(msgMatch[1]);
    const body = await readJson(req);
    monitor.ensureMonitored(cascadeId);
    return sendJson(res, 200, await agy.conversations.send(cascadeId, body));
  }

  const stopMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const cascadeId = decodeURIComponent(stopMatch[1]);
    return sendJson(res, 200, await agy.conversations.stop(cascadeId));
  }

  const revertMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/revert$/);
  if (revertMatch && method === "POST") {
    const cascadeId = decodeURIComponent(revertMatch[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.conversations.revert(cascadeId, body.stepIndex, body));
  }

  const interactMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/interactions\/respond$/);
  if (interactMatch && method === "POST") {
    const cascadeId = decodeURIComponent(interactMatch[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.interactions.respond(cascadeId, body));
  }

  const artApproveMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/artifacts\/approve$/);
  if (artApproveMatch && method === "POST") {
    const cascadeId = decodeURIComponent(artApproveMatch[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.conversations.approveArtifact(cascadeId, body));
  }

  const artRejectMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/artifacts\/reject$/);
  if (artRejectMatch && method === "POST") {
    const cascadeId = decodeURIComponent(artRejectMatch[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.conversations.approveArtifact(cascadeId, { ...body, approved: false }));
  }

  // Terminals
  if (method === "GET" && pathname === "/api/v1/terminals") {
    return sendJson(res, 200, { terminals: await agy.terminals.list(url.searchParams.get("conversationId") || "") });
  }
  if (method === "POST" && pathname === "/api/v1/terminals") {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.terminals.create(body));
  }

  const termInput = pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/input$/);
  if (termInput && method === "POST") {
    const terminalId = decodeURIComponent(termInput[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.terminals.input(terminalId, body.input));
  }

  const termResize = pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/resize$/);
  if (termResize && method === "POST") {
    const terminalId = decodeURIComponent(termResize[1]);
    const body = await readJson(req);
    return sendJson(res, 200, await agy.terminals.resize(terminalId, body.cols, body.rows));
  }

  const termDelete = pathname.match(/^\/api\/v1\/terminals\/([^/]+)$/);
  if (termDelete && method === "DELETE") {
    const terminalId = decodeURIComponent(termDelete[1]);
    return sendJson(res, 200, await agy.terminals.close(terminalId, url.searchParams.get("force") === "1"));
  }

  // Browser
  if (method === "GET" && pathname === "/api/v1/browser/pages") {
    return sendJson(res, 200, { pages: await agy.browser.listPages() });
  }
  if (method === "POST" && pathname === "/api/v1/browser/open") {
    const body = await readJson(req);
    return sendJson(res, 200, await agy.browser.open(body.url));
  }

  const pageFocus = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/focus$/);
  if (pageFocus && method === "POST") {
    const pageId = decodeURIComponent(pageFocus[1]);
    return sendJson(res, 200, await agy.browser.focus(pageId));
  }

  const pageShot = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/screenshot$/);
  if (pageShot && method === "GET") {
    const pageId = decodeURIComponent(pageShot[1]);
    return sendJson(res, 200, await agy.browser.screenshot(pageId));
  }

  const pageConsole = pathname.match(/^\/api\/v1\/browser\/pages\/([^/]+)\/console$/);
  if (pageConsole && method === "GET") {
    const pageId = decodeURIComponent(pageConsole[1]);
    return sendJson(res, 200, { logs: await agy.browser.consoleLogs(pageId) });
  }

  return sendJson(res, 404, { error: "not_found", message: `Not Found: ${method} ${pathname}` });
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) {
      return await api(req, res, url);
    }
    if (serveStatic(url.pathname, res)) return;
    return sendJson(res, 404, { error: "not_found", message: `Static file not found: ${url.pathname}` });
  } catch (error) {
    sendError(res, error);
  }
});

// WebSocket Server (STRICTLY One-Time WS Ticket ONLY)
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/api/v1/events") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // STRICT: Only one-time WS Ticket is accepted
    const ticket = url.searchParams.get("ticket");
    const ticketValid = ticket ? consumeWsTicket(ticket) : false;

    if (!ticketValid) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    acceptWebSocket(req, socket, head, {
      onOpen(client) {
        hub.addClient(client);
        clientResources.set(client, new Set());
        client.sendJson({ type: "ready", currentSeq: hub.seq });
      },
      onMessage(message, client) {
        handleWsMessage(message, client).catch((error) =>
          client.sendJson({ type: "error", message: error.message })
        );
      },
      onClose: cleanupClient,
      onError(error) {
        console.warn("[ws error]", error.message);
      },
    });
  } catch (error) {
    console.warn("[ws upgrade error]", error.message);
    socket.destroy();
  }
});

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  server.listen(port, host, async () => {
    const isBg = process.env.AGY_BACKGROUND === "1";
    if (isBg) {
      console.log(`[Bridge] Background daemon active on http://${host}:${port}`);
      console.log(`[Bridge] Pairing secrets and QR code suppressed in daemon log mode.`);
      return;
    }

    const { secret } = createPairingSecret();
    const tsHealth = await ts.health();
    const remoteUrl = tsHealth.httpsUrl
      ? `${tsHealth.httpsUrl}/#pair=${secret}`
      : `http://127.0.0.1:${port}/#pair=${secret}`;

    console.log(`\n==================================================`);
    console.log(`   AGY REMOTE - LOCALHOST BRIDGE READY`);
    console.log(`==================================================`);
    console.log(`Local Access:     http://127.0.0.1:${port}`);
    if (tsHealth.httpsUrl) {
      console.log(`Tailscale HTTPS:  ${tsHealth.httpsUrl}`);
    }
    console.log(`Pairing URL:      ${remoteUrl}`);
    console.log(`\nScan with your phone to pair (One-time secret):`);
    try {
      console.log(await formatPairingTerminal(remoteUrl));
    } catch {}
    console.log(`\n==================================================\n`);
  });
}
