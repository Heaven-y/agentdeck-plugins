# AgentDeck Plugins

AgentDeck 的可选工作台扩展。每个扩展放在 `plugins/<name>`，维护自己的插件清单、依赖、测试和构建产物，可独立安装和更新。

| 扩展                                               | 用途                                  | 接口版本 |
| -------------------------------------------------- | ------------------------------------- | -------- |
| [SSH 控制台](plugins/ssh-console/README.md)        | SSH 服务器、资源、文件和终端          | v2       |
| [Codex 委派](plugins/agy-codex-delegate/README.md) | AGY 分派、问答、返修和验收 Codex 任务 | v2       |

## 开发

需要 Node.js 22+。仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

构建产物在各插件的 `dist` 目录。安装步骤与功能说明见各插件文档。宿主的版本化通信契约见 [AgentDeck 工作台插件](https://github.com/Heaven-y/agentdeck/blob/main/docs/engineering/workbench-plugins.md)。

开发扩展使用[插件 SDK](sdk/README.md)。[项目助手示例](examples/project-helper/README.md)无需本机后端，演示页面、设置、输入与会话操作及事件，可直接安装其目录。
