import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadata, buildCascadeConfig } from "../packages/agy-ls/src/metadata.js";
import { DEFAULT_IDE_VERSION, DEFAULT_MODEL } from "../packages/agy-ls/src/constants.js";
import { InteractionService } from "../packages/agy-ls/src/interactions.js";
import { ConversationService } from "../packages/agy-ls/src/conversations.js";
import { TerminalService } from "../packages/agy-ls/src/terminal.js";
import { BrowserService } from "../packages/agy-ls/src/browser.js";

test("1. metadata uses dynamic IDE version and falls back to default", () => {
  const dynamic = buildMetadata({ ideVersion: "2.8.1" });
  assert.equal(dynamic.ideVersion, "2.8.1");

  const strTarget = buildMetadata("2.8.1-custom");
  assert.equal(strTarget.ideVersion, "2.8.1-custom");

  const fallback = buildMetadata({});
  assert.equal(fallback.ideVersion, DEFAULT_IDE_VERSION);
});

test("2. buildCascadeConfig resolves requestedModel to default or custom", () => {
  const cfgDefault = buildCascadeConfig();
  assert.equal(cfgDefault.plannerConfig.requestedModel.model, DEFAULT_MODEL);

  const cfgCustom = buildCascadeConfig({ model: "MODEL_CUSTOM" });
  assert.equal(cfgCustom.plannerConfig.requestedModel.model, "MODEL_CUSTOM");
});

test("3. SendUserCascadeMessage formats message items and requested model", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http", csrfToken: "test" }),
  };
  const service = new ConversationService({ transport: mockTransport, router: mockRouter });

  await service.send("conv-1", { text: "hello world", model: "MODEL_PLACEHOLDER_M71" });
  assert.equal(captured.method, "SendUserCascadeMessage");
  assert.equal(captured.body.cascadeId, "conv-1");
  assert.deepEqual(captured.body.items, [{ text: "hello world" }]);
  assert.equal(captured.body.cascadeConfig.plannerConfig.requestedModel.model, "MODEL_PLACEHOLDER_M71");
});

test("4. command approval generates confirm and submittedCommandLine payload", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const interactions = new InteractionService({ transport: mockTransport, router: mockRouter });

  await interactions.respond("conv-1", {
    trajectoryId: "traj-1",
    stepIndex: 3,
    kind: "runCommand",
    confirm: true,
    proposedCommandLine: "echo one",
    submittedCommandLine: "echo one",
  });

  assert.equal(captured.method, "HandleCascadeUserInteraction");
  assert.deepEqual(captured.body.interaction.runCommand, {
    confirm: true,
    proposedCommandLine: "echo one",
    submittedCommandLine: "echo one",
    sandboxOverride: false,
  });
});

test("5. edited command approval forwards custom submittedCommandLine", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const interactions = new InteractionService({ transport: mockTransport, router: mockRouter });

  await interactions.respond("conv-1", {
    trajectoryId: "traj-1",
    stepIndex: 3,
    kind: "runCommand",
    confirm: true,
    proposedCommandLine: "echo one",
    submittedCommandLine: "echo two",
  });

  assert.equal(captured.body.interaction.runCommand.proposedCommandLine, "echo one");
  assert.equal(captured.body.interaction.runCommand.submittedCommandLine, "echo two");
});

test("6. file permission scope mapping validates known scopes", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const interactions = new InteractionService({ transport: mockTransport, router: mockRouter });

  const validScopes = [
    "PERMISSION_SCOPE_UNSPECIFIED",
    "PERMISSION_SCOPE_ONCE",
    "PERMISSION_SCOPE_CONVERSATION",
    "PERMISSION_SCOPE_WORKSPACE",
    "PERMISSION_SCOPE_GLOBAL",
    "PERMISSION_SCOPE_PROJECT",
    "PERMISSION_SCOPE_SESSION",
    "PERMISSION_SCOPE_ALWAYS",
  ];

  for (const scope of validScopes) {
    await interactions.respond("conv-1", {
      trajectoryId: "traj-1",
      stepIndex: 1,
      kind: "filePermission",
      allow: true,
      scope,
      absolutePathUri: "file:///C:/test/file.txt",
    });
    assert.equal(captured.body.interaction.filePermission.scope, scope);
  }

  await assert.rejects(async () => {
    await interactions.respond("conv-1", {
      trajectoryId: "traj-1",
      stepIndex: 1,
      kind: "filePermission",
      scope: "INVALID_SCOPE",
    });
  }, /Invalid permission scope/);
});

test("7. askQuestion normalizes structured responses and cancellation", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const interactions = new InteractionService({ transport: mockTransport, router: mockRouter });

  await interactions.respond("conv-1", {
    trajectoryId: "traj-1",
    stepIndex: 5,
    kind: "askQuestion",
    responses: ["Option A", { answers: ["Option B", "Option C"] }],
    cancelled: false,
  });

  assert.deepEqual(captured.body.interaction.askQuestion.responses, [
    { answers: ["Option A"] },
    { answers: ["Option B", "Option C"] },
  ]);
  assert.equal(captured.body.interaction.askQuestion.cancelled, false);
});

test("8. artifact approval sends ARTIFACT_APPROVAL_STATUS_APPROVED", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const service = new ConversationService({ transport: mockTransport, router: mockRouter });

  await service.approveArtifact("conv-1", {
    artifactUri: "file:///C:/test/file.md",
    approved: true,
  });

  assert.equal(captured.method, "SendUserCascadeMessage");
  assert.equal(captured.body.artifactComments[0].approvalStatus, "ARTIFACT_APPROVAL_STATUS_APPROVED");
});

test("9. artifact rejection sends ARTIFACT_APPROVAL_STATUS_REJECTED with feedback comment", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    forConversation: async () => ({ host: "127.0.0.1", port: 1234, protocol: "http" }),
  };
  const service = new ConversationService({ transport: mockTransport, router: mockRouter });

  await service.approveArtifact("conv-1", {
    artifactUri: "file:///C:/test/file.md",
    approved: false,
    comment: "Please format this as markdown table",
  });

  assert.equal(captured.body.artifactComments[0].approvalStatus, "ARTIFACT_APPROVAL_STATUS_REJECTED");
  assert.equal(captured.body.artifactComments[0].comment, "Please format this as markdown table");
});

test("10. terminal input encodes to base64 and includes inputStreamId", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    ensure: async () => {},
    instances: [{ host: "127.0.0.1", port: 1234, protocol: "http" }],
  };
  const terminals = new TerminalService({ transport: mockTransport, router: mockRouter });
  terminals.terminalOwners.set("term-1", { host: "127.0.0.1", port: 1234, protocol: "http" });

  await terminals.input("term-1", "echo test\r\n");
  assert.equal(captured.method, "SendTerminalInput");
  assert.equal(captured.body.terminalId, "term-1");
  assert.equal(captured.body.inputStreamId, "term-1");
  assert.equal(Buffer.from(captured.body.input, "base64").toString("utf8"), "echo test\r\n");
});

test("11. terminal resize generates valid dimensions payload with inputStreamId", async () => {
  let captured;
  const mockTransport = {
    unary: async (_inst, method, body) => {
      captured = { method, body };
      return {};
    },
  };
  const mockRouter = {
    ensure: async () => {},
    instances: [{ host: "127.0.0.1", port: 1234, protocol: "http" }],
  };
  const terminals = new TerminalService({ transport: mockTransport, router: mockRouter });
  terminals.terminalOwners.set("term-1", { host: "127.0.0.1", port: 1234, protocol: "http" });

  await terminals.resize("term-1", 120, 40);
  assert.equal(captured.body.terminalId, "term-1");
  assert.equal(captured.body.inputStreamId, "term-1");
  assert.deepEqual(captured.body.resize, { cols: 120, rows: 40 });
});

test("12. browser screenshot normalizes response data and mimeType", async () => {
  const mockTransport = {
    unary: async (_inst, method) => {
      if (method === "CaptureScreenshot") {
        return { image: { data: "aW1hZ2VkYXRh", mimeType: "image/jpeg" } };
      }
      return {};
    },
  };
  const mockRouter = {
    ensure: async () => {},
    instances: [{ host: "127.0.0.1", port: 1234, protocol: "http" }],
  };
  const browser = new BrowserService({ transport: mockTransport, router: mockRouter });

  const result = await browser.screenshot("page-1");
  assert.equal(result.data, "aW1hZ2VkYXRh");
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.raw);
});

test("13. conversation listing coalesces concurrent requests and keeps the last successful result", async () => {
  let calls = 0;
  let failing = false;
  const instances = [{ port: 1001 }, { port: 1002 }];
  const mockTransport = {
    unary: async (instance) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failing) throw new Error("Language Server unavailable");
      return {
        trajectorySummaries: [{
          key: `conv-${instance.port}`,
          value: { summary: `Conversation ${instance.port}`, stepCount: 1 },
        }],
      };
    },
  };
  const mockRouter = {
    instances,
    ensure: async () => instances,
    pinConversation() {},
  };
  const service = new ConversationService({ transport: mockTransport, router: mockRouter, logger: { warn() {} } });

  const [first, concurrent] = await Promise.all([service.list(), service.list()]);
  assert.equal(calls, 2);
  assert.deepEqual(concurrent, first);
  assert.equal(first.length, 2);
  assert.equal(service.getListMeta().stale, false);

  failing = true;
  const cached = await service.list();
  assert.deepEqual(cached, first);
  assert.equal(service.getListMeta().stale, true);
  assert.equal(service.getListMeta().failedInstances, 2);
});
