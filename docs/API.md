# Bridge API

All `/api/v1/*` endpoints except `/api/v1/ping` require:

```http
Authorization: Bearer <Agy Remote token>
```

## Core

```text
GET  /api/v1/ping
GET  /api/v1/status
GET  /api/v1/workspaces
GET  /api/v1/models
GET  /api/v1/quota
```

## Conversations

```text
GET    /api/v1/conversations
POST   /api/v1/conversations
GET    /api/v1/conversations/:id
DELETE /api/v1/conversations/:id
POST   /api/v1/conversations/:id/messages
POST   /api/v1/conversations/:id/stop
POST   /api/v1/conversations/:id/revert
POST   /api/v1/conversations/:id/artifacts/approve
POST   /api/v1/conversations/:id/interactions/respond
```

Create body:

```json
{ "workspaceUri": "file:///repo", "model": "optional-internal-model-id" }
```

Message body:

```json
{ "text": "Fix the test", "model": "optional-internal-model-id" }
```

Typed file permission response:

```json
{
  "trajectoryId": "trajectory-id",
  "stepIndex": 9,
  "kind": "filePermission",
  "allow": true,
  "scope": "PERMISSION_SCOPE_ONCE",
  "absolutePathUri": "file:///repo/.env.example"
}
```

## Terminal

```text
GET    /api/v1/terminals?conversationId=...
POST   /api/v1/terminals
POST   /api/v1/terminals/:id/input
POST   /api/v1/terminals/:id/resize
DELETE /api/v1/terminals/:id
```

## Browser

```text
GET  /api/v1/browser/pages
POST /api/v1/browser/open
POST /api/v1/browser/pages/:id/focus
GET  /api/v1/browser/pages/:id/screenshot
GET  /api/v1/browser/pages/:id/console
```

## WebSocket

```text
ws(s)://host/api/v1/events?token=<Agy Remote token>
```

Subscribe:

```json
{ "type": "subscribe", "channel": "conversation", "resourceId": "cascade-id" }
```

or:

```json
{ "type": "subscribe", "channel": "terminal", "resourceId": "terminal-id" }
```

Resume:

```json
{ "type": "resume", "lastSeq": 128 }
```

Outbound event:

```json
{
  "seq": 129,
  "channel": "conversation",
  "resourceId": "cascade-id",
  "event": { "type": "assistant.message", "stepIndex": 12, "text": "..." }
}
```
