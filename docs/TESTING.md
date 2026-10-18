# 测试说明

本项目有两层测试：**纯离线自检** 和 **模拟 DSH 的端到端演练**。两者都不会接触真实的 DSH 进程或真实 profile。

## 1. 离线自检

```powershell
node guardian.mjs selftest
```

在临时目录里创建假 profile，验证：

1. profile 指纹与清单采集；
2. 快照创建；
3. 新增插件依赖/组合包/文件变化的检测；
4. 启动失败后恢复到安装前快照；
5. 回滚时隔离新增依赖并清理空的 `node_modules`；
6. `node_modules` 目录时间变化不会误报；
7. 稳定 → 检测变更 → 试用 → 通过；
8. 试用期崩溃触发回滚；
9. 有 Windows 崩溃证据时，等待中的插件也会回滚；
10. 主动退出（无崩溃证据）不自动回滚；
11. 诊断查询失败（`unknown`）不会被当成崩溃；
12. 12 小时到期会触发自动健康快照；
13. 自动快照清理只保留指定数量。

预期输出结尾：

```text
结果：13/13 通过，全部正常。
```

也可以输出 JSON：

```powershell
node guardian.mjs selftest --json
```

## 2. 模拟 DSH 端到端演练

```powershell
node test/fake-rollback-test.mjs
```

测试会：

1. 用 `csc.exe`（.NET Framework）编译一个临时的 `FakeDsh.exe`；
2. 让它监听随机端口、模拟 Agent 宿主进程，并被守护识别为健康；
3. 启动守护并建立基线；
4. 安装一个假插件，让下一次启动失败 → 验证自动回滚；
5. 再安装一个假插件，让它在启动成功 5 秒后崩溃 → 验证试用期内回滚；
6. 校验 profile 恢复、DSH 重新健康、事件报告生成、计数器正确。

预期输出包含：

```json
{ "ok": true, "checks": { "...": true } }
```

测试只在 `%TEMP%` 下工作，不会停止或重启真实 DSH，也不会修改真实 profile。

### 依赖

- Windows；
- .NET Framework 4.x 的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（Windows 自带）；
- Node.js 22+（项目运行时自带 Node 24 也可）。

如果只想验证守护逻辑、不想编译假应用，运行 `selftest` 即可。

## 3. 手工验收（真实 DSH）

在确认会话已保存后，可以双击桌面「DSH 守护者」：

1. 确认面板显示“运行正常 / 守护中 · 稳定”；
2. 点「记录为良好版本」；
3. 点「安全重启并验证插件」；
4. 观察 DSH 重启后是否进入“试用期”，以及守护是否在失败时回滚。

> 真实重启会中断当前对话；DSH 会话是持久化的，重启后从会话列表继续。
