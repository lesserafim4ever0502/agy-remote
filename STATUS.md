# Repository Status: P2.2 v1.1 — Tailscale-Native Remote Architecture & Persistent Monitor

## 真实环境验证矩阵 (Antigravity v2.8.1 on Windows)

### 1. 网络架构与安全约束 (Tailscale-Native & Localhost Only)
- **Localhost 严格绑定**: `VERIFIED` (`assertSafeBind` 默认且严格只监听 `127.0.0.1`、`localhost`、`::1`；`0.0.0.0` / 局域网地址默认抛出异常阻断；仅在 `AGY_REMOTE_ALLOW_NON_LOOPBACK=1` 时作为调试跳过)。
- **Tailscale Serve HTTPS**: `VERIFIED` (`TailscaleManager` 管理官方 `tailscale serve --bg 7317` 与 `tailscale serve reset`，Tailscale 自动签发并维护 HTTPS 证书，手机直接通过 `https://<my-pc>.<tailnet>.ts.net` 安全访问)。
- **公网零暴露与零中继成本**: `VERIFIED` (无需开端口、无自建 Relay、无公网 IP、无 NAT 打洞、0 额外成本)。
- **Master Token 保护与轮换**: `VERIFIED` (Master Token 本地 `~/.agy-remote/token` 隔离，前端完全移除 legacy `#token=` 逻辑，Master Token 永不进入浏览器)。
- **持久化设备 Session 与 SHA-256 哈希**: `VERIFIED` (手机持有 256-bit 随机 Token，电脑仅存 `SHA-256(token)` 至 `~/.agy-remote/sessions.json`；支持 90 天 Inactive TTL、365 天 Absolute TTL 与滑动延期，冷启动与内存清空自动持久化重载)。
- **WebSocket 一次性票据**: `VERIFIED` (`POST /api/v1/auth/ws-ticket` 签发 30 秒有效单次消费 Ticket，握手在 `101 Switching Protocols` 前立即销毁，URL 查询参数长期 Token 彻底移除)。

### 2. 常驻 Agent Monitor (Persistent Stream Owner)
- **唯一 Stream Owner**: `VERIFIED` (彻底解耦 WebSocket 客户端与 Antigravity Stream 生命周期，手机断网、息屏或杀掉 PWA，Bridge 进程持续保持 Stream 监听)。
- **自适应动态轮询**: `VERIFIED` (活跃任务时 5 秒轮询，全空闲时 15 秒轮询；任务 IDLE 后保留 30 秒缓冲再 detach)。
- **精确 Push 去重**: `VERIFIED` (按 `conversationId:trajectoryId:stepIndex:kind` 进行精准推送去重，在 `state(RUNNING) -> approval -> state(RUNNING) -> approval` 真实流序下不重复推送，仅在 step 推进或任务完成时清理)。
- **断线指数退避**: `VERIFIED` (Antigravity 崩溃或重启时标记 degraded 并指数退避探测，LS 恢复后自动重连并 reattach)。

### 3. 核心控制面与协议支持 (Core Control Plane: VERIFIED)
- **服务发现 (Discovery)**: `VERIFIED` (Windows 进程扫描 `language_server.exe`，动态提取 IDE 版本 `2.8.1`，优选本地 HTTP 协议与 PID 去重)。
- **Connect Unary RPC**: `VERIFIED` (`GetWorkspaceInfos`、`GetAllCascadeTrajectories`、`GetCascadeModelConfigData`、`StartCascade`、`DeleteCascadeTrajectory` 等)。
- **工作区列表 (`GET /api/v1/workspaces`)**: `VERIFIED` (聚合各 LS 实例 `workspaceUris` 并去重)。
- **模型配额 (`GET /api/v1/quota`)**: `VERIFIED` (动态获取模型配额)。
- **会话回滚 (`POST /api/v1/conversations/:id/revert`)**: `VERIFIED`。
- **Artifact 审查与驳回**: `VERIFIED` (`approveArtifact` 结构化传输 `ARTIFACT_APPROVAL_STATUS_APPROVED` / `REJECTED`)。
- **动态模型与思考强度解耦**: `VERIFIED` (基础模型家族与思考强度 Low/Med/High 前端两级分段联动)。
- **富文本 Markdown 与代码高亮**: `VERIFIED` (自适应无溢出代码块与一键 Copy)。

### 4. 集成终端与浏览器 (Integrated Terminal & Browser)
- **集成终端**: `VERIFIED` (`CreateTerminal` 创建 cmd.exe/powershell.exe → `StreamTerminalOutput` 实时流式捕获 → `SendTerminalInput` 发送输入 → Ctrl+C `\x03` 中断 → `CloseTerminal` 安全清理)。
- **浏览器能力**: `PARTIAL` (页面列表查询、截图与日志正常；Windows 原生 SmartOpen 受上游 LS 平台约束，确立现有页面接管与 CDP 作为 Fallback)。

---

## 自动化测试全绿矩阵

- **35 / 35** 项自动化单元与系统集成测试持续通过 (`npm test`)：
  - `bridge-integration.test.js`: Static PWA 服务、Query Token 拒绝、WS Ticket 验证、实时 Stream 传输全绿；
  - `tailscale-remote.test.js`: 安全绑定、冷启动 Session 持久化、Ticket 消费、真实流序 Push 去重、LS 掉线退避全绿；
  - `protocol-regression.test.js` & `transport-integration.test.js`: 协议与编码解码 100% 覆盖。

## 实机验收操作指引
1. `npm run remote:setup`：一键 Tailscale Serve HTTPS 配置与配对二维码生成；
2. `npm run remote:start` / `npm run remote:stop`：Bridge 后台守护进程启停；
3. `npm run remote:status` (`npm run doctor`)：输出 Bridge, Tailscale, Antigravity, Push, Security 5 维健康诊断。
