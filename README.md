# AI Teams

用一位 Claude Code 主管通过 MCP 工具管理多台 Windows 机器上的 pi 员工。每个员工绑定一个固定工作目录和一个持久会话，任务完成后主管可以继续向同一员工派发新任务，员工沿用原会话上下文。

当前范围：

- 主管 harness：Claude Code
- 员工 harness：pi 1.3.0
- 管理入口：Claude Code 会话内的 `ai-teams` MCP 工具，无独立 CLI / Web / 桌面端
- 节点代理随用户登录启动，运行在已登录的桌面会话中（不是 Windows 服务）
- 节点与主管各自使用本地 SQLite，结果通过有序事件日志上报

方案设计见 [docs/ai-teams-solution.md](docs/ai-teams-solution.md)，主管行为规则见 [CLAUDE.md](CLAUDE.md)。

## 架构

```
Claude Code（主管会话）
  └─ MCP stdio: ai-teams
       └─ 主管端 SQLite 缓存 + HTTP 客户端
            └─ HTTP + Bearer Token → 节点代理（每台员工机器一个）
                 └─ 节点端 SQLite + FIFO 调度
                      └─ pi -p --mode json --session-id <员工固定会话>
                           └─ 员工工作目录
```

关键语义：

- 一个员工同一时间只运行一个任务，其余任务按 FIFO 排队。
- 派发任务时显式指定的员工优先，主管不会改派。
- 节点离线时，创建员工和派发任务立即失败，不自动重试。
- 超时默认关闭，可按任务配置；取消会终止进程树。
- 任务失败或返回 `NEEDS_INPUT:` 前缀时只上报一次，不自动重试。
- 拒绝或改派视为新任务，原任务记录不改写，新任务可携带前序报告。
- 只有 `get_task_result` 会返回员工结果全文；列表、任务详情和待处理结果只显示状态与字符数，避免结果文本不受控地进入主管上下文。
- 结果被完整读取后才标记为已投递并确认节点事件。

## 目录

```
src/node/          节点代理：配置、SQLite、pi 运行器、调度服务、HTTP 服务
src/supervisor/    主管端：配置、SQLite 缓存、节点客户端、服务层、MCP 入口
src/shared/        两端共享类型
config/            配置示例（真实配置被 .gitignore 忽略）
scripts/           手动启动与随登录启动脚本
test/              自动化测试与 fake pi 固件
docs/              方案设计文档
```

## 前置要求

- Node.js >= 24（使用内置 `node:sqlite`）
- pi CLI 1.3.0，已安装并在 `PATH` 中可执行
- Claude Code（主管端）
- 员工机器与主管机器在同一局域网

## 快速开始

### 1. 安装依赖并构建

```powershell
npm install
npm run build
```

### 2. 配置节点代理

```powershell
Copy-Item config\node.example.json config\node.json
```

至少修改：

- `nodeId`：节点唯一 id
- `allowedRoots`：允许创建员工工作目录的根路径白名单，例如 `["D:\\work"]`
- `token`：长随机字符串；也可以改用 `tokenEnv` 指向环境变量
- `host` / `port`：默认监听 `0.0.0.0:7317`
- `harnesses.pi.command`：pi 可执行文件路径或命令名
- `harnesses.pi.version`：锁定版本，当前为 `1.3.0`

生成 token 示例：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. 启动节点代理

```powershell
npm run start:node
# 或双击 scripts\start-node.cmd
```

健康检查（将 token 替换为实际值）：

```powershell
curl http://127.0.0.1:7317/health -H "Authorization: Bearer <token>"
```

返回中的 `harnesses[].versionMatches` 表示实际 pi 版本是否与配置锁定版本一致。

### 4. 配置主管端

```powershell
Copy-Item config\supervisor.example.json config\supervisor.json
```

为每个节点填写：

- `id` / `name`：与节点配置保持一致
- `baseUrl`：节点代理地址，例如 `http://192.168.1.20:7317`
- `token`：与节点一致的 token；也可使用 `tokenEnv`

### 5. 在 Claude Code 中加载 MCP

项目根目录的 `.mcp.json` 已声明 `ai-teams` MCP server。在该目录启动 Claude Code 并确认工具已加载：

```powershell
claude
```

首次启动时按 Claude Code 提示批准项目级 MCP server。可用 `/mcp` 查看连接状态，或直接要求主管列出节点：

```text
使用 ai-teams 工具列出所有节点和员工。
```

也可以用显式配置做一次性验证：

```powershell
claude --mcp-config .mcp.json --strict-mcp-config -p "使用 ai-teams 工具列出所有节点和员工"
```

主管收到请求后按 `CLAUDE.md` 中的规则工作，不读取员工机器文件，只通过 MCP 工具获取结构化任务报告。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_nodes` | 查看已配置节点及其在线状态、版本 |
| `list_employees` | 查看员工及状态 |
| `get_employee` | 查看单个员工 |
| `create_employee` | 在在线节点创建员工（工作目录必须已存在且在允许根目录内） |
| `disable_employee` | 停用员工（当前不支持重新启用） |
| `assign_task` | 向员工派发任务，显式员工不可被改派 |
| `list_tasks` | 查看任务列表（不含结果全文） |
| `get_task` | 查看任务详情（不含结果全文） |
| `list_pending_results` | 查看已结束但未读取结果的任务 |
| `get_task_result` | 获取任务结果全文，并完成投递确认 |
| `cancel_task` | 取消排队或运行中的任务 |

## 随登录启动

为当前用户安装启动快捷方式（登录后自动运行节点代理，窗口最小化）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-node-startup.ps1
```

移除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-node-startup.ps1 -Remove
```

这只保证“用户已登录”时运行。锁屏不影响任务；注销、睡眠或重启会中断正在运行的任务，节点重启后将其标记为 `interrupted`，排队任务继续调度。暂不提供 Windows 服务模式。

## 配置说明

### 节点配置

| 字段 | 说明 |
| --- | --- |
| `nodeId` | 节点唯一 id，主管端据此校验响应来源 |
| `name` | 显示名称 |
| `host` / `port` | HTTP 监听地址 |
| `token` / `tokenEnv` | Bearer token，至少 8 字符 |
| `dataDir` | SQLite 与日志目录，相对配置文件解析 |
| `allowedRoots` | 员工工作目录白名单 |
| `harnesses.pi` | pi 命令、额外参数、锁定版本 |
| `appendSystemPrompt` | 追加给 pi 的系统提示，可覆盖默认员工角色说明 |
| `maxPromptChars` | 单任务提示长度上限 |
| `version` | 节点代理版本 |

### 主管配置

| 字段 | 说明 |
| --- | --- |
| `dataDir` | 主管端 SQLite 与日志目录 |
| `requestTimeoutMs` | 访问节点 HTTP API 的超时 |
| `nodes[]` | 节点 id、名称、`baseUrl`、`token` / `tokenEnv` |

真实配置文件 `config/node.json`、`config/supervisor.json`、`data/` 和日志均被 `.gitignore` 忽略。

## 测试

```powershell
npm test
```

测试会先构建，再使用 fake pi 覆盖：

- 鉴权、工作目录白名单、同节点工作目录唯一性
- 会话跨任务复用
- 有序事件与确认
- 120k 字符长结果不截断
- `NEEDS_INPUT`、失败不重试、超时、取消与进程树终止
- 节点重启中断恢复、节点关闭中断
- 主管端在线查询、离线缓存回退、结果只投递一次
- MCP stdio 客户端端到端调用

## 已知限制

- 员工停用后不能重新启用；需要重新创建员工。
- 失败不自动重试；拒绝/改派需要新建任务。
- 不支持无人值守服务；注销/睡眠会中断任务。
- 主管端缓存用于离线回退，节点在线时以节点数据为准。
- 主管上下文治理目前依赖“结果只通过 `get_task_result` 注入全文”的边界；超长对话的压缩策略仍待设计。
- 安全当前仅覆盖局域网 Bearer token 与工作目录白名单，传输加密、审计、凭据轮换等后续再定。
- harness 版本通过配置锁定并在健康检查中比对，升级流程尚未实现。
