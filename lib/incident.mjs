import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, ensureDir, readJsonSafe, shortId, tailFile, writeJsonAtomic, writeTextAtomic, runPowerShell, parseJsonOutput } from './util.mjs';
import { diffProfileAgainstMeta } from './profile.mjs';

function psQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

export async function checkCrashEvidence(config, { minutes = 20 } = {}) {
  const script = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddMinutes(-${Math.max(1, Math.round(minutes))})
$name = ${psQuote(config.appProcessName)}
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -MaxEvents 300 |
  Where-Object {
    ($_.ProviderName -match 'Application Error|Windows Error Reporting|.NET Runtime') -and
    ($_.Message -match [regex]::Escape('DeepSeek Harness') -or $_.Message -match [regex]::Escape($name))
  } |
  Select-Object -First 8 |
  ForEach-Object {
    [pscustomobject]@{
      time = $_.TimeCreated.ToString('o')
      id = $_.Id
      provider = $_.ProviderName
      level = $_.LevelDisplayName
      message = $(if ($_.Message) { $_.Message.Substring(0, [Math]::Min(900, $_.Message.Length)) } else { '' })
    }
  })
[pscustomobject]@{ events = $events } | ConvertTo-Json -Depth 5 -Compress
`;
  try {
    const { stdout } = await runPowerShell(script, { timeoutMs: 20000 });
    const data = parseJsonOutput(stdout);
    const events = Array.isArray(data?.events) ? data.events : data?.events ? [data.events] : [];
    return { found: events.length > 0, events, error: null };
  } catch (error) {
    return { found: false, events: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function copyIfExists(source, destination) {
  try {
    await ensureDir(path.dirname(destination));
    await fs.copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

function renderEvents(events) {
  if (!events?.length) return '_未发现 Windows 应用程序错误日志。_';
  return events
    .map((event) => {
      const text = String(event.message ?? '')
        .replace(/\r/g, '')
        .split('\n')
        .slice(0, 10)
        .join('\n');
      return `- **${event.time ?? '未知时间'}** · ${event.provider ?? '?'} · 事件 ${event.id ?? '?'}\n\n\`\`\`\n${text}\n\`\`\``;
    })
    .join('\n');
}

export async function collectIncident({
  paths,
  config,
  state,
  health,
  profile,
  baselineSnapshot,
  kind,
  reason,
  crashEvidence,
  timeline = [],
  extra = {},
  logger,
}) {
  const id = shortId('inc');
  const dir = path.join(paths.incidentsDir, id);
  await ensureDir(dir);
  const baselineMeta = baselineSnapshot ?? null;
  const diff = baselineMeta ? diffProfileAgainstMeta(baselineMeta, profile) : null;
  const createdAt = Date.now();

  const evidence = {
    id,
    createdAt,
    createdAtIso: nowIso(),
    kind,
    reason,
    guardianVersion: extra.guardianVersion ?? null,
    dryRun: Boolean(config.dryRun),
    observeOnly: Boolean(config.observeOnly),
    app: health ?? null,
    candidate: state.candidate ?? null,
    baseline: baselineMeta
      ? { id: baselineMeta.id, createdAt: baselineMeta.createdAt, fingerprint: baselineMeta.fingerprint }
      : null,
    profile: profile
      ? {
          dir: profile.dir,
          fingerprint: profile.fingerprint,
          files: profile.files,
          deps: profile.deps,
          bundles: profile.bundles,
          nodeModules: profile.nodeModules,
          latestOperation: profile.latestOperation,
          packageError: profile.packageError,
        }
      : null,
    diff,
    crashEvidence: crashEvidence ?? null,
    state: {
      phase: state.phase,
      paused: state.paused,
      counters: state.counters,
      lastRollback: state.lastRollback,
      lastIncident: state.lastIncident,
    },
    extra,
  };
  await writeJsonAtomic(path.join(dir, 'evidence.json'), evidence);

  const profileDiffText = diff
    ? [
        `新增依赖: ${diff.addedDeps.join(', ') || '(无)'}`,
        `移除依赖: ${diff.removedDeps.join(', ') || '(无)'}`,
        `版本变化: ${diff.changedDeps.join(', ') || '(无)'}`,
        `新增组合包: ${diff.addedBundles.join(', ') || '(无)'}`,
        `移除组合包: ${diff.removedBundles.join(', ') || '(无)'}`,
        `新增文件: ${diff.addedFiles.join(', ') || '(无)'}`,
        `移除文件: ${diff.removedFiles.join(', ') || '(无)'}`,
        `修改文件: ${diff.changedFiles.join(', ') || '(无)'}`,
        `摘要: ${diff.summary}`,
        '',
        `基线快照: ${baselineMeta?.id ?? '(无)'}`,
        `当前 profile: ${profile?.dir ?? '(未知)'}`,
      ].join('\n')
    : '没有基线快照，无法比较 profile。';
  await writeTextAtomic(path.join(dir, 'profile-diff.txt'), profileDiffText);

  if (profile?.latestOperation?.log?.path) {
    await copyIfExists(profile.latestOperation.log.path, path.join(dir, 'pnpm.log'));
  }
  const logTail = await tailFile(paths.logPath, 96 * 1024);
  await writeTextAtomic(path.join(dir, 'guardian.log.tail.txt'), logTail);
  await writeJsonAtomic(path.join(dir, 'state.json'), state);

  const options = [
    (config.appExe ? `- 手动启动 DSH：\`${config.appExe}\`` : null),
    `- 查看守护日志：\`${paths.logPath}\``,
    '- 在守护面板中点击「回滚到最近良好版本」可再次回滚。',
    '- 如果回滚后仍无法启动，可在插件页禁用最近安装的插件，或运行 `dsh plugin --profile %s remove <包名>`。'.replace('%s', config.profile),
  ].filter(Boolean);

  const lines = [
    `# DSH 守护事件报告 · ${id}`,
    '',
    `- 时间：${new Date(createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    `- 类型：${kind}`,
    `- 原因：${reason ?? '未提供'}`,
    `- 阶段：${state.phase}`,
    `- 当前 DSH：${health?.state ?? 'unknown'}${health?.error ? `（${health.error}）` : ''}`,
    `- 基线快照：${baselineMeta ? `${baselineMeta.id}（${new Date(baselineMeta.createdAt).toLocaleString('zh-CN', { hour12: false })}）` : '无'}`,
    '',
    '## 结论',
    '',
    diff && diff.pluginNames.length
      ? `本次变更涉及：**${diff.pluginNames.join(', ')}**。${reason?.includes('回滚') ? '守护已按策略回滚到变更前的良好快照。' : '守护已记录该变更，后续启动异常将回滚到变更前的良好快照。'}`
      : '本次事件未识别出新增插件依赖；可能是配置修改、手动编辑或非插件原因。',
    '',
    '## 变更摘要',
    '',
    `\`\`\`\n${diff ? diff.summary : '无基线对比'}\n\`\`\``,
    '',
    '## 证据',
    '',
    `- health.state = ${health?.state ?? 'unknown'}`,
    `- 主进程 PID = ${health?.mainPid ?? '无'}`,
    `- Agent 宿主 PID = ${health?.hostPid ?? '无'}`,
    `- Web 端口 = ${health?.port ?? '无'}`,
    `- HTTP 状态 = ${health?.httpStatus ?? '无'}`,
    `- 错误 = ${health?.error ?? '无'}`,
    `- 连续异常次数 = ${state.app?.consecutiveUnhealthy ?? 0}`,
    `- 守护模式 = ${config.observeOnly ? '仅观察' : config.dryRun ? '演练' : '主动保护'}`,
    '',
    '### Windows 崩溃记录',
    '',
    renderEvents(crashEvidence?.events),
    '',
    '### 最近事件',
    '',
    ...(timeline.length
      ? timeline.map((entry) => `- ${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })} · [${entry.code}] ${entry.message}`)
      : ['_无_']),
    '',
    '## 操作与后续',
    '',
    ...options,
    '',
    `证据文件：\`${path.join(dir, 'evidence.json')}\``,
    '',
  ];
  const reportPath = path.join(dir, 'incident.md');
  await writeTextAtomic(reportPath, lines.join('\n'));
  await logger?.info('incident.created', '已生成事件报告', { id, kind, reason, report: reportPath });
  return { id, dir, reportPath, evidence };
}

export async function listIncidents(paths, limit = 10) {
  try {
    const entries = await fs.readdir(paths.incidentsDir, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJsonSafe(path.join(paths.incidentsDir, entry.name, 'evidence.json'), null);
      if (!meta) continue;
      dirs.push({ id: meta.id, createdAt: meta.createdAt, kind: meta.kind, reason: meta.reason, dir: path.join(paths.incidentsDir, entry.name) });
    }
    dirs.sort((a, b) => b.createdAt - a.createdAt);
    return dirs.slice(0, limit);
  } catch {
    return [];
  }
}
