import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, readJsonSafe, shortId, sleep, writeJsonAtomic } from './util.mjs';
import { isProcessAlive } from './state.mjs';

export async function enqueueCommand(paths, type, args = {}, { source = 'cli' } = {}) {
  await ensureDir(paths.commandsDir);
  const id = shortId('cmd');
  const payload = {
    id,
    type,
    args,
    createdAt: Date.now(),
    createdAtIso: new Date().toISOString(),
    source,
  };
  await writeJsonAtomic(path.join(paths.commandsDir, `${id}.json`), payload);
  return id;
}

export async function readResult(paths, id) {
  return readJsonSafe(path.join(paths.resultsDir, `${id}.json`), null);
}

export async function waitForResult(paths, id, { timeoutMs = 240000, intervalMs = 500, onWait } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readResult(paths, id);
    if (result) return result;
    await onWait?.();
    await sleep(intervalMs);
  }
  return { id, ok: false, message: '等待守护进程响应超时', timedOut: true };
}

export async function pendingCommands(paths) {
  try {
    const entries = await fs.readdir(paths.commandsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function readDaemonLock(paths) {
  return readJsonSafe(path.join(paths.runtimeDir, 'daemon.lock'), null);
}

export async function daemonAlive(paths) {
  const lock = await readDaemonLock(paths);
  if (lock?.pid && isProcessAlive(lock.pid)) return { alive: true, pid: lock.pid };
  return { alive: false, pid: null };
}

export async function stopDaemon(paths, { force = false, timeoutMs = 25000 } = {}) {
  const lock = await readDaemonLock(paths);
  if (!lock?.pid || !isProcessAlive(lock.pid)) {
    await fs.rm(paths.stopPath, { force: true }).catch(() => {});
    return { ok: true, alreadyStopped: true };
  }
  await writeJsonAtomic(paths.stopPath, { requestedAt: Date.now(), by: process.pid });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(lock.pid)) return { ok: true, pid: lock.pid };
    await sleep(400);
  }
  if (force) {
    try {
      process.kill(lock.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    await sleep(800);
    return { ok: !isProcessAlive(lock.pid), pid: lock.pid, forced: true };
  }
  return {
    ok: false,
    pid: lock.pid,
    busy: true,
    message: '守护进程仍在执行操作（可能是回滚/重启），未强制终止。稍后重试或使用 stop --force。',
  };
}

export async function waitForDaemon(paths, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await daemonAlive(paths);
    if (alive.alive) {
      const status = await readJsonSafe(paths.statusPath, null);
      if (status?.daemon?.running) return { ok: true, pid: alive.pid, status };
    }
    await sleep(300);
  }
  return { ok: false };
}

export async function waitForFile(filePath, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(filePath)) return true;
    await sleep(200);
  }
  return false;
}
