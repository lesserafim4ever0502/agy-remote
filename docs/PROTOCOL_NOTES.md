# Protocol notes

Service prefix:

```text
exa.language_server_pb.LanguageServerService
```

Unary Connect-style local request:

```http
POST /exa.language_server_pb.LanguageServerService/<Method>
Content-Type: application/json
connect-protocol-version: 1
x-codeium-csrf-token: <local token>
```

Server streaming uses `application/connect+json` and frames:

```text
[flags:1][length:4 big endian][JSON payload]
```

The implementation treats flag `0x02` as Connect end-stream metadata and rejects compressed (`0x01`) frames because compression negotiation is not requested.

## Important methods currently used

Conversation:

```text
GetWorkspaceInfos
GetAllCascadeTrajectories
LoadTrajectory
GetCascadeTrajectory
GetCascadeTrajectorySteps
StartCascade
UpdateConversationAnnotations
SendUserCascadeMessage
CancelCascadeInvocation
RevertToCascadeStep
DeleteCascadeTrajectory
```

Realtime:

```text
StreamAgentStateUpdates
```

Models:

```text
GetCascadeModelConfigData
```

Interactions:

```text
HandleCascadeUserInteraction
```

Terminal:

```text
CreateTerminal
StreamTerminalOutput
SendTerminalInput
CloseTerminal
ListTerminals
```

Browser:

```text
ListPages
FocusUserPage
SmartOpenBrowser
CaptureScreenshot
CaptureConsoleLogs
```
