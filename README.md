# dsh-qq-bot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：通过 QQ 开放平台官方 WebSocket 网关和 REST API，将 QQ 群聊与单聊连接到独立的 dsh Agent。

- 不依赖第三方机器人框架，使用 Node.js 内置 `WebSocket` 和 `fetch`
- 每个 QQ 群或用户拥有独立 Agent 会话
- 支持 `/new`、`/stop`、`/tools`、`/help`，并可用 `/whoami` 自助发现 OpenID
- 消息按 Harness turn 精确关联，网关重连事件自动去重
- 主动消息和被动回复使用不同的 QQ 请求格式
- QQ Agent 默认不继承宿主工具，`qq_send` 只能发送到当前会话

## 前置条件

1. Node.js 22.6 或更高版本。
2. 已能运行 DeepSeek Harness，并配置了默认 provider/model。
3. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，取得 AppID 与 AppSecret。
4. 机器人已上线，或将需要测试的群和用户加入沙箱。

## 安装与加载

安装固定版本的开发依赖：

```sh
npm ci
```

通过 Cordis overlay 加载源码插件：

```yaml
# cordis.yml（已被 .gitignore 忽略，请勿提交 AppSecret）
- insert:
    - id: qq-bot
      name: '/absolute/path/to/dsh-qq-bot/src/index.ts'
      config:
        appId: 'YOUR_APP_ID'
        clientSecret: 'YOUR_APP_SECRET'
        sandbox: false
        publicMode: false
        allowGroups: ['GROUP_OPENID_1']
        allowUsers: ['USER_OPENID_1']
        enableWhoami: true
        allowedTools: []
```

```sh
pnpm dsh web --patch ./cordis.yml
```

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
| `appId` | 必填 | QQ 机器人 AppID |
| `clientSecret` | 必填 | QQ 机器人 AppSecret；在配置界面按 secret 渲染 |
| `sandbox` | `false` | 使用 QQ 沙箱 API |
| `publicMode` | `false` | 允许所有 QQ 用户访问 |
| `allowGroups` | `[]` | 允许访问的 `group_openid` |
| `allowUsers` | `[]` | 允许访问的 `user_openid` |
| `enableWhoami` | `true` | 允许白名单外用户通过 `/whoami` 或 `/id` 查询当前 OpenID |
| `allowedTools` | `[]` | QQ Agent 可继承的、已由宿主注册的全局工具名 |
| `maxSessions` | `100` | 同时保留的最大 QQ 会话数 |
| `sessionIdleMinutes` | `60` | 空闲 Agent 自动销毁时间 |
| `requestTimeoutMs` | `10000` | QQ REST API 请求超时 |

只有确认机器人和宿主工具适合公开访问时，才应设置 `publicMode: true`。

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
- 插件卸载时等待所有 Agent 完成销毁，空闲会话按 TTL 回收。

## 开发

```sh
npm run check
npm run pack:check
```

`npm run check` 会执行严格 TypeScript 检查、Node 22 原生 strip-only 导入检查和单元测试。`erasableSyntaxOnly` 会在提交前拦截参数属性、枚举等需要转译的 TypeScript 语法；CI 重复运行相同检查。

## 已知限制

- 当前仅处理文本，未解析图片、表情和富媒体。
- 网关 session/sequence 只保存在进程内；进程重启后重新 Identify。
- QQ 主动与被动消息均受开放平台配额和时效限制。
- DeepSeek Harness 仍在快速迭代，本包暂时将整套 DSH peer dependency 固定到同一 release candidate。

## License

MIT
