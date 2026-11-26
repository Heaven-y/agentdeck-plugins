# 插件 SDK

浏览器接口由 AgentDeck 注入，无需打包运行库。TypeScript 项目引用 `browser.d.ts` 获取 `window.agentdeck` 类型。本机后端使用 `backend.mjs` 的 `definePlugin`，实现初始化、请求和资源释放；不需要自行处理进程消息。

此目录也是无依赖的 `@agentdeck/plugin-sdk` 包，可复制到插件项目，或在此执行 `npm pack` 后安装生成的包。浏览器类型从 `@agentdeck/plugin-sdk/browser` 导入，后端从 `@agentdeck/plugin-sdk/backend` 导入。

```ts
import type {} from '@agentdeck/plugin-sdk/browser';

window.agentdeck.onCommand(async (id) => {
  if (id !== 'insert') return;
  const draft = await window.agentdeck.composer.get();
  await window.agentdeck.composer.set({ text: `${draft.text}\n继续处理`, revision: draft.revision });
});
```

```ts
import { definePlugin } from '@agentdeck/plugin-sdk/backend';

definePlugin({
  async initialize(context) {
    return { projects: await context.host.request({ method: 'projects.list' }) };
  },
  async request(state, input, signal) {
    signal.throwIfAborted();
    return { status: 200, body: state.projects };
  },
});
```

清单分别声明所需权限。例如上述后台读取项目需要 `projects`，输入框操作需要 `composer`。完整清单、贡献位置、事件、分页及生命周期见[宿主契约](https://github.com/Heaven-y/agentdeck/blob/main/docs/engineering/workbench-plugins.md)。

命令按顺序执行。后台命令不会打开页面；命令触发后切换会话，或读取草稿后用户继续输入，旧命令的草稿修改会被拒绝。事件只携带会话身份和运行状态；订阅函数返回取消订阅方法。UI 事件来源是当前工作台已连接的会话，不会重放应用关闭期间的事件。

`session.list()` 返回已打开标签的身份，openId 在关闭重开时更新。声明 `session-control` 后，可用 `session.resume({conversationId, requestId, text})` 续接其中的空闲会话；requestId 使用稳定 UUID，服务端受理后 accepted 才为 true，待确认时重复同一 ID 不重发，草稿和当前页面保持原状。需要删除联动的后端声明 `sessionLifecycle: true`，处理 `/_agentdeck/lifecycle` 的通知；具体事件和失败行为以宿主契约为准。

原生 CLI 插件的短命令通过 `contributes.nativeCommands` 声明所需 agent 和 name，仍需 session-control 权限；宿主核对唯一已启用声明后原样转交，不展开或解释业务正文。
