# Architecture

```text
Mobile PWA
   |
   | HTTP + one multiplexed WebSocket
   v
Bridge
   |- Auth + bind policy
   |- EventHub (seq/ring-buffer resume)
   |- Conversation API
   |- Interaction API
   |- Terminal API
   |- Browser API
   v
Agy local adapter
   |- Discovery
   |- Multi-LS Router
   |- Connect unary transport
   |- Connect server streaming
   |- Agent state delta merger
   |- Stable event projector
   v
exa.language_server_pb.LanguageServerService
```

## Why a projector exists

The browser never consumes Antigravity protobuf-shaped JSON directly. The bridge owns protocol drift. Raw steps are projected into stable events such as:

- `assistant.message`
- `user.message`
- `task.update`
- `tool.command`
- `tool.file`
- `browser.action`
- `approval.required`
- `subagent.update`
- `error`

## Conversation state

`StreamAgentStateUpdates` is treated as state synchronization, not an append-only token stream. `stepsUpdate.indices[i]` replaces `steps[indices[i]]`. Full replacement is supported as fallback.

## WebSocket model

One connection carries all resources. Every outbound message gets a monotonic `seq`.

```json
{
  "seq": 42,
  "channel": "conversation",
  "resourceId": "cascade-id",
  "event": { "type": "assistant.message", "...": "..." }
}
```

Clients can send `{"type":"resume","lastSeq":41}`. If the ring buffer cannot satisfy the gap, the bridge emits `resync_required`.
