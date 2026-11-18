# Changelog

## 1.2.0 — 2026-11-18

- 修复误判：进程查询看不到 Agent 宿主进程时（守护重启后、或 DSH 由资源管理器/管理员权限启动），改为先对已发现的端口做 HTTP 探测；能响应就判为 `healthy`，不再直接判 `degraded`。
- 修复自动重启误杀：`service-degraded` 自动重启现在要求**探测实际失败**（排除 `Agent 宿主进程未运行` 这类记账失败）且 `consecutiveUnhealthy >= failureThreshold`，避免杀掉本来健康的会话。
- 运行时与 CLI 版本号同步为 `1.2.0`；`User-Agent` 更新为 `dsh-guardian/1.2`。
- 本机 `config.json` 已改为 `observeOnly: true`（只观察、不自动重启），作为额外保险。

## 1.1.0 — 2026-10-18

- 新增**每 12 小时自动保存健康版本**：条件满足时创建新基线并重置倒计时。
- 新增自动清理：按 `autoSnapshotRetention`（默认 1）删除旧快照，只保留最新版本。
- 新增配置：`autoSnapshotEnabled`、`autoSnapshotHours`、`autoSnapshotRetention`、`autoSnapshotMinHealthyMs`。
- 手动快照、试用通过、回滚成功后会重置自动快照计时。
- 离线自检增加自动快照与清理测试，共 13 项。
- 运行时与 CLI 版本号同步为 `1.1.0`。

## 1.0.3 — 2026-10-18

- 添加声明：该项目为 DeepSeekV4.1flash 模型生成，仅用于个人测试用途。
- 新增 `DISCLAIMER.md`，并同步到 README 与 `package.json` 描述。
- 运行时与 CLI 版本号同步为 `1.0.3`；无功能变更。

## 1.0.2 — 2026-10-18

- 从 `1.0.2` 起改用 **Apache License 2.0**；`1.0.1` 仍按 MIT 发布，`1.0.0` 为更早的未附许可证版本。旧版本不被覆盖。
- 新增 `NOTICE`。
- 运行时与 CLI 版本号同步为 `1.0.2`。

## 1.0.1 — 2026-10-18

- 添加 MIT License。
- `package.json` 增加 `license` 字段。
- 运行时与 CLI 版本号同步为 `1.0.1`。

## 1.0.0 — 2026-10-18

首个可用版本。

- 外部守护进程：不依赖 DSH 存活，DSH 崩溃后仍可恢复。
- profile 快照：记录 `package.json`、`cordis*.yml`、锁文件、`compatibility.json` 等清单。
- 插件变更检测：基于文件哈希 + `node_modules` 包名签名，忽略目录 mtime 噪音。
- 加载后试用期：默认 3 分钟；启动失败、崩溃或服务无响应时自动回滚。
- 回滚：停止 DSH → 恢复良好快照 → 隔离新增依赖 → 重启并验证健康。
- 证据报告：进程、端口、HTTP、profile diff、pnpm 日志、Windows 崩溃事件和时间线。
- WinForms 控制面板：启动/停止守护、立即快照、安全重启验证、手动回滚、日志与报告入口。
- 桌面快捷方式 + 登录自启脚本。
- 离线自检 11 项；模拟 DSH 端到端测试覆盖“启动失败回滚”和“试用期崩溃回滚”。
