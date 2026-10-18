# 安全说明

DSH 守护者是一个**在本机以当前用户权限运行**的守护进程。它需要在 DSH 崩溃后执行恢复动作，因此拥有比你日常使用的普通脚本更大的权限。请在运行前阅读本页。

## 它会做什么

- 读取 DSH profile 目录中的清单文件，计算哈希并复制快照。
- 查询 Windows 进程列表、监听端口，并访问 `http://127.0.0.1:<port>/` 做健康检查。
- 在需要回滚时调用 `taskkill /PID <pid> /T /F` 停止 DSH 进程树。
- 启动 `config.json` 中配置的 `appExe`。
- 恢复 profile 清单文件，并把新增的 `node_modules` 依赖移到隔离目录。
- 可选地弹出 Windows 通知，并写入本机日志/事件报告。
- 读取 Windows Application 事件日志，用于区分“崩溃退出”和“主动退出”。

## 它不会做什么

- 不会读取或修改会话内容、账号凭据、工作区代码。
- 不会主动访问互联网（不包含任何遥测、上传或远程控制）。
- 不会绕过 DSH 的插件安装流程；它只观察 profile 的变化。
- 不会以管理员身份运行，也不请求提权。

## 敏感数据

以下内容可能出现在日志或事件报告中：

- 本机绝对路径、用户名、DSH profile 路径。
- 插件包名、版本、pnpm 输出。
- Windows 崩溃事件的错误文本。

报告默认保存在 `%USERPROFILE%\.dsh-guardian\incidents\`，不会自动上传。分享报告前请自行检查。

**不要提交** `config.json`、`%USERPROFILE%\.dsh-guardian\` 或 `session-backups\` 到公开仓库。仓库的 `.gitignore` 已排除本地 `config.json`。

## 运行前检查

1. 确认 [config.json](config.example.json) 中的 `appExe`、`profileDir`、`dshHome` 指向你自己的安装。
2. 确认 `taskkill` / 启动 DSH 的行为符合你的预期。
3. 首次使用建议先用演练模式观察：

   ```powershell
   node guardian.mjs start --dry-run
   ```

4. 不要在共享账号或无人值守的生产环境中使用自动回滚，除非你明确知道它会在失败时重启 DSH。

## 报告问题

如果发现安全问题，请在仓库中开一个 Issue，或直接联系仓库维护者。请勿在公开 Issue 中粘贴 token、凭据或完整会话内容。
