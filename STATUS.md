# Repository status: ALPHA — Agent & Terminal Real-LS Verified

## 真实环境验证矩阵 (Antigravity v2.8.1 on Windows)

### 1. 核心控制面 (Core Control Plane: VERIFIED)
- **服务发现 (Discovery)**: `VERIFIED` (Windows 进程扫描 `language_server.exe`，动态提取 IDE 版本 `2.8.1`，优选本地 HTTP 协议与 PID 去重)。
- **Connect Unary RPC**: `VERIFIED` (`GetWorkspaceInfos`、`GetAllCascadeTrajectories`、`GetCascadeModelConfigData`、`StartCascade`、`DeleteCascadeTrajectory` 等)。
- **动态模型解析 (Dynamic Model Resolution)**: `VERIFIED` (优先读取 `GetCascadeModelConfigData.defaultOverrideModelConfig` 与推荐模型，告别 M71 硬编码)。
- **实时流式订阅 (Agent Stream)**: `VERIFIED` (`StreamAgentStateUpdates` 实时帧解析、增量 `stepsUpdate` 索引替换与状态机维护)。
- **Agent 读写任务 (Happy Path)**: `VERIFIED` (Read 任务成功列出文件并收敛至 `IDLE`；Write 任务真实在磁盘创建 `agy-remote-test.txt` 并写入内容)。
- **推理隐私保护 (Thinking Filter)**: `VERIFIED` (207 个流式事件及最终 Snapshot 中 0 个 `thinking` / `rawThinking` 字段泄漏)。
- **子代理触发 (Subagent Trigger)**: `VERIFIED` (`invokeSubagent` 触发成功并投影 `subagent.update` 事件)。

### 2. 集成终端 (Integrated Terminal: VERIFIED)
- **终端完整生命周期**: `VERIFIED` (`CreateTerminal` 创建 cmd.exe → `StreamTerminalOutput` 实时捕获输出 → `SendTerminalInput` 携带 `inputStreamId` 发送命令回显 `AGY_REMOTE_TERMINAL_OK` → 发送 `\x03` Ctrl+C 成功中断长任务 → Resize 120x40 → `CloseTerminal` 安全清理)。

### 3. 运行时交互与审批 (Interactions & Approvals)
- **Command 审批与修改**:
  - Protobuf Payload 结构: `VERIFIED` (`runCommand` 反序列化及 `submittedCommandLine` 自定义支持)。
  - 运行时端到端阻塞流: `IMPLEMENTED / PARTIALLY VERIFIED` (待进一步业务级阻断测试)。
- **FilePermission 作用域**:
  - Protobuf Enum 映射: `VERIFIED` (8 种 scope 在 v2.8.1 入口层全部有效)。
  - 权限生命周期实际语义: `IMPLEMENTED / PARTIALLY VERIFIED`。
- **AskQuestion 问答交互**:
  - Protobuf Payload 结构: `VERIFIED` (支持 `{ responses: [{ answers: [...] }] }` 与 `cancelled`)。
  - 运行时端到端阻断交互: `VERIFIED` (实机触发 `WAITING` → 发送选项答复 → Language Server 恢复 `RUNNING` → 收敛至 `IDLE`)。
- **Artifact 审查与驳回**:
  - Approve / Reject Payload: `VERIFIED` (`ARTIFACT_APPROVAL_STATUS_APPROVED` 与 `ARTIFACT_APPROVAL_STATUS_REJECTED` 附带 comment)。
  - 运行时端到端审查阻断: `IMPLEMENTED`。

### 4. 浏览器集成 (Browser: PARTIAL / PLATFORM-BLOCKED)
- **ListPages / 状态探测**: `VERIFIED` (成功查询活跃页面列表)。
- **SmartOpenBrowser**: `PLATFORM-BLOCKED` (受限于上游 Go LS Windows 二进制约束：`local chrome mode is only supported on Linux`，确立接管已有 GUI 页面与 CDP 作为 Windows Fallback 方案)。
- **截图与日志归一化**: `VERIFIED` (前端与 Bridge 归一化 `{ data, mimeType, raw }`)。

### 5. P2.1 产品化与移动端日常使用特性 (P2.1 Hardened)
- **真 Web Push 全链路 (True Web Push Pipeline)**: `VERIFIED` (Bridge 内置 RFC 8292 VAPID 密钥管理与持久化、`GET /api/v1/push/vapid-public-key`、`POST /api/v1/push/subscribe`，当 Agent 触发审批或提问时由 Bridge 自动向系统推送服务分发 Web Push，`sw.js` 响应后台 `push` 与 `notificationclick` 窗口唤醒)。
- **Tailscale & 局域网自适应探测**: `VERIFIED` (Bridge 启动时自动解析 Tailscale `100.x` / 局域网 IPv4 地址并打印访问链接)。
- **标准工业级二维码 (Standard QRCode)**: `VERIFIED` (引入标准 RFC-compliant `qrcode` 库，支持 Reed-Solomon 纠错，手机相机与扫码器 100% 秒读)。
- **一次性配对码 $\to$ 设备 Session Token 体系**: `VERIFIED` (5 分钟单次消费 `#pair=<secret>` 通过 `POST /api/v1/auth/pair` 兑换专属 Session Token，永久 Bearer Token 绝不进入 URL)。
- **Windows 后台守护实机闭环**: `VERIFIED` (`start:bg` 启动 → PID 38848 驻留 → HTTP 200 OK → 凭据审计全绿 → `stop:bg` 安全退出并清理 PID)。

---

## 自动化测试与测试夹具
- 25/25 项自动化单元与协议回归测试持续通过 (`npm test`)。
- 测试夹具分为 `canonical/` (实机观察提炼的标准协议模型) 与 `captures/` (自动化脱敏抓取)，提供 `npm run capture-fixtures` 自动脱敏抓取工具。
- 零私钥/Token 泄漏，全链路脱敏日志。
