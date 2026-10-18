# 架构说明

## 为什么监控器必须独立于 DSH

如果守护逻辑作为 DSH 的插件运行，它会和 DSH 共享同一个进程与生命周期：

```text
DSH 进程 ── 插件（监控器）── 一起崩溃
```

崩溃之后，没有任何东西能把 DSH 拉起来。因此本项目采用两层结构：

```text
┌─────────────────────────────┐
│  Guardian 面板 (WinForms)   │  只读状态、发送命令
└──────────────┬──────────────┘
               │ 命令行 / 命令队列
┌──────────────▼──────────────┐
│  Guardian 守护进程 (Node)    │  独立于 DSH，持续运行
│  · 健康检查                  │
│  · profile 指纹               │
│  · 快照 / 试用期 / 回滚       │
└──────────────┬──────────────┘
               │ taskkill / 启动 / 恢复文件
┌──────────────▼──────────────┐
│  DSH (Electron + Agent 宿主) │
└─────────────────────────────┘
```

## 进程模型

DSH 桌面版至少有这几类进程（名称都为 `DeepSeek Harness.exe`）：

| 角色 | 识别方式 |
| --- | --- |
| Electron 主进程 | 命令行没有 `--type=`、没有 `dsh-desktop-host` |
| Agent 宿主 | 命令行包含 `dsh-desktop-host\lib\index.js` |
| GPU / Renderer / Utility | 命令行包含 `--type=` |

健康检查同时看：

1. 主进程是否存在；
2. Agent 宿主是否存在；
3. 宿主监听的本地端口；
4. 对 `http://127.0.0.1:<port>/` 发起请求（401 也算存活）。

只有“进程在 + 端口在 + HTTP 有响应”才算健康。查询失败（PowerShell/CIM 异常）会被标记为 `unknown`，不会误判成崩溃。

## profile 指纹

`lib/profile.mjs` 采集：

- 根目录清单文件：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml`、`compatibility.json`、`.npmrc`、`pnpmfile.cjs` 以及根目录 `*.yml/*.yaml`。
- 每个文件的 SHA-256。
- `node_modules` 顶层包名（含 `@scope/name`），不包含目录 mtime。

指纹 = 文件哈希 + 依赖表 + 组合包列表 + `node_modules` 包名签名。

**为什么不把目录 mtime 计入指纹**：回滚只能恢复文件内容，无法恢复目录时间；如果 mtime 参与指纹，回滚后会被误判为“又发生了一次变更”。包的新增/移除会改变包名列表，已经足够检测插件安装。

## 状态机

```text
init → stable
         │ 指纹变化（安装/启用插件、改配置）
         ▼
      awaiting ──(DSH 重启并健康)──► probation ──(试用通过)──► stable + 新基线
         │                              │
         │ 启动失败/超时/崩溃            │ 崩溃/无响应
         └──────────────┬───────────────┘
                        ▼
                   rolling-back
                        │
             恢复基线快照 + 隔离新依赖
                        │
                  重启 DSH + 健康检查
                    │            │
                  成功          失败
                    │            └──► attention（需要人工处理）
                    ▼
                 stable
```

`lib/decide.mjs` 是一个纯函数状态机：输入状态、健康、profile、配置，输出动作列表。`lib/supervisor.mjs` 负责执行动作（落盘、启停、回滚、通知）。这样决策可以离线自检，不必真的杀 DSH。

## 自动健康快照与保留策略

守护进程维护一个独立的周期计时器：

- `autoSnapshotHours`（默认 12）决定间隔；
- `autoSnapshotRetention`（默认 1）决定保存后保留多少个快照；
- `autoSnapshotMinHealthyMs`（默认 60 秒）避免刚启动就抓取不一致状态。

触发条件必须同时满足：DSH 健康、profile 稳定、没有候选插件/试用期、没有未处理提醒、连续健康时间达标、计时到期。

执行顺序：

1. 创建新快照；
2. 将其设为当前基线并写入历史；
3. 按 retention 删除旧快照（默认只留最新）；
4. 重置下一次计时；
5. 写日志/状态/通知。

手动快照、插件试用通过、回滚成功都会调用 `rememberHealthyVersion()`，从当下重新计时，避免刚保存过又立即触发。快照只包含 profile 清单，不包含会话、凭据或工作区。

---

## 快照与回滚

快照只保存 profile 根目录的**清单文件**，不保存会话、凭据、工作区或整个 `node_modules`。

回滚步骤：

1. 生成事件报告（证据先于动作）。
2. 停止 DSH 进程树。
3. 恢复快照中的每个清单文件，删除“当前有、快照没有”的根目录清单文件。
4. 对比依赖表，把新增依赖从 `node_modules` 移到 `quarantine/<事件ID>/`。
5. 如果基线本来没有 `node_modules`，清理隔离后留下的空目录。
6. 启动 DSH 并等待健康；失败则尝试上一个历史基线。
7. 成功后把恢复后的状态记为新的基线，写报告并通知。

## 为什么默认不自动验证

插件安装后，DSH 通常需要重启才会真正加载新配置。守护会先进入 `awaiting`，不把“未加载”误判为“已通过”。

- `autoVerify=false`（默认）：等你手动重启，或点击面板“安全重启并验证插件”。
- `autoVerify=true`：检测到变更稳定后，守护主动安全重启 DSH 并验证；失败自动回滚。

默认关闭是为了避免你正在对话时被突然重启打断。需要全自动闭环时在面板左下勾选即可。

## 目录职责

```text
guardian.mjs          CLI 入口
lib/config.mjs        配置、路径、默认值
lib/proc.mjs          进程查询、健康检查、启停、等待
lib/profile.mjs       profile 指纹与差异
lib/snapshot.mjs      快照创建/恢复/清理
lib/decide.mjs        纯状态机
lib/supervisor.mjs    守护循环与动作执行
lib/incident.mjs      证据收集与报告
lib/commands.mjs      CLI ↔ 守护命令队列
lib/state.mjs         状态/状态文件
lib/notify.mjs        桌面通知
panel/                WinForms 控制面板
test/                 模拟 DSH 端到端测试
```

## 已知边界

- 只检测进程级健康；UI 内部静默报错不会被识别。
- 回滚会重启 DSH，当前对话会中断（会话持久化）。
- 守护必须先运行；它自己的崩溃不会被自动恢复。
- HMR 开启时插件可能热加载；若一直不重启，守护会停留在 `awaiting`，不会错误推进基线。
- 自动健康快照默认只保留最新 1 个，旧快照会被删除；需要更多历史时调大 `autoSnapshotRetention`。
- 事件报告保存在本机，可能包含路径和包名。
