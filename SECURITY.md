# Security model

Agy Remote controls a local coding agent that can read/write files and execute commands. Treat the bridge as a privileged local service.

## Trust boundary

```text
Phone/PWA -- Agy Remote bearer token --> Bridge -- local CSRF/API metadata --> Antigravity Language Server
```

The bridge must never return `x-codeium-csrf-token`, Antigravity API keys, session data, or raw daemon records to the browser.

## Defaults

- `AGY_REMOTE_HOST=127.0.0.1`
- wildcard/public binds rejected unless explicitly overridden
- command auto execution off
- gitignored access disabled
- raw arbitrary RPC route intentionally absent
- interactions require an explicit typed route

## Recommended remote access

Use Tailscale and bind the bridge to the machine's Tailscale IP. Do not expose Antigravity's Language Server port directly, and do not expose a Chromium CDP port.

## Approval behavior

This repo implements normal `HandleCascadeUserInteraction` responses. It intentionally does not implement techniques that inject permissions into a conversation after a denied/cancelled request.

## Model internals

Some Antigravity step payloads contain fields named `thinking` and `rawThinking`. The projector deliberately omits them from the remote event model.
