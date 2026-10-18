import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseJsonOutput, runPowerShell, sleep } from './util.mjs';

const execFileAsync = promisify(execFile);

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value);
  const fixed = text.replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(fixed);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function queryAppProcesses(config, { timeoutMs = 12000 } = {}) {
  const name = psQuote(config.appProcessName);
  const script = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$name = ${name}
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $name } | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    created = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' })
    cmd = [string]$_.CommandLine
  }
})
$ports = @()
if ($procs.Count -gt 0) {
  $ids = @($procs | ForEach-Object { $_.pid })
  foreach ($line in (& "$env:SystemRoot\\System32\\netstat.exe" -ano -p tcp)) {
    if ($line -match '^\\s*TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$') {
      $port = [int]$Matches[1]
      $owner = [int]$Matches[2]
      if ($ids -contains $owner) {
        $ports += [pscustomobject]@{ port = $port; pid = $owner }
      }
    }
  }
}
[pscustomobject]@{
  procs = $procs
  ports = $ports
  now = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 6 -Compress
`;
  try {
    const { stdout } = await runPowerShell(script, { timeoutMs });
    const data = parseJsonOutput(stdout);
    if (!data || typeof data !== 'object') {
      return { ok: false, error: '无法解析进程查询结果', procs: [], ports: [], checkedAt: Date.now() };
    }
    const procs = (Array.isArray(data.procs) ? data.procs : data.procs ? [data.procs] : []).map((entry) => ({
      pid: Number(entry.pid),
      ppid: Number(entry.ppid),
      startedAt: normalizeDate(entry.created),
      commandLine: String(entry.cmd ?? ''),
    }));
    const ports = (Array.isArray(data.ports) ? data.ports : data.ports ? [data.ports] : []).map((entry) => ({
      port: Number(entry.port),
      pid: Number(entry.pid),
    }));
    return { ok: true, procs, ports, checkedAt: Date.now() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      procs: [],
      ports: [],
      checkedAt: Date.now(),
    };
  }
}

export function classifyProcesses(query) {
  const procs = query.procs ?? [];
  const main = procs.find((proc) => {
    const cmd = proc.commandLine;
    return !/--type=/i.test(cmd) && !/dsh-desktop-host/i.test(cmd) && !/dsh-subprocess/i.test(cmd);
  });
  const mainPid = main?.pid ?? null;
  const hosts = procs.filter((proc) => /dsh-desktop-host[\\/]lib[\\/]index\.js/i.test(proc.commandLine));
  // Prefer the Agent host that belongs to the current main process; ignore orphans.
  const host = (mainPid !== null ? hosts.find((proc) => proc.ppid === mainPid) : null) ?? hosts[0];
  const hostPid = host?.pid ?? null;
  let port = null;
  if (hostPid !== null) {
    port = (query.ports ?? []).find((entry) => entry.pid === hostPid)?.port ?? null;
  }
  if (port === null && mainPid !== null) {
    port = (query.ports ?? []).find((entry) => entry.pid === mainPid)?.port ?? null;
  }
  if (port === null && procs.length > 0) {
    port = (query.ports ?? [])[0]?.port ?? null;
  }
  return {
    mainPid,
    hostPid,
    port,
    mainStartedAt: main?.startedAt ?? null,
    hostStartedAt: host?.startedAt ?? null,
    processCount: procs.length,
    procs,
  };
}

async function httpProbe(port, timeoutMs = 3000) {
  if (!port) return { status: null, error: 'no-port' };
  const url = `http://127.0.0.1:${port}/`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-guardian/1.0' },
      redirect: 'manual',
    });
    try {
      await response.arrayBuffer();
    } catch {
      /* body is irrelevant */
    }
    return { status: response.status, error: null };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function probeHealth(config, { startupGraceMs } = {}) {
  const startedAt = Date.now();
  const query = await queryAppProcesses(config);
  const view = classifyProcesses(query);
  const grace = startupGraceMs ?? config.startupGraceMs;
  const base = {
    checkedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    mainPid: view.mainPid,
    hostPid: view.hostPid,
    mainStartedAt: view.mainStartedAt,
    hostStartedAt: view.hostStartedAt,
    port: view.port,
    processCount: view.processCount,
    httpStatus: null,
    error: null,
  };

  if (!query.ok) {
    return { ...base, state: 'unknown', error: query.error ?? '进程查询失败' };
  }
  if (view.mainPid === null) {
    return { ...base, state: 'down', error: view.processCount > 0 ? '主进程未运行（仅剩子进程）' : 'DSH 未运行' };
  }

  const age = view.mainStartedAt ? Date.now() - view.mainStartedAt : 0;
  const withinGrace = age < grace;
  if (view.hostPid === null) {
    return { ...base, state: withinGrace ? 'starting' : 'degraded', error: 'Agent 宿主进程未运行' };
  }
  if (view.port === null) {
    return { ...base, state: withinGrace ? 'starting' : 'degraded', error: 'Web 端口尚未监听' };
  }

  const http = await httpProbe(view.port);
  base.httpStatus = http.status;
  base.error = http.error;
  if (http.status !== null && http.status < 500) {
    return { ...base, state: 'healthy' };
  }
  if (http.status !== null) {
    return { ...base, state: 'degraded', error: `Web 服务返回 ${http.status}` };
  }
  return {
    ...base,
    state: withinGrace ? 'starting' : 'degraded',
    error: http.error ? `Web 服务无响应：${http.error}` : 'Web 服务无响应',
  };
}

export function isHealthy(health) {
  return health?.state === 'healthy';
}

export function isNewBoot(health, marker) {
  if (!health?.mainPid || !marker) return false;
  if (marker.mainPid !== undefined && health.mainPid !== marker.mainPid) return true;
  if (marker.mainStartedAt && health.mainStartedAt && health.mainStartedAt > marker.mainStartedAt + 500) return true;
  if (marker.detectedAt && health.mainStartedAt && health.mainStartedAt > marker.detectedAt + 1000) return true;
  return false;
}

export async function stopApp(config, logger) {
  const query = await queryAppProcesses(config);
  const view = classifyProcesses(query);
  if ((query.procs ?? []).length === 0) return { ok: true, killed: 0 };
  const targets = [view.mainPid, view.hostPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  const all = (query.procs ?? []).map((proc) => proc.pid);
  const kill = async (pid, tree = true) => {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], {
        timeout: 15000,
        windowsHide: true,
      });
    } catch {
      /* may already be gone */
    }
  };
  if (targets.length > 0) {
    for (const pid of targets) await kill(pid);
  } else {
    for (const pid of all) await kill(pid);
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const check = await queryAppProcesses(config);
    if ((check.procs ?? []).length === 0) {
      await logger?.info('app.stopped', 'DSH 已停止', { killed: targets.length || all.length });
      return { ok: true, killed: targets.length || all.length };
    }
    await sleep(700);
  }
  const leftovers = (await queryAppProcesses(config)).procs ?? [];
  for (const proc of leftovers) await kill(proc.pid);
  await sleep(1000);
  const finalCheck = await queryAppProcesses(config);
  const ok = (finalCheck.procs ?? []).length === 0;
  await logger?.[ok ? 'info' : 'warn']('app.stop', ok ? 'DSH 进程已全部退出' : '仍有 DSH 进程未退出', {
    leftovers: finalCheck.procs?.length ?? -1,
  });
  return { ok, killed: targets.length || all.length };
}

export async function startApp(config, logger) {
  if (!config.appExe) throw new Error('未配置 DSH 可执行文件路径（appExe）');
  await logger?.info('app.start', '正在启动 DSH', { appExe: config.appExe });
  const child = spawn(config.appExe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: path.dirname(config.appExe),
  });
  child.unref();
  await sleep(1200);
  return { pid: child.pid ?? null };
}

export async function waitForHealthy(config, { timeoutMs, afterPid = null, onProgress, failFastOnExit = true } = {}) {
  const deadline = Date.now() + (timeoutMs ?? config.startupGraceMs);
  let last = null;
  let newBoot = false;
  let sawBootMain = false;
  let goneChecks = 0;
  while (Date.now() < deadline) {
    last = await probeHealth(config);
    if (last.mainPid) {
      sawBootMain = true;
      goneChecks = 0;
      if (afterPid === null || last.mainPid !== afterPid) newBoot = true;
    }
    if (last.state === 'healthy') return { ok: true, health: last, newBoot };
    if (failFastOnExit && sawBootMain && !last.mainPid) {
      goneChecks += 1;
      // A boot that appears and disappears within seconds is a failed boot,
      // not a slow start: let the caller roll back instead of waiting 2 minutes.
      if (goneChecks >= 2) return { ok: false, health: last, newBoot, bootFailed: true };
    }
    onProgress?.(last);
    await sleep(2000);
  }
  return { ok: false, health: last, newBoot };
}

export async function restartApp(config, logger, { timeoutMs, afterPid = null, onProgress } = {}) {
  const before = await queryAppProcesses(config);
  const beforeMain = classifyProcesses(before).mainPid;
  await stopApp(config, logger);
  await startApp(config, logger);
  const result = await waitForHealthy(config, {
    timeoutMs: timeoutMs ?? config.startupGraceMs,
    afterPid: afterPid ?? beforeMain,
    onProgress,
  });
  return result;
}

export async function launchIfNotRunning(config, logger) {
  const health = await probeHealth(config);
  if (health.state === 'healthy') return { started: false, health };
  if (health.state === 'down') {
    await startApp(config, logger);
    const result = await waitForHealthy(config, { timeoutMs: config.startupGraceMs });
    return { started: true, ...result };
  }
  return { started: false, health };
}
