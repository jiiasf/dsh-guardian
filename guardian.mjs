#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ensureConfigFile, guardianRoot, loadConfig, normalizeConfig, saveConfig, ensureStateDirs, initDefaults } from './lib/config.mjs';
import { collectProfile, diffProfileAgainstMeta, profileAppVersion } from './lib/profile.mjs';
import { listSnapshots, loadSnapshot } from './lib/snapshot.mjs';
import { listIncidents } from './lib/incident.mjs';
import { probeHealth } from './lib/proc.mjs';
import { buildStatus, loadState, readStatus, PHASE_LABELS } from './lib/state.mjs';
import { Logger } from './lib/logger.mjs';
import { daemonAlive, enqueueCommand, stopDaemon, waitForDaemon, waitForResult } from './lib/commands.mjs';
import { formatDuration, nowIso, pathExists, tailFile } from './lib/util.mjs';

const OPTIONS = {
  json: { type: 'boolean', default: false },
  note: { type: 'string' },
  force: { type: 'boolean', default: false },
  to: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  observe: { type: 'boolean', default: false },
  timeout: { type: 'string' },
  profile: { type: 'string' },
  'state-dir': { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
};

function printHelp() {
  console.log(`DSH 守护者 (guardian) v1.0.1

用法:
  node guardian.mjs <命令> [参数]

核心命令:
  start [--dry-run|--observe]   在后台启动守护进程
  stop [--force]                停止守护进程
  status [--json]               查看当前状态
  snapshot [--note 文本] [--force]
                                把当前 profile 记录为新的良好版本
  verify                        安全重启 DSH 并验证当前插件；失败自动回滚
  rollback [--to 快照ID] [--yes]
                                回滚到良好快照（默认最近基线）
  restart                       安全重启 DSH（不改变 profile）
  pause / resume                暂停 / 恢复守护动作
  history                       列出历史良好快照
  incidents                     列出事件报告
  doctor [--json]               环境自检
  init                          创建默认配置
  config list|path|set <键> <值>
  selftest                      运行离线自检（不会动真实 DSH）

示例:
  node guardian.mjs start
  node guardian.mjs snapshot --note "安装插件前"
  node guardian.mjs verify
  node guardian.mjs rollback --to base-20261018-210000-abc123 --yes
  node guardian.mjs status
`);
}

async function loadContext() {
  const loaded = await ensureConfigFile();
  if (!loaded.paths.profileDir) {
    throw new Error('profileDir 未配置');
  }
  await ensureStateDirs(loaded.paths);
  return loaded;
}

function overrideFromArgs(values) {
  const overrides = {};
  if (values['dry-run']) overrides.dryRun = true;
  if (values.observe) overrides.observeOnly = true;
  return overrides;
}

async function ensureDaemon(loaded, values, logger) {
  const { config, paths } = loaded;
  const alive = await daemonAlive(paths);
  if (alive.alive) return { started: false, pid: alive.pid };
  const nodeExe = (await pathExists(config.nodeExe)) ? config.nodeExe : process.execPath;
  const args = [path.join(guardianRoot, 'guardian.mjs'), 'run'];
  if (values['dry-run']) args.push('--dry-run');
  if (values.observe) args.push('--observe');
  const child = spawn(nodeExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: guardianRoot,
    env: { ...process.env },
  });
  child.unref();
  const ready = await waitForDaemon(paths);
  if (!ready.ok) throw new Error('守护进程启动失败，请运行 doctor 检查');
  await logger?.info('daemon.spawned', '已启动守护进程', { pid: ready.pid });
  return { started: true, pid: ready.pid };
}

function humanStatus(status, state) {
  const lines = [];
  lines.push('DSH 守护者 · 运行状态');
  lines.push('────────────────────────────');
  const daemon = status?.daemon ?? {};
  const app = status?.app ?? {};
  lines.push(`守护进程 : ${daemon.running ? `运行中 (PID ${daemon.pid})` : '未运行'}`);
  if (daemon.startedAt) lines.push(`运行时长 : ${formatDuration((Date.now() - daemon.startedAt) / 1000)}`);
  lines.push(`当前阶段 : ${status?.phaseLabel ?? PHASE_LABELS[status?.phase] ?? status?.phase ?? '未知'}`);
  lines.push(
    `DSH 状态 : ${app.label ?? app.state ?? '未知'}${app.mainPid ? ` (主进程 ${app.mainPid}` : ''}${
      app.hostPid ? `, Agent ${app.hostPid}` : ''
    }${app.port ? `, 端口 ${app.port}` : ''}${app.mainPid ? ')' : ''}`,
  );
  if (app.error) lines.push(`DSH 错误 : ${app.error}`);
  if (app.uptimeSec !== null && app.uptimeSec !== undefined) lines.push(`DSH 运行 : ${formatDuration(app.uptimeSec)}`);
  if (status?.baseline) {
    lines.push(
      `良好基线 : ${status.baseline.id} (${new Date(status.baseline.createdAt).toLocaleString('zh-CN', {
        hour12: false,
      })})`,
    );
  } else {
    lines.push('良好基线 : 尚未建立');
  }
  if (status?.candidate) {
    const candidate = status.candidate;
    const remaining = candidate.probationRemainingMs ? `，剩余 ${formatDuration(candidate.probationRemainingMs / 1000)}` : '';
    lines.push(`插件试用 : ${candidate.phase}${remaining}`);
    if (candidate.changeSummary?.summary) lines.push(`变更摘要 : ${candidate.changeSummary.summary}`);
  } else {
    lines.push('插件试用 : 无');
  }
  if (status?.attention?.message) lines.push(`需要处理 : ${status.attention.message}`);
  if (status?.lastEvent) lines.push(`最近事件 : ${status.lastEvent.message}`);
  lines.push(`守护日志 : ${status?.paths?.logPath ?? ''}`);
  return lines.join('\n');
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: OPTIONS });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log('1.0.1');
    return;
  }
  if (values.help || positionals.length === 0) {
    printHelp();
    return;
  }
  if (values.config) process.env.DSH_GUARDIAN_CONFIG = path.resolve(values.config);
  if (values['state-dir']) process.env.DSH_GUARDIAN_HOME = path.resolve(values['state-dir']);

  const command = positionals[0];
  const sub = positionals[1];

  if (command === 'init') {
    if (values.profile) process.env.DSH_PROFILE = values.profile;
    const loaded = await initDefaults();
    console.log(`已创建配置：${loaded.paths.configPath}`);
    console.log(JSON.stringify(loaded.config, null, 2));
    return;
  }

  if (command === 'selftest') {
    const { runSelfTest } = await import('./lib/selftest.mjs');
    const result = await runSelfTest({ verbose: !values.json });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === 'config') {
    const loaded = await loadContext();
    if (!sub || sub === 'list') {
      console.log(JSON.stringify(loaded.config, null, 2));
      return;
    }
    if (sub === 'path') {
      console.log(loaded.paths.configPath);
      return;
    }
    if (sub === 'set') {
      const key = positionals[2];
      const rawValue = positionals[3];
      if (!key || rawValue === undefined) throw new Error('用法：config set <键> <值>');
      const allowed = new Set(Object.keys(normalizeConfig({})));
      if (!allowed.has(key)) throw new Error(`未知配置键：${key}`);
      const current = { ...loaded.config };
      current[key] = coerceValue(rawValue, current[key]);
      await saveConfig(current);
      const alive = await daemonAlive(loaded.paths);
      if (alive.alive) {
        const id = await enqueueCommand(loaded.paths, 'reload', {}, { source: 'cli-config' });
        await waitForResult(loaded.paths, id, { timeoutMs: 10000 });
      }
      console.log(`${key} = ${JSON.stringify(current[key])}`);
      return;
    }
    throw new Error(`未知 config 子命令：${sub}`);
  }

  if (command === 'status' || command === 'watch') {
    const loaded = await loadContext();
    let status = await readStatus(loaded.paths);
    const alive = await daemonAlive(loaded.paths);
    if (!status || !alive.alive) {
      const health = await probeHealth(loaded.config);
      const profile = await collectProfile(loaded.paths.profileDir);
      const state = await loadState(loaded.paths);
      status = buildStatus({
        state,
        config: loaded.config,
        paths: loaded.paths,
        health,
        profile,
        logger: null,
        daemonPid: alive.pid,
      });
      status.daemon.running = false;
    }
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(humanStatus(status, null));
    }
    return;
  }

  if (command === 'doctor') {
    const loaded = await loadContext();
    const logger = new Logger(loaded.paths, { echo: false });
    const health = await probeHealth(loaded.config);
    const profile = await collectProfile(loaded.paths.profileDir);
    const state = await loadState(loaded.paths);
    const snapshots = await listSnapshots(loaded.paths);
    const baseline = state.baseline ? await loadSnapshot(loaded.paths, state.baseline.id) : null;
    const alive = await daemonAlive(loaded.paths);
    const appVersion = await profileAppVersion(loaded.paths.profileDir);
    const checks = {
      configFile: loaded.paths.configPath,
      configExists: await pathExists(loaded.paths.configPath),
      nodeExe: loaded.config.nodeExe,
      nodeExists: await pathExists(loaded.config.nodeExe),
      appExe: loaded.paths.appExe,
      appExists: await pathExists(loaded.paths.appExe),
      profileDir: loaded.paths.profileDir,
      profileExists: profile.exists,
      profileFiles: profile.files.map((file) => file.name),
      stateDir: loaded.paths.stateDir,
      stateWritable: await canWrite(loaded.paths.stateDir),
      daemonRunning: alive.alive,
      daemonPid: alive.pid,
      baseline: baseline ? { id: baseline.id, createdAt: baseline.createdAt } : null,
      baselineValid: Boolean(baseline),
      snapshotCount: snapshots.length,
      appVersion,
      dshAppVersion: await readAppVersion(loaded.config.appExe),
    };
    const report = { ok: true, checks, health, profile: { fingerprint: profile.fingerprint, deps: profile.deps, bundles: profile.bundles } };
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('DSH 守护者 · 环境自检');
      console.log('────────────────────────────');
      console.log(`配置文件   : ${checks.configFile} ${checks.configExists ? '✓' : '✗'}`);
      console.log(`Node       : ${checks.nodeExe} ${checks.nodeExists ? '✓' : '✗'}`);
      console.log(`DSH 程序   : ${checks.appExe} ${checks.appExists ? '✓' : '✗'}`);
      console.log(`Profile    : ${checks.profileDir} ${checks.profileExists ? '✓' : '✗'}`);
      console.log(`状态目录   : ${checks.stateDir} ${checks.stateWritable ? '✓' : '✗'}`);
      console.log(`守护进程   : ${checks.daemonRunning ? `运行中 (PID ${checks.daemonPid})` : '未运行'}`);
      console.log(`DSH 状态   : ${health.state}${health.error ? `（${health.error}）` : ''}`);
      console.log(`主/宿主PID : ${health.mainPid ?? '-'} / ${health.hostPid ?? '-'}  端口 ${health.port ?? '-'}`);
      console.log(`良好基线   : ${checks.baseline ? `${checks.baseline.id} (${new Date(checks.baseline.createdAt).toLocaleString('zh-CN', { hour12: false })})` : '尚未建立'}`);
      console.log(`快照数量   : ${checks.snapshotCount}`);
      console.log(`依赖       : ${Object.keys(profile.deps ?? {}).join(', ') || '(无)'}`);
      console.log(`组合包     : ${(profile.bundles ?? []).join(', ') || '(无)'}`);
      if (!checks.appExists) console.log('\n⚠ 找不到 DSH 可执行文件，请修改 config.json 的 appExe。');
      if (!checks.baselineValid) console.log('\n⚠ 没有可用的良好基线，执行 `node guardian.mjs snapshot` 建立基线。');
    }
    return;
  }

  if (command === 'history') {
    const loaded = await loadContext();
    const snapshots = await listSnapshots(loaded.paths);
    const state = await loadState(loaded.paths);
    const baselineId = state.baseline?.id;
    if (values.json) {
      console.log(JSON.stringify({ baselineId, snapshots }, null, 2));
      return;
    }
    if (!snapshots.length) {
      console.log('暂无快照。');
      return;
    }
    console.log(`快照历史（共 ${snapshots.length} 个）`);
    console.log('────────────────────────────');
    for (const snapshot of snapshots) {
      const mark = snapshot.id === baselineId ? '★' : ' ';
      const date = new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false });
      console.log(`${mark} ${snapshot.id}  ${date}  ${snapshot.reason ?? ''}  ${snapshot.note ?? ''}`);
    }
    console.log('\n★ = 当前良好基线');
    return;
  }

  if (command === 'incidents') {
    const loaded = await loadContext();
    const incidents = await listIncidents(loaded.paths, 20);
    if (values.json) {
      console.log(JSON.stringify(incidents, null, 2));
      return;
    }
    if (!incidents.length) {
      console.log('暂无事件报告。');
      return;
    }
    for (const incident of incidents) {
      console.log(`${new Date(incident.createdAt).toLocaleString('zh-CN', { hour12: false })}  ${incident.id}  ${incident.kind ?? ''}  ${incident.reason ?? ''}`);
      console.log(`  ${path.join(incident.dir, 'incident.md')}`);
    }
    return;
  }

  const loaded = await loadContext();
  const logger = new Logger(loaded.paths, { echo: false });

  if (command === 'start') {
    const result = await ensureDaemon(loaded, values, logger);
    const alive = await daemonAlive(loaded.paths);
    console.log(result.started ? `守护进程已启动 (PID ${alive.pid})` : `守护进程已在运行 (PID ${alive.pid})`);
    return;
  }

  if (command === 'stop') {
    const result = await stopDaemon(loaded.paths, { force: values.force });
    if (result.ok) console.log(result.alreadyStopped ? '守护进程未运行。' : '守护进程已停止。');
    else {
      console.error(result.message ?? '停止失败');
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'pause' || command === 'resume') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, command, {}, { source: 'cli' });
    const result = await waitForResult(loaded.paths, id);
    console.log(result.message ?? (result.ok ? '完成' : '失败'));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'snapshot') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(
      loaded.paths,
      'snapshot',
      { note: values.note ?? '手动快照', force: values.force },
      { source: 'cli' },
    );
    const result = await waitForResult(loaded.paths, id);
    console.log(result.message ?? (result.ok ? '快照完成' : '快照失败'));
    if (result.id) console.log(`快照 ID：${result.id}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'promote') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, 'promote', {}, { source: 'cli' });
    const result = await waitForResult(loaded.paths, id);
    console.log(result.message ?? (result.ok ? '完成' : '失败'));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'dismiss') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, 'clear-attention', {}, { source: 'cli' });
    const result = await waitForResult(loaded.paths, id);
    console.log(result.message ?? (result.ok ? '已清除提醒' : '失败'));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'rollback') {
    await ensureDaemon(loaded, values, logger);
    if (values.to) {
      const snapshot = await loadSnapshot(loaded.paths, values.to);
      if (!snapshot) throw new Error(`找不到快照：${values.to}`);
    }
    if (!values.to && !values.yes) {
      process.stderr.write('即将回滚到最近的良好基线。按 Ctrl+C 取消，或加 --yes 跳过此提示。\n');
    }
    const id = await enqueueCommand(
      loaded.paths,
      'rollback',
      { to: values.to ?? null, reason: 'manual-rollback', dryRun: Boolean(values['dry-run']) },
      { source: 'cli' },
    );
    console.log('已请求回滚，等待守护进程执行…');
    const result = await waitForResult(loaded.paths, id, { timeoutMs: 600000 });
    const message = result.message ?? (result.ok ? '回滚成功' : '回滚失败');
    console.log(message);
    if (result.data?.reportPath) console.log(`事件报告：${result.data.reportPath}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'verify') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, 'verify', {}, { source: 'cli' });
    console.log('已请求安全重启并验证插件，等待守护进程执行…');
    const result = await waitForResult(loaded.paths, id, { timeoutMs: 600000 });
    console.log(result.message ?? (result.ok ? '验证成功' : '验证失败'));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'restart') {
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, 'restart', {}, { source: 'cli' });
    console.log('已请求重启 DSH，等待守护进程执行…');
    const result = await waitForResult(loaded.paths, id, { timeoutMs: 300000 });
    console.log(result.message ?? (result.ok ? '重启完成' : '重启失败'));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'logs') {
    const text = await tailFile(loaded.paths.logPath, 32 * 1024);
    console.log(text || '暂无日志。');
    return;
  }

  if (command === 'run') {
    const overrides = overrideFromArgs(values);
    const { GuardianDaemon } = await import('./lib/supervisor.mjs');
    const daemon = new GuardianDaemon({ config: loaded.config, paths: loaded.paths, logger, overrides });
    await daemon.run();
    return;
  }

  if (command === 'cmd') {
    const type = sub;
    if (!type) throw new Error('用法：cmd <命令类型>');
    await ensureDaemon(loaded, values, logger);
    const id = await enqueueCommand(loaded.paths, type, {}, { source: 'cli' });
    const result = await waitForResult(loaded.paths, id, { timeoutMs: 600000 });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`未知命令：${command}`);
}

function coerceValue(raw, current) {
  if (typeof current === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
    throw new Error(`需要布尔值：${raw}`);
  }
  if (typeof current === 'number') {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`需要数字：${raw}`);
    return number;
  }
  if (Array.isArray(current)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return raw;
}

async function canWrite(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function readAppVersion(appExe) {
  try {
    const versionFile = path.join(path.dirname(appExe), 'resources', 'runtime', 'primary-runtime', 'runtime.json');
    const data = JSON.parse(await fs.readFile(versionFile, 'utf8'));
    return data.desktopVersion ?? null;
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
