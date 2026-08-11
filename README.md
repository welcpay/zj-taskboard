# Codex Taskboard

Codex Taskboard 是一个内嵌于 Codex APP 的任务面板。用于在 Codex APP 中管理、查看任务进度与状态

## 系统要求

- macOS 14 或更高版本。
- 已安装官方 Codex/ChatGPT 客户端。支持以下位置：

- [ ] Windows 版本适配中

## 下载和安装

1. 首次安装从 [GitHub Releases](https://github.com/welcpay/zj-taskboard/releases) 下载 DMG，把 `Codex Taskboard.app` 拖入“应用程序”。
2. 从“应用程序”打开 App。它会安装当前版本的本地服务并保持 `http://127.0.0.1:47823` 常驻；关闭 Codex 或 Taskboard App 不会停止该服务。
3. 后续版本使用 App 内自动更新。更新会先安装并验证新 runtime，再切换 LaunchAgent；健康检查失败时自动恢复上一版本。
4. 无法访问 GitHub 的内网、MDM 或 USB 部署可使用同一 Release 中的已签名 PKG。PKG 会停止旧服务、覆盖 App，再由新 App 自动启动并验证新服务。
5. 转到新打开的官方 Codex/ChatGPT 窗口，从侧栏进入任务面板。

## 数据、配置和日志

| 内容 | 路径 |
| --- | --- |
| SQLite 数据库 | `~/Library/Application Support/Codex Taskboard/taskboard.sqlite` |
| 附件 | `~/Library/Application Support/Codex Taskboard/attachments/` |
| 云端配对和本地项目映射 | `~/Library/Application Support/Codex Taskboard/cloud-companion.json` |
| 自动化策略 | `~/Library/Application Support/Codex Taskboard/codex-automation-policies.json` |
| Team Server 配置 | `~/Library/Application Support/Codex Taskboard/team-servers.json`；访问令牌只存 macOS Keychain |
| 版本化服务 runtime | `~/Library/Application Support/Codex Taskboard/runtime/` |
| 覆盖安装备份 | `~/Library/Application Support/Codex Taskboard/backups/` |
| 服务日志 | `~/Library/Logs/Codex Taskboard/daemon.stdout.log`、`daemon.stderr.log` |
| 启动器日志 | `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log` |

删除 App 不会删除任务数据。完整移除服务时，应先从菜单栏的 Taskboard 图标选择“停止并卸载本地服务”；该操作移除 LaunchAgent 和 runtime，但默认保留数据库与附件。需要恢复旧 App 时，解压 `backups/apps/` 中的 `.app.zip` 并重新放入“应用程序”，再启动一次以协调对应 runtime。


# 本地开发

### 要求

- Node.js 22.5 或更高版本
- Rust 1.88
- Xcode 和 Xcode Command Line Tools

安装依赖并启动浏览器开发环境：

```bash
npm ci
npm run dev
```

Vite 界面位于 <http://127.0.0.1:5173>，并把 API 请求转发到本地服务。

准备并启动 Tauri 开发版：

```bash
npm ci
npm run app:dev
```

构建与发布工作流相同的 universal App 和 DMG：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

### 启动本地服务

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。开发仓库默认把 SQLite 数据库存到 `.data/taskboard.sqlite`。


## 使用 `taskctl`

从仓库运行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

如需在 shell 中直接使用 `taskctl`，可运行 `npm link`。`CODEX_TASKBOARD_URL` 可让 CLI 连接另一台本地或局域网服务。云端部署通过本地 companion 和 `taskctl cloud login` 配置。


## 安装 Codex Skill

把 `skills/manage-taskboard` 复制或链接到 Codex Skills 目录，然后新建 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

Skill 会让 Codex 读取任务、移到 `in_progress`、使用乐观版本、验证结果，再移到 `in_review`。只有用户明确验收或要求完成时，它才把任务移到 `done`。

## 不安装 App 时嵌入 Codex

### 推荐：使用独立 CDP 窗口

保留现有 Codex 窗口，并运行：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新窗口出现后，在另一个终端运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

注入器运行期间，独立窗口会显示 Taskboard 侧栏入口。现有 Codex 窗口不变。

### 一条命令启动独立窗口

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令按需启动本地服务，打开官方 macOS Codex App 的独立 profile，注入侧栏入口，并持续监控服务和 renderer。它不修改 `ChatGPT.app` 或 `app.asar`。

如需注入已用其他方式开启 CDP 的 Codex 实例：

```bash
npm run codex:inject -- --port 9229 --open
```

Codex 26.715.52143 的 renderer CSP 会阻止任意 HTTP iframe。启动器使用 CDP 绕过该 renderer 的 CSP，并等待隔离的 Taskboard iframe实际加载。正式 App 的注入会话与本地 HTTP 服务相互独立；所有客户端固定连接 `127.0.0.1:47823`，CDP 端口只用于 Codex 注入会话。

“在对话中打开”会选择对应的原生 Codex 项目，并打开带任务标识的未发送原生 composer。任务实际处理后，`taskctl` 从 `CODEX_THREAD_ID` 记录会话。记录的会话可通过 Codex 原生路由打开。每个任务可绑定一个 Git 分支或 worktree。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 监听地址；设为 `127.0.0.1` 可关闭局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 和附件目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 地址 |

`npm start` 会输出本机和局域网地址。同一受信任网络中的用户可打开局域网地址。任务、评论和附件变化通过 server-sent events 推送；断线重连后会执行完整刷新。

局域网模式没有账号认证。可访问该地址的人都能读写任务面板。不要把该模式直接暴露到公网。

## Cloudflare 协作

两名受信任协作者可使用 Worker Static Assets、D1 和私有 R2 bucket 运行云端任务面板。每台设备仍保留自己的项目 checkout 映射，并用本地 companion 提供 Codex、Git/worktree、Skill 和 MCP 能力。

部署、密码轮换、路径映射和一次性数据迁移见 [Cloud collaboration](docs/cloud-collaboration.md)。

## Team Server

设置中可以保存多个 HTTPS Team Server，但同一时间只激活一个。每位用户使用自己的访问令牌，令牌只存入 macOS Keychain。本地服务始终作为读写入口和离线缓存：断网时继续处理任务，恢复连接后先拉取远程变更再上传本地操作；同一任务的冲突会形成任务分支，可选择保留主版本、提升分支或进行三方合并。启用更新镜像的 Team Server 会成为自动更新首选源，连接失败时回退 GitHub Releases。

## 检查

```bash
npm run check
```

该命令运行 TypeScript 检查、生产 Web 构建和服务端、CLI、注入器测试。
