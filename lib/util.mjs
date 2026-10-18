import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nowIso() {
  return new Date().toISOString();
}

export function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function shortId(prefix = 'snap') {
  return `${prefix}-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function readJsonSafe(filePath, fallback = null) {
  try {
    return await readJson(filePath, fallback);
  } catch {
    return fallback;
  }
}

async function replaceWithRetry(tmp, target) {
  let delay = 25;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      if (!transient || attempt >= 8) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

export async function writeJsonAtomic(filePath, value, options = {}) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const text = `${JSON.stringify(value, null, options.pretty === false ? 0 : 2)}\n`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await replaceWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeTextAtomic(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await replaceWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function appendText(filePath, text, maxBytes = 5 * 1024 * 1024) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, text, 'utf8');
  try {
    const info = await fs.stat(filePath);
    if (info.size > maxBytes) {
      const rotated = `${filePath}.1`;
      await fs.rm(rotated, { force: true });
      await fs.rename(filePath, rotated);
    }
  } catch {
    /* rotation is best effort */
  }
}

export async function tailFile(filePath, maxBytes = 64 * 1024) {
  try {
    const info = await fs.stat(filePath);
    const start = Math.max(0, info.size - maxBytes);
    const handle = await fs.open(filePath, 'r');
    try {
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export async function runPowerShell(script, { timeoutMs = 20000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

export async function runFile(command, args = [], { timeoutMs = 120000, cwd } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    cwd,
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

export function parseJsonOutput(text) {
  const trimmed = String(text ?? '').trim().replace(/^\uFEFF/, '');
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    const firstArr = trimmed.indexOf('[');
    const lastArr = trimmed.lastIndexOf(']');
    const candidates = [];
    if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
    if (firstArr >= 0 && lastArr > firstArr) candidates.push(trimmed.slice(firstArr, lastArr + 1));
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* keep trying */
      }
    }
    return null;
  }
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
}

export function truncate(text, max = 400) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== ''))];
}
