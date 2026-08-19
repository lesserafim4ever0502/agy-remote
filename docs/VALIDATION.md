# Real-machine validation checklist (Antigravity v2.8.1 on Windows)

## 1. Discovery (VERIFIED)

- Language Server version: `2.8.1` (executable: `language_server.exe`).
- Process scan successfully discovers PID, ports, CSRF token, and IDE version.
- Multi-port deduplication selects active single instance.

## 2. Read-only RPCs (VERIFIED)

- `GetWorkspaceInfos`: Verified (`homeDirPath`, `homeDirUri`, `geminiDirUri`).
- `GetAllCascadeTrajectories`: Verified (`trajectorySummaries` map).
- `GetCascadeModelConfigData`: Verified (14 models returned with `quotaInfo`).
- `ListTerminals` / `ListPages` / `GetMcpServerStates`: Verified responsive.

## 3. Core Agent Happy Path (VERIFIED)

- `StartCascade` -> `SendUserCascadeMessage` with `DEFAULT_MODEL` (`MODEL_PLACEHOLDER_M71`).
- `StreamAgentStateUpdates` live Connect framing with step index deltas.
- Read query completed cleanly to IDLE.
- Harmless write query created physical file `agy-remote-test.txt` ("hello from agy remote") on disk.
- Zero `thinking` / `rawThinking` leaked (0 tokens across 207 stream events and final snapshot).
- Clean `DeleteCascadeTrajectory` and scratch cleanup.

## 4. Runtime Approvals (VERIFIED)

- `runCommand` approval / rejection / edit before run (`submittedCommandLine`) verified with real protobuf unmarshaling.
- `filePermission` verified for all 8 scopes (`PERMISSION_SCOPE_ONCE`, `PERMISSION_SCOPE_CONVERSATION`, `PERMISSION_SCOPE_WORKSPACE`, `PERMISSION_SCOPE_SESSION`, `PERMISSION_SCOPE_GLOBAL`, etc.).
- `askQuestion` structured responses verified with protobuf `QuestionResponse` array schema (`answers: string[]`, `cancelled: boolean`).

## 5. Artifact Review (VERIFIED)

- `SendUserCascadeMessage.artifactComments` verified with `ARTIFACT_APPROVAL_STATUS_APPROVED` and `ARTIFACT_APPROVAL_STATUS_REJECTED` (with feedback comments).

## 6. Integrated Terminal Lifecycle (VERIFIED)

- `CreateTerminal` -> `StreamTerminalOutput` -> `SendTerminalInput` (with `inputStreamId` and base64) -> output `AGY_REMOTE_TERMINAL_OK` -> Ctrl+C interrupt (`\x03`) -> `resize` -> `CloseTerminal`.

## 7. Browser Integration (VERIFIED)

- `ListPages` returns pages list.
- `SmartOpenBrowser` identified platform constraint on Windows ("local chrome mode is only supported on Linux").
- Screenshot normalization layer handles `{ data, mimeType, raw }`.

## 8. Subagents (VERIFIED)

- `invokeSubagent` execution and `subagent.update` projection verified.
