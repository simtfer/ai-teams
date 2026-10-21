# AI Teams

用一位 Claude Code 主管通过 MCP 工具管理多台 Windows / Linux 机器上的 pi 员工。每个员工绑定一个固定工作目录和一个持久会话，任务完成后主管可以继续向同一员工派发新任务，员工沿用原会话上下文。

当前范围：

- 主管 harness：Claude Code
- 员工 harness：pi 1.3.0
- 管理入口：Claude Code 会话内的 `ai-teams` MCP 工具，无独立 CLI / Web / 桌面端
- Windows 节点代理通过计划任务开机自启（S4U，无需登录，不是 Windows 服务）；Linux 节点由 systemd 开机自启，主管端通过计划任务维持 SSH 隧道并自动重连
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
- 任务以 `interrupted`、`canceled` 或 `failed` 结束且员工没有输出时，`get_task_result` 仍返回包含状态与错误的完整报告。
- 拒绝或改派视为新任务，原任务记录不改写，新任务可携带前序报告。
- 只有 `get_task_result` 会返回员工结果全文；列表、任务详情和待处理结果只显示状态与字符数，避免结果文本不受控地进入主管上下文。
- 结果被完整读取后才标记为已投递并确认节点事件。

## 目录

```
src/node/          节点代理：配置、SQLite、pi 运行器、调度服务、HTTP 服务
src/supervisor/    主管端：配置、SQLite 缓存、节点客户端、服务层、MCP 入口
src/shared/        两端共享类型
config/            配置示例（真实配置被 .gitignore 忽略）
scripts/           手动启动、登录自启回退、计划任务与 SSH 隧道安装脚本
test/              自动化测试与 fake pi 固件
docs/              方案设计文档
```

## 前置要求

- Node.js >= 24（使用内置 `node:sqlite`）
- pi CLI 1.3.0，已安装并在 `PATH` 中可执行
- Claude Code（主管端）
- 员工机器与主管机器在同一局域网，或通过 SSH 隧道访问（见“Linux 节点部署”）

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

长期运行建议改用下面的“Windows 开机自启（计划任务）”，无需保持窗口或登录。

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

## Windows 开机自启（计划任务）

以管理员身份安装：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-node-task.ps1
```

脚本会创建计划任务 `AI Teams Node Agent`：开机触发、S4U 登录类型（不保存密码、无需用户登录）、隐藏运行，并生成不含密钥的启动器 `data/node-autostart/run-node.cmd`。启动器为节点进程提供固定的 `PATH`、`HOME`、`APPDATA` 等环境变量，并带看门狗：节点进程意外退出后约 10 秒自动拉起；执行移除时会先写入 `stop.flag`，避免看门狗重启。

安装前提与行为：

- 需要管理员权限，并已完成 `npm run build`。
- 服务端配置必须使用 `token` 或系统级环境变量的 `tokenEnv`；用户级环境变量在 S4U 会话中不可见，脚本会直接拒绝。
- 安装前会查询节点是否有运行中的任务，有则中止；确认可中断后用 `-Force` 跳过检查。
- 若存在旧的“随登录启动”快捷方式会自动移除。
- 安装日志写入 `data/install-node-task.log`，节点输出写入 `data/node-local/logs/node-autostart.log`。

查看状态、移除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-node-task.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts/install-node-task.ps1 -Remove   # 需管理员
```

S4U 计划任务运行在 Session 0：无需用户登录，锁屏、注销不影响任务；睡眠、休眠、重启会中断正在运行的任务，恢复后标记为 `interrupted`，排队任务继续调度。这不是 Windows 服务，仍不提供系统服务模式。

如只需登录后自启（无需管理员），可改用回退脚本 `scripts/install-node-startup.ps1`。

## Linux 节点部署（SSH 隧道）

公网 Linux 节点只监听回环地址，主管通过 SSH 本地端口转发访问，节点端口不直接暴露。下面以应用目录 `/opt/ai-teams/app`、隔离运行时 `/opt/ai-teams/node` 为例。

### 1. 安装隔离的 Node 24 与 pi

```bash
mkdir -p /opt/ai-teams/node
tar -xJf node-v24.18.0-linux-x64.tar.xz -C /opt/ai-teams/node --strip-components=1
/opt/ai-teams/node/bin/npm install -g @earendil-works/pi-coding-agent@1.3.0
/opt/ai-teams/node/bin/node -v    # v24.18.0
/opt/ai-teams/node/bin/pi --version
```

### 2. 部署应用

在开发机构建并上传构建产物，然后在服务器安装生产依赖：

```powershell
npm run build
ssh root@<server> "mkdir -p /opt/ai-teams/app"
scp -r dist package.json package-lock.json root@<server>:/opt/ai-teams/app/
```

```bash
cd /opt/ai-teams/app
/opt/ai-teams/node/bin/npm ci --omit=dev
mkdir -p /opt/ai-teams/data /opt/ai-teams/workspaces
```

### 3. 节点配置

`/opt/ai-teams/app/config/node.json`（权限设为 `600`）：

```json
{
  "nodeId": "node-linux",
  "name": "Linux Node",
  "host": "127.0.0.1",
  "port": 7317,
  "token": "<long-random-token>",
  "dataDir": "/opt/ai-teams/data",
  "allowedRoots": ["/opt/ai-teams/workspaces"],
  "harnesses": {
    "pi": {
      "command": "/opt/ai-teams/node/bin/pi",
      "args": [],
      "version": "1.3.0"
    }
  },
  "maxPromptChars": 200000,
  "version": "0.1.0"
}
```

pi 的供应商配置放在 `~/.pi/agent/models.json`，`apiKey` 使用环境变量插值而不是明文，例如 `"apiKey": "$QIANWEN_API_KEY"`；`~/.pi/agent/settings.json` 指定默认 provider 和 model。

`/opt/ai-teams/app/.env` 保存实际密钥（权限设为 `600`）：

```sh
QIANWEN_API_KEY='<key>'
```

### 4. systemd 服务

`/opt/ai-teams/start-agent.sh`（权限设为 `700`）：

```sh
#!/bin/sh
set -eu
set -a
. /opt/ai-teams/app/.env
set +a
export PATH=/opt/ai-teams/node/bin:$PATH
exec /opt/ai-teams/node/bin/node /opt/ai-teams/app/dist/src/node/agent.js --config /opt/ai-teams/app/config/node.json
```

创建 `/etc/systemd/system/ai-teams-node.service`：

```ini
[Unit]
Description=AI Teams Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-teams/app
ExecStart=/opt/ai-teams/start-agent.sh
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=mixed
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable --now ai-teams-node.service
systemctl status ai-teams-node.service
journalctl -u ai-teams-node.service -f
```

脚本最后 `exec` 节点进程，systemd 直接跟踪主进程。`Restart=always` 使节点崩溃后约 5 秒自动重启；服务开机自启，无需用户登录。`KillMode=mixed` 在停止时终止整个 cgroup，pi 子进程随之退出。停止或重启：

```bash
systemctl restart ai-teams-node.service
systemctl stop ai-teams-node.service
```

节点收到终止信号时会中断运行中的任务；重新启动后，遗留运行任务标记为 `interrupted`，排队任务继续调度。服务当前以 `root` 运行，后续可改为专用用户。

### 5. SSH 隧道与主管端

公网服务器只监听回环地址，主管端通过 Windows 计划任务维持 SSH 本地端口转发，无需手动保持终端。

前提：

- Windows 原生 OpenSSH，默认路径 `C:\Windows\System32\OpenSSH\ssh.exe`。
- SSH 私钥无口令（脚本使用 `BatchMode=yes` 与 `IdentityAgent=none`），且服务器主机密钥已在 `known_hosts` 中。
- 本地端口 `7398` 未被占用。

以管理员身份安装：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-tunnel-task.ps1 `
  -SshHost root@<server> `
  -LocalPort 7398 `
  -RemotePort 7317 `
  -IdentityFile C:\Users\<user>\.ssh\id_ed25519
```

脚本会先测试密钥登录，然后创建计划任务 `AI Teams SSH Tunnel`（开机触发、S4U、无需登录）。生成的启动器使用 `ServerAliveInterval=15`、`ServerAliveCountMax=3` 和 `ExitOnForwardFailure=yes`，SSH 断开后约 10 秒自动重连。默认 `known_hosts` 为 `C:\Users\<user>\.ssh\known_hosts`，日志写入 `data/ssh-tunnel/tunnel.log`。

查看状态、移除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-tunnel-task.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\install-tunnel-task.ps1 -Remove   # 需管理员
```

主管配置中该节点的 `baseUrl` 填 `http://127.0.0.1:7398`，`token` 与节点一致。隧道断开期间主管端显示节点离线，可读取本地缓存的任务与结果；恢复后节点重新在线，之前已确认的事件不会重复投递。

调试时也可手动建立隧道：

```bash
ssh -N -L 7398:127.0.0.1:7317 root@<server>
```

安全注意：

- 公网服务器不要把 `host` 改为 `0.0.0.0`，也不要开放 7317 端口；隧道只把远端回环端口转发到本机回环地址。
- `node.json` 与 `.env` 保持 `600` 权限；pi provider 配置中不写明文密钥。
- 传输加密由 SSH 提供，应用层仍是 HTTP + Bearer token；TLS 尚未实现。
- systemd 服务当前以 root 运行；SSH 隧道任务使用安装用户的私钥，密钥 ACL 应只允许该用户、SYSTEM 和 Administrators 读取。

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

测试会先构建，再使用 fake pi 覆盖（当前 18 项全部通过）：

- 鉴权、工作目录白名单、同节点工作目录唯一性
- 会话跨任务复用
- 有序事件与确认
- 120k 字符长结果不截断
- `NEEDS_INPUT`、失败不重试、超时、取消与进程树终止
- 节点重启中断恢复、节点关闭中断
- 终态无员工输出时的兜底报告与 pending 清理
- 主管端在线查询、离线缓存回退、结果只投递一次
- MCP stdio 客户端端到端调用

## 已知限制

- 员工停用后不能重新启用；需要重新创建员工。
- 失败不自动重试；拒绝/改派需要新建任务。
- Windows 与 Linux 节点均已支持无人登录自启；Windows 端由计划任务启动节点与 SSH 隧道，Linux 节点由 systemd 管理。Windows 侧不是 Windows 服务；睡眠、重启仍会中断正在运行的任务。
- 公网 Linux 节点依赖 SSH 隧道；隧道断开期间主管端只能读取缓存，无法派发新任务，恢复后自动重连。
- Linux 节点服务当前以 root 运行；隧道任务使用无口令 SSH 私钥。
- 隧道任务与节点任务都依赖安装用户的配置和 Windows 计划任务，注销不影响，但删除用户配置或密钥会导致重启后无法启动。
- Windows 隧道任务的开机触发未单独做整机重启复验；其计划任务模式与已复验的节点任务相同。
- 主管端缓存用于离线回退，节点在线时以节点数据为准。
- 主管上下文治理目前依赖“结果只通过 `get_task_result` 注入全文”的边界；超长对话的压缩策略仍待设计。
- 安全当前仅覆盖局域网 Bearer token 与工作目录白名单，传输加密、审计、凭据轮换等后续再定。
- harness 版本通过配置锁定并在健康检查中比对，升级流程尚未实现。
