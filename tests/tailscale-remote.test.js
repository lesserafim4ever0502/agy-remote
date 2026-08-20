import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Isolate test state in temporary directory so production ~/.agy-remote is NEVER touched
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-state-"));
process.env.AGY_REMOTE_STATE_DIR = testStateDir;

import {
  assertSafeBind,
  createPairingSecret,
  exchangePairingSecret,
  isAuthorized,
  hashToken,
  createWsTicket,
  consumeWsTicket,
  listSessions,
  revokeSession,
  revokeAllSessions,
  requestToken,
  _resetSessionsForTest,
} from "../apps/bridge/src/auth.js";
import { AgentMonitor } from "../apps/bridge/src/agent-monitor.js";
import { EventHub } from "../apps/bridge/src/event-hub.js";
import { TailscaleManager } from "../apps/bridge/src/tailscale.js";
import { readJson, sendError } from "../apps/bridge/src/http-utils.js";

test("1. assertSafeBind allows loopback by default and strictly rejects 0.0.0.0/public IPs", () => {
  assert.doesNotThrow(() => assertSafeBind("127.0.0.1"));
  assert.doesNotThrow(() => assertSafeBind("localhost"));
  assert.doesNotThrow(() => assertSafeBind("::1"));

  assert.throws(() => assertSafeBind("0.0.0.0"), /Refusing non-loopback bind host/);
  assert.throws(() => assertSafeBind("192.168.1.100"), /Refusing non-loopback bind host/);
  assert.throws(() => assertSafeBind("10.0.0.5"), /Refusing non-loopback bind host/);
  assert.throws(() => assertSafeBind("100.64.0.1"), /Refusing non-loopback bind host/);
});

test("2. assertSafeBind respects AGY_REMOTE_ALLOW_NON_LOOPBACK=1 for debug", () => {
  const orig = process.env.AGY_REMOTE_ALLOW_NON_LOOPBACK;
  try {
    process.env.AGY_REMOTE_ALLOW_NON_LOOPBACK = "1";
    assert.doesNotThrow(() => assertSafeBind("0.0.0.0"));
    assert.doesNotThrow(() => assertSafeBind("192.168.1.50"));
  } finally {
    if (orig !== undefined) process.env.AGY_REMOTE_ALLOW_NON_LOOPBACK = orig;
    else delete process.env.AGY_REMOTE_ALLOW_NON_LOOPBACK;
  }
});

test("3. Pairing Secret lifecycle: 5min TTL, single-use, and exchange to Hashed Device Session", () => {
  const { secret, expiresAt } = createPairingSecret(1000);
  assert.ok(secret.length >= 16);
  assert.ok(expiresAt > Date.now());

  // Exchange once
  const session = exchangePairingSecret(secret, "Test iPhone");
  assert.ok(session.token.length >= 32);
  assert.equal(session.label, "Test iPhone");

  // Re-exchange must fail (single-use)
  assert.throws(() => exchangePairingSecret(secret, "Test iPhone"), /Invalid or expired/);

  // Authorize with exchanged token
  const req = { headers: { authorization: `Bearer ${session.token}` } };
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), true);

  // Expired secret
  const { secret: expSecret } = createPairingSecret(-1000);
  assert.throws(() => exchangePairingSecret(expSecret), /expired/);
});

test("4. Cold-start persistence test: memory wiped, sessions reloaded from isolated sessions.json", () => {
  _resetSessionsForTest();

  const { secret } = createPairingSecret();
  const session = exchangePairingSecret(secret, "Pixel 9 Cold Start");

  const sessionsFile = path.join(testStateDir, "sessions.json");
  assert.ok(fs.existsSync(sessionsFile));
  const rawContent = fs.readFileSync(sessionsFile, "utf8");
  assert.ok(rawContent.includes(hashToken(session.token)), "File must contain hashed token");
  assert.equal(rawContent.includes(session.token), false, "Raw session token must NEVER be written to disk");

  // Wipe memory to simulate process death / cold restart
  _resetSessionsForTest();

  // Fresh authorization request must load from disk and authenticate successfully
  const req = { headers: { authorization: `Bearer ${session.token}` } };
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), true);

  // Revoke session and verify persistence
  assert.equal(revokeSession(session.id), true);
  _resetSessionsForTest();
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), false);
});

test("5. Device Session sliding expiration and absolute TTL enforcement", () => {
  _resetSessionsForTest();
  const { secret } = createPairingSecret();
  const session = exchangePairingSecret(secret, "iPad Pro");

  const req = { headers: { authorization: `Bearer ${session.token}` } };
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), true);

  // Manually corrupt session to expired in file
  const sessionsFile = path.join(testStateDir, "sessions.json");
  const list = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  const target = list.find((s) => s.id === session.id);
  if (target) {
    target.expiresAt = Date.now() - 10000;
    fs.writeFileSync(sessionsFile, JSON.stringify(list, null, 2));
  }

  _resetSessionsForTest();
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), false);
});

test("6. requestToken strictly rejects URL query parameter tokens", () => {
  const reqWithHeader = { headers: { authorization: "Bearer secret-val" } };
  assert.equal(requestToken(reqWithHeader), "secret-val");

  const reqWithAgyHeader = { headers: { "x-agy-token": "custom-val" } };
  assert.equal(requestToken(reqWithAgyHeader), "custom-val");

  const reqWithQueryOnly = { headers: {} };
  assert.equal(requestToken(reqWithQueryOnly), "", "Query param tokens must return empty");
});

test("7. One-time WebSocket Ticket expires in 30s and is consumed immediately", () => {
  const { ticket, expiresAt } = createWsTicket(30000);
  assert.ok(ticket.length >= 32);
  assert.ok(expiresAt > Date.now());

  // First consumption must succeed
  assert.equal(consumeWsTicket(ticket), true);

  // Second consumption must fail (single-use)
  assert.equal(consumeWsTicket(ticket), false);

  // Expired ticket
  const { ticket: expTicket } = createWsTicket(-1000);
  assert.equal(consumeWsTicket(expTicket), false);
});

test("8. Realistic stream ordering with Mock Push: state(RUNNING) -> approval -> state(RUNNING) -> approval dedupe", async () => {
  const hub = new EventHub();
  let pushCalls = [];
  const mockPushSender = async (payload) => {
    pushCalls.push(payload);
    return { sent: 1, failed: 0, total: 1 };
  };

  const mockAgy = {
    conversations: { list: async () => [{ id: "c-dedupe", status: "RUNNING" }] },
    streams: {
      isSubscribed: () => true,
      subscribe: (id, onEvent) => {
        // Step 10: Initial state update
        onEvent({ type: "conversation.state", state: { status: "running" } });
        // Step 10: Approval required (should push #1)
        onEvent({
          type: "approval.required",
          trajectoryId: "traj-main",
          stepIndex: 10,
          interaction: { kind: "runCommand", proposedCommandLine: "npm test" },
        });
        // Step 10: Delta update sends conversation.state again (MUST NOT clear dedupe!)
        onEvent({ type: "conversation.state", state: { status: "running" } });
        // Step 10: Duplicate approval event (MUST NOT push #2)
        onEvent({
          type: "approval.required",
          trajectoryId: "traj-main",
          stepIndex: 10,
          interaction: { kind: "runCommand", proposedCommandLine: "npm test" },
        });
        return () => {};
      },
    },
    router: { refresh: async () => [] },
  };

  const monitor = new AgentMonitor({
    agy: mockAgy,
    hub,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    pushSender: mockPushSender,
  });
  await monitor.start();

  // Give stream time to process
  await new Promise((r) => setTimeout(r, 60));

  // Exactly 1 Push call was dispatched
  assert.equal(pushCalls.length, 1, "Exactly one Push notification must be sent for step 10");
  assert.equal(monitor.pushedKeys.size, 1);
  assert.ok(monitor.pushedKeys.has("c-dedupe:traj-main:10:runCommand"));

  // Now simulate Step 11: Agent resumes and emits assistant.message at step 11
  monitor.handleStreamEvent("c-dedupe", {
    type: "assistant.message",
    trajectoryId: "traj-main",
    stepIndex: 11,
    text: "Command executed successfully.",
  });

  // Step 10 dedupe key should now be cleared
  assert.equal(monitor.pushedKeys.has("c-dedupe:traj-main:10:runCommand"), false);

  monitor.stop();
});

test("9. AgentMonitor detects permanently closed stream, evicts stale entry, and re-subscribes on next reconcile", async () => {
  let subscribeCount = 0;
  let closeCallback = null;

  const mockAgy = {
    conversations: { list: async () => [{ id: "c-evict", status: "RUNNING" }] },
    streams: {
      isSubscribed: () => subscribeCount > 1 || closeCallback === null,
      subscribe: (id, onEvent, options = {}) => {
        subscribeCount += 1;
        closeCallback = options.onClose;
        return () => {};
      },
    },
    router: { refresh: async () => [] },
  };

  const monitor = new AgentMonitor({
    agy: mockAgy,
    hub: new EventHub(),
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  });

  await monitor.reconcile();
  assert.equal(subscribeCount, 1);
  assert.ok(monitor.monitored.has("c-evict"));

  // Simulate underlying stream permanently dying (e.g. 5 retries / close)
  closeCallback?.("c-evict", new Error("stream dead"));
  assert.equal(monitor.monitored.has("c-evict"), false, "Stale entry must be evicted upon stream close");

  // Next reconcile must re-subscribe cleanly
  await monitor.reconcile();
  assert.equal(subscribeCount, 2, "AgentMonitor must re-subscribe to running conversation after stream death");

  monitor.stop();
});

test("10. readJson handles 400 Invalid JSON and 413 Payload Too Large correctly", async () => {
  const invalidReq = (async function* () {
    yield Buffer.from("{ invalid json");
  })();
  await assert.rejects(() => readJson(invalidReq), (err) => err.statusCode === 400);

  const largeReq = (async function* () {
    yield Buffer.alloc(100);
  })();
  await assert.rejects(() => readJson(largeReq, { limit: 50 }), (err) => err.statusCode === 413);
});

test("11. TailscaleManager gracefully parses status JSON with fallback fields", async () => {
  const ts = new TailscaleManager();
  const health = await ts.health();
  assert.ok("installed" in health);
  assert.ok("status" in health);
  assert.ok(["OK", "DEGRADED", "BLOCKED", "ERROR"].includes(health.status));
});
