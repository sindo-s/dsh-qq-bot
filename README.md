# dsh-qq-bot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 **QQ 官方机器人（QQ 开放平台 Bot API）** 桥接到 dsh agent。

- 零第三方机器人框架——直接实现官方 WebSocket 网关 + REST API（Node.js >= 22 内置 `WebSocket` / `fetch`）
- 群聊 @机器人、单聊（C2C）消息 → 喂给指定 dsh 会话
- agent 的回复 → 自动发回 QQ
- 向模型暴露 `qq_send` 工具，支持主动发消息

## 前置条件

1. **Node.js >= 22**（需要内置 `WebSocket`）
2. 在 [QQ 开放平台](https://q.qq.com) 注册开发者并创建机器人，拿到 **AppID** 和 **AppSecret**
3. 机器人需要通过审核上线，或使用**沙箱环境**（开发期）：
   - 沙箱模式下只有加入沙箱测试的群/用户能触发机器人
   - 群聊场景需要机器人被拉进群并 @它
4. 已能运行 dsh（见官方仓库 README 的 run-from-source 路径）

## 安装与加载

在本仓库目录准备好插件后，用 cordis overlay 加载：

```yaml
# cordis.yml
- insert:
    - id: qq-bot
      name: '/absolute/path/to/dsh-qq-bot/src/index.ts'
      config:
        appId: '你的 AppID'
        clientSecret: '你的 AppSecret'
        sessionId: 'qq-bridge'
        sandbox: false
```

```sh
pnpm dsh web --patch ./cordis.yml
```

配置字段经 Schemastery 校验，缺 `appId` / `clientSecret` / `sessionId` 会在加载时直接报错。

## 配置项

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `appId` | ✅ | — | QQ 开放平台机器人 AppID |
| `clientSecret` | ✅ | — | QQ 开放平台机器人 AppSecret |
| `sessionId` | ✅ | — | 桥接到的 dsh 会话 ID |
| `sandbox` | 否 | `false` | 使用沙箱 API 域名 |
| `allowGroups` | 否 | `[]` | 群聊白名单（group_openid），空为全部响应 |
| `allowUsers` | 否 | `[]` | 单聊白名单（user_openid），空为全部响应 |

## 工作原理

- **入站**：网关 `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` 事件 → `ctx.agents.get(sessionId).followup()`，消息前带 `[QQ 群 xxx]` / `[QQ 单聊 xxx]` 前缀方便模型区分来源
- **出站**：监听 `session/event` 的已提交 assistant 消息 → 通过被动回复接口（携带 `msg_id` + 自增 `msg_seq`）发回最近活跃的 QQ 会话
- **工具**：`qq_send(target, kind, text)`，模型可主动向任意群/用户发消息
- **生命周期**：网关连接注册为 `ctx.effect()`，插件热重载/卸载时自动断开，符合 Cordis 规范

## 已知限制

- **单会话桥接**：当前所有 QQ 消息都进入同一个 dsh 会话（`sessionId`），回复发到最近活跃的 QQ 会话。多会话路由待后续版本。
- **被动回复额度**：官方被动回复依赖 `msg_id` 凭证，每月有额度限制；主动消息有日限额。高频场景注意配额。
- **纯文本**：图片、表情、富媒体消息未做解析，非文本内容会被忽略。
- **开发者预览**：dsh 处于 developer preview，`ctx.agents` / `session/event` 等 API 可能有破坏性变更，升级 dsh 后请验证。

## License

MIT
