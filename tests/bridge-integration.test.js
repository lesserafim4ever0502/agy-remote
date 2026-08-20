import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { buildConnectEnvelope } from "../packages/agy-ls/src/transport.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(url, options, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url, options);
      if (r.ok || r.status === 401) return r;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await wait(50);
  }
  throw last || new Error("poll failed");
}

test("bridge boots against a mock Language Server and exposes authenticated API & static PWA", async (t) => {
  const mock = http.createServer((req, res) => {
    const method = req.url.split("/").pop();
    if (method === "StreamAgentStateUpdates") {
      res.setHeader("content-type", "application/connect+json");
      const update = buildConnectEnvelope({
        update: {
          conversationId: "c1",
          trajectoryId: "t1",
          status: "CASCADE_RUN_STATUS_RUNNING",
          mainTrajectoryUpdate: {
            stepsUpdate: {
              indices: [0],
              totalLength: 1,
              steps: [
                {
                  status: "CORTEX_STEP_STATUS_GENERATING",
                  plannerResponse: { modifiedResponse: "stream-ok", thinking: "private" },
                },
              ],
            },
          },
        },
      });
      res.write(update);
      setTimeout(() => res.end(buildConnectEnvelope({ metadata: {} }, 0x02)), 150);
      return;
    }
    res.setHeader("content-type", "application/json");
    const responses = {
      GetWorkspaceInfos: { workspaceInfos: [{ workspaceUri: "file:///repo" }] },
      GetAllCascadeTrajectories: {
        trajectorySummaries: [
          {
            key: "c1",
            value: {
              summary: "Demo",
              stepCount: 2,
              status: "CASCADE_RUN_STATUS_IDLE",
              workspaces: [{ workspaceFolderAbsoluteUri: "file:///repo" }],
            },
          },
        ],
      },
      GetCascadeModelConfigData: {
        clientModelConfigs: [
          { label: "Demo Model", modelOrAlias: { model: "MODEL_DEMO" }, quotaInfo: { remainingFraction: 0.5 } },
        ],
      },
      ListTerminals: { terminals: [] },
      ListPages: { pages: [] },
      GetMcpServerStates: { states: [] },
      GetAllSkills: { skills: [] },
    };
    res.end(JSON.stringify(responses[method] || {}));
  });
  const lsPort = await listen(mock);
  t.after(() => mock.close());

  const bridgePort = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["apps/bridge/src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      AGY_REMOTE_TOKEN: "integration-token",
      AGY_REMOTE_HOST: "127.0.0.1",
      AGY_REMOTE_PORT: String(bridgePort),
      AGY_LS_PORT: String(lsPort),
      AGY_LS_CSRF: "csrf",
      AGY_LS_PROTOCOL: "http",
      AGY_DISCOVERY_PROCESS_SCAN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  t.after(() => child.kill());

  // 1. Static PWA Servicing Check
  const homeResp = await poll(`http://127.0.0.1:${bridgePort}/`);
  assert.equal(homeResp.status, 200);
  assert.ok((await homeResp.text()).includes("Agy Remote"));

  const appJsResp = await fetch(`http://127.0.0.1:${bridgePort}/app.js`);
  assert.equal(appJsResp.status, 200);
  assert.ok((await appJsResp.text()).includes("renderMarkdown"));

  const cssResp = await fetch(`http://127.0.0.1:${bridgePort}/styles.css`);
  assert.equal(cssResp.status, 200);

  const ping = await poll(`http://127.0.0.1:${bridgePort}/api/v1/ping`);
  assert.equal((await ping.json()).name, "agy-remote");

  // 2. Auth & Legacy Query Rejection
  const unauthorized = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/conversations`);
  assert.equal(unauthorized.status, 401);

  const queryTokenAttempt = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/conversations?token=integration-token`);
  assert.equal(queryTokenAttempt.status, 401, "Query parameter tokens must be strictly rejected");

  const headers = { Authorization: "Bearer integration-token" };
  const status = await poll(`http://127.0.0.1:${bridgePort}/api/v1/status`, { headers });
  const statusJson = await status.json();
  assert.equal(statusJson.instances.length, 1, stderr);
  assert.equal(statusJson.capabilities.integratedTerminal, true);

  // 3. Workspaces & Quota Endpoints
  const workspacesResp = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/workspaces`, { headers });
  const workspacesJson = await workspacesResp.json();
  assert.deepEqual(workspacesJson.workspaces, ["file:///repo"]);

  const quotaResp = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/quota`, { headers });
  assert.equal(quotaResp.status, 200);

  const conversations = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/conversations`, { headers });
  const body = await conversations.json();
  assert.equal(body.conversations[0].id, "c1");
  assert.equal(body.conversations[0].title, "Demo");
  assert.equal(body.meta.stale, false);

  // 4. WebSocket with One-Time Ticket
  const ticketResp = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/auth/ws-ticket`, {
    method: "POST",
    headers,
  });
  const { ticket } = await ticketResp.json();
  assert.ok(ticket);

  const streamedEvent = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/api/v1/events?ticket=${ticket}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket stream timeout"));
    }, 3000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "subscribe", channel: "conversation", resourceId: "c1" }))
    );
    ws.addEventListener("message", (message) => {
      const value = JSON.parse(String(message.data));
      if (value.channel === "conversation" && value.event?.type === "assistant.message") {
        clearTimeout(timer);
        ws.close();
        resolve(value.event);
      }
    });
    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${err.message}`));
    });
  });
  assert.equal(streamedEvent.text, "stream-ok");
  assert.equal(JSON.stringify(streamedEvent).includes("private"), false);
});
