# dsh-qq-bot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：通过 QQ 开放平台官方 WebSocket 网关和 REST API，将 QQ 群聊与单聊连接到独立的 dsh Agent。

- 不依赖第三方机器人框架，使用 Node.js 内置 `WebSocket` 和 `fetch`
- 每个 QQ 群或用户拥有独立 Agent 会话
- 支持 `/new`、`/stop`、`/tools`、`/help`，并可用 `/whoami` 自助发现 OpenID
- 消息按 Harness turn 精确关联，网关重连事件自动去重
- 主动消息和被动回复使用不同的 QQ 请求格式
- QQ Agent 默认不继承宿主工具，`qq_send` 只能发送到当前会话

## 适用环境

这是标准 DSH 插件，**不要求 DSH Desktop Next**。插件使用宿主提供的 Agent、默认模型、工具和附件服务，不读取 Next 的 slot，也不依赖桌面窗口或 WSL。

| 环境 | 加载方式 |
| --- | --- |
| 普通 DSH CLI / Web | 安装 bundle 到目标 profile，或使用源码路径 patch |
| Linux 服务器 / 容器 | 同一 bundle，通过环境变量配置，运行独立 profile |
| DSH 源码开发环境 | 在 DSH 仓库中使用 `pnpm dsh` 替代 `dsh` |
| Desktop Next | 在其实际运行时中安装到目标 profile，见下方专项说明 |

操作系统与宿主 DSH 的支持范围一致；CI 在 Windows、Linux、macOS 上检查插件。自定义精简宿主至少需要 `agents`、`agentDefaultModel`、`tools` 服务，图片另需 `attachments` 服务与视觉模型。没有附件服务仍可使用文字，图片会返回明确提示。

## 前置条件

1. Node.js 22.6 或更高版本。
2. 已能运行 DeepSeek Harness，并配置了默认 provider/model。本项目支持 DSH `0.1.5-rc.2`和 `0.1.6-alpha.2`，使用 Cordis `4.0.2` / Schemastery `3.18.2`，两套版本分别测试。
3. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，取得 AppID 与 AppSecret。
4. 机器人已上线，或将需要测试的群和用户加入沙箱。

## 快速开始（源码使用）

在本项目目录执行：

```sh
npm ci
npm run setup
npm run doctor
```

向导会询问凭据来源、沙箱环境、群/用户白名单和工具权限，自动生成包含绝对插件路径的 `cordis.yml`。支持中文逗号、英文逗号或空白分隔列表，自动去重。AppSecret 输入不回显；已有文件不会被覆盖。需要另存时使用 `npm run setup -- --output qq.local.yml`，并自行将该文件加入忽略规则。

凭据可在向导中选择直接写入本地配置，也可使用环境变量（默认）。直接填写的配置优先于环境变量；空白值会回退到环境变量。环境变量必须在**启动 DSH 的终端或服务进程**中设置。本插件不会自动加载 `.env` 文件。

PowerShell：

```powershell
$env:QQ_BOT_APP_ID = '你的 AppID'
$env:QQ_BOT_APP_SECRET = '你的 AppSecret'
npm run doctor
```

Bash：

```sh
export QQ_BOT_APP_ID='你的 AppID'
export QQ_BOT_APP_SECRET='你的 AppSecret'
npm run doctor
```

启动已安装的 DSH：

```sh
dsh web --patch "/absolute/path/to/dsh-qq-bot/cordis.yml"
```

如果从 DSH 源码运行，在 **DSH 仓库目录**执行 `pnpm dsh web --patch "/absolute/path/to/dsh-qq-bot/cordis.yml"`。Windows 可使用 `D:/codex/dshqq/cordis.yml` 这样的绝对路径。

首次不知道 OpenID 时可留空白名单。启动后私聊机器人发送 `/whoami`，或在测试群中 @机器人并发送 `/whoami`，把返回的 OpenID 填入生成文件的 `allowUsers` / `allowGroups`。保存并确认插件已重载后即可聊天；沙箱测试群/用户还需要在 QQ 开放平台中添加。

### 安装为 DSH 插件 bundle

本包遵循 [DSH 官方打包规范](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)，提供 `dsh.bundle.patch` 和编译后的 JS 入口。先在源码目录构建并打包，再将本地 tarball 安装到你使用的 profile：

```sh
npm ci
npm pack
dsh plugin --profile qq add /absolute/path/to/dsh-qq-bot-0.3.2.tgz
npm run setup -- --bundle --output cordis.yml
npm run doctor
dsh --profile qq --patch /absolute/path/to/cordis.yml
```

先在该 profile 中配置 DSH 默认 provider/model。向导的 `--bundle` 模式生成对 `id: qq-bot` 的覆盖条目，避免与已安装 bundle 重复插入。源码模式生成插入条目，二者不要混用。已安装包也提供 `dsh-qq-bot setup` 和 `dsh-qq-bot doctor` 可执行入口，可通过安装环境的包管理器执行。

DSH 后续 patch 会**替换整个 config**，并非逐字段深合并；编辑覆盖层时应保留这一行所需的全部配置。发布包包含构建产物，使用 tarball 无需在安装时构建；直接从 GitHub 安装源码目前不作为推荐路径。

### 普通 DSH / 无桌面服务器

先安装并配置受支持版本的 DSH；本包复用它的模型与工具。下面从插件源码目录操作，生成独立的 QQ profile：

```sh
npm ci
npm pack
dsh plugin --profile qq add /absolute/path/to/dsh-qq-bot-0.3.2.tgz
npm run init -- --bundle --output cordis.yml
```

`init` 不要求交互终端，不读取或写入环境变量中的凭据，生成的配置默认仅允许白名单；已有文件会报错而不会覆盖。交互配置仍可用 `npm run setup -- --bundle`。在运行 DSH 的同一环境中设置前文的两个 QQ 凭据变量，然后检查并启动：

```sh
npm run doctor
dsh --profile qq --patch /absolute/path/to/cordis.yml
```

这个独立 profile 由官方 CLI 初始化为 base + QQ bundle，无需启动 Web 页面。先确认该运行环境的 DSH 默认 provider/model 已配置；原 Web profile 专属的模型设置不会自动复制到新 profile。也可把安装命令的 `qq` 改为已有的 profile，并用同名 profile 启动，以复用它的配置。

`DSH_HOME` 决定 DSH 配置与附件存储位置。安装与运行必须使用相同的 `DSH_HOME`、profile 和操作系统用户；服务器服务或容器需显式传入 QQ 凭据，持久化 DSH_HOME，并保持进程运行。QQ 使用出站 WebSocket/HTTPS 连接，不需要为本插件暴露入站端口。普通 DSH 的这些操作不需要 Desktop Next 的安装目录或管理脚本。

### 配置检查与排障

`npm run doctor`（自定义文件：`npm run doctor -- --output qq.local.yml`）离线检查 YAML、QQ 条目、凭据存在性、字段类型和数值范围，不打印凭据，不调用 QQ API。普通 YAML 配置受支持；含 `!!js` 的动态配置应交给 DSH 本身检查。

| 现象 | 处理方法 |
| --- | --- |
| 缺少 QQ 凭据 | 在运行 DSH 的进程设置两个环境变量，或重新生成到另一文件后填写凭据 |
| 普通消息无响应，但 /whoami 正常 | 将返回的 OpenID 加入白名单，不要填写 QQ 号/群号 |
| /whoami 也无响应 | 检查 QQ 沙箱名单、机器人权限、连接日志，以及 enableWhoami 是否关闭 |
| /tools 提示工具未加载 | 先安装对应宿主工具/MCP，并确认准确的注册名 |
| 对话创建失败 | 检查当前 DSH profile 的默认 provider/model 配置 |
| 修改源码后运行无变化 | 向导使用 lib/index.js，修改源码后执行 npm run build 并重载插件 |

旧的直接填写 `appId` / `clientSecret` 和 `src/index.ts` 加载方式仍兼容；手工配置可参考 `cordis.example.yml`。

### DSH Desktop Next（WSL）

插件必须安装在 Desktop Next 当前运行的 WSL 发行版和 active slot 的 `DSH_HOME` 中。Windows 的 `~/.dsh` 或其他 WSL 的 DSH 配置不会被它读取。使用该运行时自带的 `dsh plugin --profile web add <tarball>` 安装，不要另装一套 DSH 核心依赖。

QQ 配置保存在当前 slot 的 `home/profiles/web/cordis.patch.yml`，采用 `id: qq-bot` 覆盖条目。暂无凭据时设 `enabled: false`，填写 `appId` / `clientSecret`、沙箱设置和白名单后再改为 `true`。已有配置应先备份再合并，不能替换整个 profile 文件。桌面端环境变量与 Windows 终端独立，直接填写该本地文件更容易维护。

Desktop Next 的核心升级可能切换 active slot；升级后应确认新 slot 已迁移插件依赖及 QQ 配置。

## 安全默认值

`publicMode` 默认为 `false`。此时只有 `allowGroups` 和 `allowUsers` 中的 QQ 身份能够访问 Agent；两个列表均为空时，普通消息会被拒绝并输出警告。

为了方便首次配置，`enableWhoami` 默认开启。白名单外用户只能调用不经过 Agent 的固定 `/whoami`（或 `/id`）响应，不能访问模型或宿主工具。若不需要身份发现，可设置 `enableWhoami: false`。

### 获取 OpenID

1. 保持 `publicMode: false`、`enableWhoami: true`。
2. 私聊机器人发送 `/whoami`，取得当前机器人的 `user_openid`；或在群里 @机器人并发送 `/whoami`，取得 `group_openid`。
3. 直接复制回复中的 `allowUsers` 或 `allowGroups` 配置片段到 `cordis.yml`，然后重载插件。

OpenID 不是 QQ 号或群号，并且只对当前机器人 AppID 有效。

### 配置其他工具

QQ Agent 默认只拥有绑定到当前会话的 `qq_send(text)`。普通回答本身会自动回到 QQ；`qq_send` 成功调用后会直接结束本轮，不会再补发“已回复用户”一类确认消息。

`allowedTools` 是权限白名单，不负责安装工具。要开放联网搜索、文件读取等能力，需要：

1. 先在 DSH 宿主中安装并加载对应工具插件或 MCP 服务。
2. 将该工具注册到 DSH 时使用的**准确名称**逐项加入 `allowedTools`。
3. 重载本插件，在 QQ 中发送 `/tools` 检查它是“已放行并加载”还是“已配置但未加载”。

例如，只有当宿主中确实存在名为 `web_search` 的工具时，下面的配置才会生效：

```yaml
allowedTools:
  - web_search
```

若 `/tools` 显示“已配置但未加载”，通常是工具名不一致，或提供该工具的插件/MCP 服务尚未加载。

不要在公开机器人上开放 Shell、文件写入、任意网络请求或凭据相关工具。即使工具被后续热加载，运行时 guard 仍会拒绝未列入 `allowedTools` 的调用。

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 是否连接 QQ；桌面端首次安装可设为 `false`，填写凭据后再启用 |
| `appId` | 空字符串 | QQ 机器人 AppID；留空读取 `QQ_BOT_APP_ID` |
| `clientSecret` | 空字符串 | AppSecret；留空读取 `QQ_BOT_APP_SECRET`，界面按 secret 渲染 |
| `sandbox` | `false` | 使用 QQ 沙箱 API |
| `publicMode` | `false` | 允许所有 QQ 用户访问 |
| `allowGroups` | `[]` | 允许访问的 `group_openid` |
| `allowUsers` | `[]` | 允许访问的 `user_openid` |
| `enableWhoami` | `true` | 允许白名单外用户通过 `/whoami` 或 `/id` 查询当前 OpenID |
| `allowedTools` | `[]` | QQ Agent 可继承的、已由宿主注册的全局工具名 |
| `maxSessions` | `100` | 同时保留的最大 QQ 会话数 |
| `sessionIdleMinutes` | `60` | 空闲 Agent 自动销毁时间 |
| `enableImages` | `true` | 接收图片并交给模型 |
| `maxImagesPerMessage` | `4` | 同条消息图片数上限 |
| `maxImageBytes` | `10485760` | 单张图片字节上限 |
| `imageDownloadTimeoutMs` | `15000` | 一批图片下载超时 |
| `requestTimeoutMs` | `10000` | QQ REST API 请求超时 |

只有确认机器人和宿主工具适合公开访问时，才应设置 `publicMode: true`。

## 图片输入

私聊直接发送图片，群聊发送图片时 @机器人。支持纯图片、图文和同条消息多图；纯图片会自动请求模型分析内容。模型需支持图片输入，宿主需加载 DSH 附件存储服务（使用默认 base 的宿主提供；自定义宿主需自行加载）。

默认每条最多 4 张、单张 10 MiB，实际还受宿主图片限制约束。支持 PNG、JPEG、WebP、GIF；图片下载或解析失败会回复具体提示。`/stop`、`/new` 可取消尚未提交的图片下载。

## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 销毁当前 Agent；下一条消息建立新会话 |
| `/stop` | 取消当前任务并清空该 Agent 的排队消息 |
| `/tools` | 显示已放行且已加载、已配置但未加载的工具 |
| `/whoami`、`/id` | 返回当前 `user_openid` 或 `group_openid` 及可复制配置 |
| `/help` | 显示帮助 |

## 可靠性策略

- Agent 创建采用 single-flight，避免并发首条消息重复创建相同会话。
- 入站消息使用 QQ `msgId` 去重，并按 `userMessage.id → turn → assistantMessage` 路由回复。
- 被动回复的 `msg_seq` 按 `msgId` 独立递增；主动消息不携带 `msg_id/msg_seq`。
- `qq_send` 仅在发送成功后结束当前 Agent turn，避免模型再次生成发送确认。
- 超长文本按 Unicode code point 分片，不再截断丢失。
- Token 并发刷新合并为一个请求；401 会清理 Token 并重试一次。
- 网关采用指数退避，处理失效 Token、失效会话、限流和致命关闭码；心跳 ACK 丢失会主动重连。
- 插件卸载或 /new 时通过创建信号取消未完成的 Agent 创建；创建失败释放会话名额；空闲会话按 TTL 回收。

## 开发

```sh
npm run check
npm run pack:check
```

`npm run check` 会执行严格 TypeScript 检查、Node 22 原生 strip-only 导入检查、构建和单元测试。新增测试覆盖环境变量回退、整数范围、配置文件无损生成、覆盖保护和诊断输出。`erasableSyntaxOnly` 会在提交前拦截参数属性、枚举等需要转译的 TypeScript 语法；CI 重复运行相同检查。

## 已知限制

- 支持文本和图片输入；暂不支持语音、视频、文件及特殊表情消息。
- 网关 session/sequence 只保存在进程内；进程重启后重新 Identify。
- QQ 主动与被动消息均受开放平台配额和时效限制。
- DeepSeek Harness 仍在快速迭代，本包只声明已验证的 `0.1.5-rc.2` / `0.1.6-alpha.2`；请勿将同一宿主的 DSH 包混装为不同版本。

## License

MIT

开发依据：[插件配置](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config)、[本地插件路径与生命周期](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)、[打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。
