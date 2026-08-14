# dsh-qq-bot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：通过 QQ 开放平台官方 WebSocket 网关和 REST API，将 QQ 群聊与单聊连接到独立的 dsh Agent。

- 不依赖第三方机器人框架，使用 Node.js 内置 `WebSocket` 和 `fetch`
- 每个 QQ 群或用户拥有独立 Agent 会话
- 支持 `/new`、`/stop`、`/help`，并可用 `/whoami` 自助发现 OpenID
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

QQ Agent 默认只拥有绑定到当前会话的 `qq_send(text)`。如确实需要让模型调用宿主的其他全局工具，必须逐项加入 `allowedTools`：

```yaml
allowedTools: ['web_search']
```

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
| `allowedTools` | `[]` | QQ Agent 可继承的宿主全局工具名 |
| `maxSessions` | `100` | 同时保留的最大 QQ 会话数 |
| `sessionIdleMinutes` | `60` | 空闲 Agent 自动销毁时间 |
| `requestTimeoutMs` | `10000` | QQ REST API 请求超时 |

只有确认机器人和宿主工具适合公开访问时，才应设置 `publicMode: true`。

## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 销毁当前 Agent；下一条消息建立新会话 |
| `/stop` | 取消当前任务并清空该 Agent 的排队消息 |
| `/whoami`、`/id` | 返回当前 `user_openid` 或 `group_openid` 及可复制配置 |
| `/help` | 显示帮助 |

## 可靠性策略

- Agent 创建采用 single-flight，避免并发首条消息重复创建相同会话。
- 入站消息使用 QQ `msgId` 去重，并按 `userMessage.id → turn → assistantMessage` 路由回复。
- 被动回复的 `msg_seq` 按 `msgId` 独立递增；主动消息不携带 `msg_id/msg_seq`。
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
