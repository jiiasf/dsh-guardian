import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  pathExists,
  readJsonSafe,
  sha256File,
  shortId,
  sleep,
  writeJsonAtomic,
} from './util.mjs';
import { metaFromProfile } from './profile.mjs';

async function copyVerified(source, destination, expectedHash) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = `${destination}.${process.pid}.${attempt}.tmp`;
    try {
      await fs.copyFile(source, tmp);
      const hash = await sha256File(tmp);
      if (expectedHash && hash !== expectedHash) {
        lastError = new Error(`文件在快照过程中发生变化：${path.basename(source)}`);
        await fs.rm(tmp, { force: true });
        await sleep(250);
        continue;
      }
      await fs.rename(tmp, destination);
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(tmp, { force: true }).catch(() => {});
      await sleep(150);
    }
  }
  throw lastError ?? new Error(`无法复制文件：${source}`);
}

async function replaceFile(source, destination) {
  const tmp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.copyFile(source, tmp);
  let delay = 30;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, destination);
      return;
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      if (!transient || attempt >= 8) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

export async function createSnapshot(paths, profile, { reason = 'manual', note = null } = {}) {
  if (!profile?.ok) throw new Error(`无法快照：profile 不可读（${profile?.error ?? 'unknown'}）`);
  const id = shortId(reason === 'baseline' ? 'base' : 'snap');
  const dir = path.join(paths.snapshotsDir, id);
  const filesDir = path.join(dir, 'files');
  await ensureDir(filesDir);
  const meta = metaFromProfile(profile, { id, createdAt: Date.now(), reason, note });
  meta.profileDir = profile.dir;
  meta.source = 'guardian';
  const copied = [];
  for (const file of profile.files) {
    if (!file.hash) continue;
    const source = path.join(profile.dir, file.name);
    const destination = path.join(filesDir, file.name);
    await copyVerified(source, destination, file.hash);
    copied.push(file.name);
  }
  meta.copiedFiles = copied;
  await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  return { ...meta, dir };
}

export async function listSnapshots(paths) {
  let entries = [];
  try {
    entries = await fs.readdir(paths.snapshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJsonSafe(path.join(paths.snapshotsDir, entry.name, 'meta.json'), null);
    if (!meta || !meta.id) continue;
    snapshots.push(meta);
  }
  snapshots.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  return snapshots;
}

export async function loadSnapshot(paths, id) {
  if (!id) return null;
  const dir = path.join(paths.snapshotsDir, id);
  const meta = await readJsonSafe(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  return { ...meta, dir };
}

export async function pruneSnapshots(paths, { keep = 12, protect = [] } = {}) {
  const snapshots = await listSnapshots(paths);
  const protectedIds = new Set(protect.filter(Boolean));
  const removed = [];
  let kept = 0;
  for (const snapshot of snapshots) {
    if (protectedIds.has(snapshot.id)) {
      kept += 1;
      continue;
    }
    if (kept < keep) {
      kept += 1;
      continue;
    }
    await fs.rm(path.join(paths.snapshotsDir, snapshot.id), { recursive: true, force: true });
    removed.push(snapshot.id);
  }
  return removed;
}

export async function deleteSnapshot(paths, id) {
  await fs.rm(path.join(paths.snapshotsDir, id), { recursive: true, force: true });
}

function dependencyPath(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...name.split('/'));
}

export async function restoreSnapshot(paths, snapshot, { profileDir, currentProfile, logger, incidentId } = {}) {
  if (!snapshot) throw new Error('缺少可回滚的快照');
  const snapFilesDir = path.join(snapshot.dir, 'files');
  const backupDir = path.join(paths.incidentsDir, incidentId ?? shortId('restore'), 'removed-files');
  const result = {
    restored: [],
    removed: [],
    quarantined: [],
    errors: [],
    backupDir,
    snapshotId: snapshot.id,
  };

  await ensureDir(profileDir);
  const expected = snapshot.files ?? {};
  const currentNames = new Set((currentProfile?.files ?? []).map((file) => file.name));

  // Remove manifest files that did not exist in the good snapshot.
  for (const name of currentNames) {
    if (name in expected) continue;
    const target = path.join(profileDir, name);
    try {
      await ensureDir(backupDir);
      await fs.copyFile(target, path.join(backupDir, name)).catch(() => {});
      await fs.rm(target, { force: true });
      result.removed.push(name);
    } catch (error) {
      result.errors.push(`删除 ${name} 失败：${error.message}`);
    }
  }

  // Restore every file recorded in the snapshot.
  for (const [name, expectedHash] of Object.entries(expected)) {
    const source = path.join(snapFilesDir, name);
    const target = path.join(profileDir, name);
    try {
      if (!(await pathExists(source))) throw new Error(`快照缺少文件 ${name}`);
      await ensureDir(path.dirname(target));
      await replaceFile(source, target);
      const hash = await sha256File(target);
      if (expectedHash && hash !== expectedHash) throw new Error(`恢复后校验失败 ${name}`);
      result.restored.push(name);
    } catch (error) {
      result.errors.push(`恢复 ${name} 失败：${error.message}`);
    }
  }

  // Quarantine node_modules packages that the bad state introduced.
  const baselineDeps = snapshot.deps ?? {};
  const currentDeps = currentProfile?.deps ?? {};
  const addedDeps = Object.keys(currentDeps).filter((name) => !(name in baselineDeps));
  const quarantineRoot = path.join(paths.quarantineDir, incidentId ?? shortId('quarantine'));
  for (const name of addedDeps) {
    const source = dependencyPath(profileDir, name);
    if (!(await pathExists(source))) continue;
    const destination = path.join(quarantineRoot, 'node_modules', ...name.split('/'));
    try {
      await ensureDir(path.dirname(destination));
      await fs.rename(source, destination);
      result.quarantined.push(name);
    } catch (error) {
      try {
        await fs.cp(source, destination, { recursive: true, dereference: false, force: true });
        await fs.rm(source, { recursive: true, force: true });
        result.quarantined.push(name);
      } catch (copyError) {
        result.errors.push(`隔离依赖 ${name} 失败：${copyError.message}`);
      }
    }
  }

  // Legacy fallback: plugin bundles may be listed only in the removed patch layer.
  if (result.quarantined.length === 0 && currentProfile?.nodeModules?.names?.length) {
    for (const name of currentProfile.nodeModules.names) {
      if (name.includes('*(')) continue;
      if ((snapshot.nodeModules?.names ?? []).includes(name)) continue;
      const source = dependencyPath(profileDir, name);
      if (!(await pathExists(source))) continue;
      const destination = path.join(quarantineRoot, 'node_modules', ...name.split('/'));
      try {
        await ensureDir(path.dirname(destination));
        await fs.rename(source, destination);
        result.quarantined.push(name);
      } catch {
        /* not fatal */
      }
    }
  }

  // A baseline without node_modules must not gain an empty one after quarantine,
  // otherwise the profile fingerprint would keep reporting a phantom change.
  const nodeModulesPath = path.join(profileDir, 'node_modules');
  try {
    if (!snapshot.nodeModules?.exists) {
      const entries = await fs.readdir(nodeModulesPath);
      if (entries.filter((name) => !name.startsWith('.')).length === 0) {
        await fs.rm(nodeModulesPath, { recursive: true, force: true });
      }
    } else {
      const entries = await fs.readdir(nodeModulesPath);
      for (const entry of entries.filter((name) => name.startsWith('@'))) {
        const scopePath = path.join(nodeModulesPath, entry);
        try {
          if ((await fs.readdir(scopePath)).length === 0) await fs.rmdir(scopePath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* node_modules may not exist */
  }

  await logger?.info('snapshot.restore', '已从快照恢复 profile', {
    snapshotId: snapshot.id,
    restored: result.restored.length,
    removed: result.removed.length,
    quarantined: result.quarantined.length,
    errors: result.errors.length,
  });
  return result;
}

export async function snapshotSummary(paths) {
  const snapshots = await listSnapshots(paths);
  return snapshots;
}
