import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, sha256File, pathExists } from './util.mjs';

const EXACT_MANIFESTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'cordis.patch.yml',
  'compatibility.json',
  '.npmrc',
  'pnpmfile.cjs',
]);

const MAX_HASH_BYTES = 8 * 1024 * 1024;

function isManifestName(name) {
  if (EXACT_MANIFESTS.has(name)) return true;
  return /\.(ya?ml)$/i.test(name) && !name.startsWith('.');
}

function parsePackageJson(text) {
  try {
    const value = JSON.parse(text);
    const deps = {};
    for (const [name, spec] of Object.entries(value.dependencies ?? {})) deps[name] = String(spec);
    const bundles = Array.isArray(value?.dsh?.profile?.bundles) ? value.dsh.profile.bundles.map(String) : [];
    return { ok: true, deps, bundles, value };
  } catch (error) {
    return { ok: false, deps: {}, bundles: [], value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readNodeModules(profileDir) {
  const dir = path.join(profileDir, 'node_modules');
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    return { exists: false, mtimeMs: 0, names: [], scopes: {}, signature: 'none' };
  }
  const names = [];
  const scopes = {};
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        const scoped = [];
        try {
          const inner = await fs.readdir(path.join(dir, entry.name), { withFileTypes: true });
          for (const child of inner) {
            if (child.isDirectory() || child.isSymbolicLink()) scoped.push(child.name);
          }
        } catch {
          /* ignore */
        }
        scopes[entry.name] = scoped.sort();
        names.push(`${entry.name}*(${scoped.length})`);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        names.push(entry.name);
      }
    }
  } catch {
    /* ignore */
  }
  names.sort();
  // Deliberately exclude the directory mtime: a rollback restores the manifest
  // files but cannot restore a directory timestamp, and mtime alone is not a
  // meaningful profile change. Package additions/removals change the names.
  const signature = sha256(
    ['exists:true', ...names, ...Object.entries(scopes).flatMap(([scope, items]) => [`${scope}:${items.join(',')}`])].join('\n'),
  );
  return { exists: true, mtimeMs: Math.round(stat.mtimeMs), names, scopes, signature };
}

async function readLatestOperation(profileDir) {
  const logsDir = path.join(profileDir, '.plugin-manager', 'logs');
  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(logsDir, entry.name);
      try {
        const info = await fs.stat(full);
        dirs.push({ name: entry.name, path: full, mtimeMs: info.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (dirs.length === 0) return null;
    const latest = dirs[0];
    let log = null;
    try {
      const logPath = path.join(latest.path, 'pnpm.log');
      const info = await fs.stat(logPath);
      log = { path: logPath, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      /* no log yet */
    }
    const lastActivity = Math.max(latest.mtimeMs, log?.mtimeMs ?? 0);
    return {
      name: latest.name,
      path: latest.path,
      startedAt: Math.round(latest.mtimeMs),
      lastActivity: Math.round(lastActivity),
      log,
      active: Date.now() - lastActivity < 10000,
    };
  } catch {
    return null;
  }
}

export async function collectProfile(profileDir) {
  const startedAt = Date.now();
  const result = {
    ok: false,
    dir: profileDir,
    exists: false,
    files: [],
    fileMap: {},
    fingerprint: null,
    deps: {},
    bundles: [],
    packageJson: null,
    packageError: null,
    nodeModules: { exists: false, mtimeMs: 0, names: [], scopes: {}, signature: 'none' },
    latestOperation: null,
    collectedAt: startedAt,
    durationMs: 0,
    error: null,
  };
  try {
    await fs.access(profileDir);
    result.exists = true;
    const entries = await fs.readdir(profileDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isManifestName(entry.name)) continue;
      const full = path.join(profileDir, entry.name);
      try {
        const info = await fs.stat(full);
        if (info.size > MAX_HASH_BYTES) {
          files.push({ name: entry.name, size: info.size, mtime: Math.round(info.mtimeMs), hash: null, skipped: true });
          continue;
        }
        const hash = await sha256File(full);
        files.push({ name: entry.name, size: info.size, mtime: Math.round(info.mtimeMs), hash });
      } catch {
        /* file vanished mid-collection */
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    result.files = files.map(({ name, size, mtime, hash }) => ({ name, size, mtime, hash }));
    result.fileMap = Object.fromEntries(files.map((file) => [file.name, file.hash]));
    const packageFile = files.find((file) => file.name === 'package.json');
    if (packageFile?.hash) {
      try {
        const text = await fs.readFile(path.join(profileDir, 'package.json'), 'utf8');
        const parsed = parsePackageJson(text);
        result.deps = parsed.deps;
        result.bundles = parsed.bundles;
        result.packageJson = parsed.value;
        if (!parsed.ok) result.packageError = parsed.error;
      } catch (error) {
        result.packageError = error instanceof Error ? error.message : String(error);
      }
    }
    result.nodeModules = await readNodeModules(profileDir);
    result.latestOperation = await readLatestOperation(profileDir);
    const signature = sha256(
      JSON.stringify({
        files: files.map((file) => [file.name, file.hash ?? `size:${file.size}`]),
        nodeModules: result.nodeModules.signature,
      }),
    );
    result.fingerprint = signature;
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

export function emptySnapshotMeta(fingerprint = null) {
  return {
    id: null,
    createdAt: null,
    reason: null,
    note: null,
    fingerprint,
    files: {},
    deps: {},
    bundles: [],
    nodeModules: { exists: false, names: [], signature: 'none' },
    appVersion: null,
    profileDir: null,
  };
}

export function metaFromProfile(profile, { id, createdAt, reason, note } = {}) {
  return {
    id,
    createdAt: createdAt ?? Date.now(),
    reason: reason ?? 'snapshot',
    note: note ?? null,
    fingerprint: profile.fingerprint,
    files: Object.fromEntries(profile.files.filter((file) => file.hash).map((file) => [file.name, file.hash])),
    fileSizes: Object.fromEntries(profile.files.map((file) => [file.name, file.size])),
    deps: { ...profile.deps },
    bundles: [...profile.bundles],
    nodeModules: {
      exists: profile.nodeModules.exists,
      names: [...profile.nodeModules.names],
      scopes: { ...profile.nodeModules.scopes },
      signature: profile.nodeModules.signature,
    },
    appVersion: profile.appVersion ?? null,
    profileDir: profile.dir,
  };
}

export function diffProfileAgainstMeta(meta, profile) {
  const baselineFiles = meta?.files ?? {};
  const currentFiles = Object.fromEntries(profile.files.filter((file) => file.hash).map((file) => [file.name, file.hash]));
  const addedFiles = Object.keys(currentFiles).filter((name) => !(name in baselineFiles));
  const removedFiles = Object.keys(baselineFiles).filter((name) => !(name in currentFiles));
  const changedFiles = Object.keys(currentFiles).filter((name) => name in baselineFiles && baselineFiles[name] !== currentFiles[name]);

  const baselineDeps = meta?.deps ?? {};
  const currentDeps = profile.deps ?? {};
  const addedDeps = Object.keys(currentDeps).filter((name) => !(name in baselineDeps));
  const removedDeps = Object.keys(baselineDeps).filter((name) => !(name in currentDeps));
  const changedDeps = Object.keys(currentDeps).filter(
    (name) => name in baselineDeps && baselineDeps[name] !== currentDeps[name],
  );

  const baselineBundles = meta?.bundles ?? [];
  const currentBundles = profile.bundles ?? [];
  const addedBundles = currentBundles.filter((name) => !baselineBundles.includes(name));
  const removedBundles = baselineBundles.filter((name) => !currentBundles.includes(name));
  const bundleOrderChanged =
    addedBundles.length === 0 &&
    removedBundles.length === 0 &&
    baselineBundles.join('\n') !== currentBundles.join('\n');

  const parts = [];
  if (addedDeps.length) parts.push(`新增依赖 ${addedDeps.join(', ')}`);
  if (removedDeps.length) parts.push(`移除依赖 ${removedDeps.join(', ')}`);
  if (changedDeps.length) parts.push(`依赖版本变化 ${changedDeps.join(', ')}`);
  if (addedBundles.length) parts.push(`新增组合包 ${addedBundles.join(', ')}`);
  if (removedBundles.length) parts.push(`移除组合包 ${removedBundles.join(', ')}`);
  if (bundleOrderChanged) parts.push('组合包顺序变化');
  if (addedFiles.length) parts.push(`新增文件 ${addedFiles.join(', ')}`);
  if (removedFiles.length) parts.push(`移除文件 ${removedFiles.join(', ')}`);
  if (changedFiles.length) parts.push(`修改文件 ${changedFiles.join(', ')}`);
  if (profile.nodeModules.exists && meta?.nodeModules?.exists === false) parts.push('node_modules 建立');

  return {
    addedFiles,
    removedFiles,
    changedFiles,
    addedDeps,
    removedDeps,
    changedDeps,
    addedBundles,
    removedBundles,
    bundleOrderChanged,
    parts,
    summary: parts.length ? parts.join('；') : 'profile 内容无可见变化',
    pluginNames: [...new Set([...addedDeps, ...addedBundles])],
  };
}

export async function profileAppVersion(profileDir) {
  const file = path.join(profileDir, 'package.json');
  if (!(await pathExists(file))) return null;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return value.version ?? null;
  } catch {
    return null;
  }
}

export { isManifestName };
