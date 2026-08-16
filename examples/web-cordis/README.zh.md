# web-cordis

[English](README.md) | 中文

[`@roos-code/roos-code-tool-cordis`](../../packages/extensions/tool-cordis/README.md) 的自指示例。agent（智能体）可以检查当前 Cordis 进程，并在内存中挂载或卸载模型编写的插件。临时插件会在卸载或进程退出时消失，并可能影响同一进程中的其他会话。激活 Host 半会在任何 Host 代码运行之前，通过会话审批通道对该 Session 中的每个 Plugin 询问一次（唯一许可是 `allowed-once`）；Web UI 回答这次询问。Client 半的包仍使用现有的页面审批卡片。必须跳过 Host 半询问的无人值守组合，应把已铸造的 Plugin id 列在 `cordis-host-runner.hostActivationAllowlist` 上。

## 运行

启动浏览器界面：

```sh
pnpm run demo:cordis
```

改为启动 ACP（Agent Client Protocol）自动化服务器：

```sh
pnpm run demo:cordis acp
```

这两条命令都需要 `DEEPSEEK_API_KEY`。[Cordis 工具参考](../../packages/extensions/tool-cordis/README.md)定义了四类约定：工具参数、存续时间、清理行为和安全性。
