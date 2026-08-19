# Agy Remote

Agy Remote is a **local headless control plane + mobile PWA** for Antigravity. It talks to Antigravity's local `LanguageServerService` rather than mirroring the Electron UI.

> Status: implementation-grade research prototype. The bridge and web app are runnable, the local protocol adapter is implemented, and unit tests cover the most fragile protocol-independent pieces. Real Antigravity integration still needs to be validated on a machine with the target Antigravity build.

## What is implemented

- Language Server discovery from Antigravity daemon files, with optional process/port scanning fallback.
- Local CSRF-aware Connect unary JSON calls over HTTP/HTTPS.
- Connect server-stream decoder (`application/connect+json`, 5-byte envelope).
- Multi-LS conversation routing and ownership pinning.
- Conversation list, snapshot, create, send, stop, revert, delete.
- `StreamAgentStateUpdates` subscription, delta merge, reconnect and projection to a stable remote event model.
- Conservative interaction replies for file/command/browser/general permission/ask-question approvals.
- Model + quota projection from `GetCascadeModelConfigData`.
- Integrated terminal adapter: list/create/stream/input/resize/close.
- Browser adapter: list pages, focus, open, screenshot, console logs.
- Subagent projection from `invokeSubagent` steps.
- Zero-dependency HTTP bridge and WebSocket multiplexer with ring-buffer resume.
- Same-origin mobile PWA with conversation list, live timeline, send/stop, terminal and browser panels.
- Bearer-token auth; Language Server CSRF/API credentials never leave the PC.
- No permission-bypass or "force grant" hacks.

## Quick start

Requirements: Node.js 22+ and an Antigravity installation running locally.

```bash
npm test
npm run doctor
npm start
```

The bridge prints the local URL and the bearer token path. Open the URL from the same machine first. For phone access, prefer Tailscale and bind `AGY_REMOTE_HOST` to the PC's Tailscale address (or a private LAN address you explicitly trust).

Default port: `7317`.

## Authentication

If `AGY_REMOTE_TOKEN` is unset, Agy Remote creates a random token at:

```text
~/.agy-remote/token
```

The PWA asks for that token and stores it in browser local storage. This token is **not** the Antigravity CSRF token.

## Safety defaults

- Bridge defaults to `127.0.0.1`.
- Public-looking bind addresses are rejected unless `AGY_REMOTE_ALLOW_PUBLIC_BIND=1`.
- Terminal auto-execution defaults to `off`.
- Gitignored access is not enabled by default.
- The bridge does not expose a raw arbitrary RPC passthrough.
- The projector intentionally does **not** forward model `thinking` / `rawThinking` fields.

See [SECURITY.md](SECURITY.md).

## Repository map

```text
apps/bridge/          HTTP + WebSocket control plane
apps/web/             zero-build PWA
packages/agy-ls/      Antigravity local protocol adapter
scripts/              doctor/smoke utilities
tests/                Node built-in test suite
docs/                 protocol and architecture notes
AGENT_HANDOFF.md      prioritized work for the next coding agent
```

## First real-machine validation

Run:

```bash
npm run doctor
```

Expected result is at least one discovered Language Server and a successful `GetWorkspaceInfos` probe. Then run the bridge and inspect:

```text
GET /api/v1/status
GET /api/v1/conversations
```

The next agent should validate the exact request shapes against the installed build before expanding the feature surface. Internal Antigravity protocol is not a stable public API.

## Acknowledgements / protocol provenance

The implementation was guided by public reverse-engineering work around Antigravity's local protocol, especially:

- `jkfujinami/antigravity-grpc-schemas` for extracted protobuf schema information.
- `pikapikaspeedup/Antigravity-Mobility-CLI` for practical Connect-stream and state-merge behavior.
- `L1M80/porta` for local Language Server discovery/routing ideas.

Agy Remote is unofficial and is not affiliated with Google or the Antigravity team.
