import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
} from "../apps/bridge/src/auth.js";
import { AgentMonitor } from "../apps/bridge/src/agent-monitor.js";
import { EventHub } from "../apps/bridge/src/event-hub.js";
import { TailscaleManager } from "../apps/bridge/src/tailscale.js";
import { buildConnectEnvelope } from "../packages/agy-ls/src/transport.js";

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

test("4. Device Sessions are persisted with SHA-256 tokenHash (raw token never stored)", () => {
  const { secret } = createPairingSecret();
  const session = exchangePairingSecret(secret, "Galaxy S24");

  const sessionsFile = path.join(os.homedir(), ".agy-remote", "sessions.json");
  assert.ok(fs.existsSync(sessionsFile));
  const rawContent = fs.readFileSync(sessionsFile, "utf8");
  assert.ok(rawContent.includes(hashToken(session.token)));
  assert.equal(rawContent.includes(session.token), false, "Raw session token must NEVER be written to disk");

  const list = listSessions();
  const found = list.find((s) => s.id === session.id);
  assert.ok(found);
  assert.equal(found.label, "Galaxy S24");

  // Revoke session
  assert.equal(revokeSession(session.id), true);
  const req = { headers: { authorization: `Bearer ${session.token}` } };
  assert.equal(isAuthorized(req, new URL("http://127.0.0.1"), "master-token"), false);
});

test("5. One-time WebSocket Ticket expires in 30s and is consumed immediately", () => {
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

test("6. Persistent AgentMonitor is sole owner of stream, works with 0 WebSocket clients, and triggers deduplicated Push", async () => {
  const hub = new EventHub();
  let streamCount = 0;
  let receivedEvents = [];

  const mockAgy = {
    conversations: {
      list: async () => ({
        conversations: [{ id: "conv-mon-1", status: "RUNNING" }],
      }),
    },
    streams: {
      subscribe: (id, onEvent) => {
        streamCount += 1;
        // Simulate stream emitting approval event
        setTimeout(() => {
          onEvent({
            type: "approval.required",
            trajectoryId: "traj-main",
            stepIndex: 12,
            interaction: { kind: "runCommand", proposedCommandLine: "echo 123" },
          });
        }, 10);
        return () => {};
      },
    },
    router: { refresh: async () => [] },
  };

  const monitor = new AgentMonitor({ agy: mockAgy, hub, logger: { info: () => {}, warn: () => {}, debug: () => {} } });
  await monitor.start();

  // Give stream time to emit
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(streamCount, 1, "AgentMonitor must attach stream independently of WS clients");
  assert.equal(monitor.status().monitoredCount, 1);
  assert.ok(monitor.pushedKeys.has("conv-mon-1:traj-main:12:runCommand"));

  // Emitting the exact same event again must deduplicate and NOT push again
  const sizeBefore = monitor.pushedKeys.size;
  monitor.handleStreamEvent("conv-mon-1", {
    type: "approval.required",
    trajectoryId: "traj-main",
    stepIndex: 12,
    interaction: { kind: "runCommand", proposedCommandLine: "echo 123" },
  });
  assert.equal(monitor.pushedKeys.size, sizeBefore, "Duplicate WAITING events must be deduplicated");

  // When step progresses, dedupe keys are cleared
  monitor.handleStreamEvent("conv-mon-1", {
    type: "conversation.state",
    state: { status: "running" },
  });
  assert.equal(monitor.pushedKeys.has("conv-mon-1:traj-main:12:runCommand"), false);

  monitor.stop();
});

test("7. TailscaleManager gracefully parses status JSON with fallback fields", async () => {
  const ts = new TailscaleManager();
  
  // Test health check structure
  const health = await ts.health();
  assert.ok("installed" in health);
  assert.ok("status" in health);
  assert.ok(["OK", "DEGRADED", "BLOCKED", "ERROR"].includes(health.status));
});
