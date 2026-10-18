import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureDir, pathExists, readJsonSafe, writeJsonAtomic } from './util.mjs';

export const guardianRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  profile: 'desktop',
  dshHome: '%USERPROFILE%\\.dsh',
  profileDir: '',
  appExe: 'D:\\DSH\\DeepSeek Harness.exe',
  appProcessName: 'DeepSeek Harness.exe',
  appUserDataDir: '%APPDATA%\\@deepseek-ai\\dsh-desktop',
  webUrlHint: 'http://127.0.0.1:58369',
  nodeExe: '',
  intervalMs: 4000,
  settleMs: 5000,
  probationMs: 180000,
  startupGraceMs: 120000,
  crashConfirmMs: 20000,
  failureThreshold: 3,
  verifyDelayMs: 20000,
  autoVerify: false,
  autoRollback: true,
  autoRestartStable: false,
  notify: true,
  observeOnly: false,
  dryRun: false,
  maxSnapshots: 12,
  maxHistory: 10,
  maxIncidents: 30,
});

function expand(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%APPDATA%/gi, process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
    .replace(/%DSH_HOME%/gi, process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
}

export function configPath() {
  return process.env.DSH_GUARDIAN_CONFIG
    ? path.resolve(process.env.DSH_GUARDIAN_CONFIG)
    : path.join(guardianRoot, 'config.json');
}

export function stateDir() {
  return process.env.DSH_GUARDIAN_HOME
    ? path.resolve(process.env.DSH_GUARDIAN_HOME)
    : path.join(os.homedir(), '.dsh-guardian');
}

export function resolvePaths(config) {
  const home = expand(config.dshHome);
  const profileDir = config.profileDir ? expand(config.profileDir) : path.join(home, 'profiles', config.profile);
  const state = stateDir();
  return {
    root: guardianRoot,
    configPath: configPath(),
    stateDir: state,
    runtimeDir: path.join(state, 'runtime'),
    logsDir: path.join(state, 'logs'),
    snapshotsDir: path.join(state, 'snapshots'),
    incidentsDir: path.join(state, 'incidents'),
    quarantineDir: path.join(state, 'quarantine'),
    commandsDir: path.join(state, 'commands'),
    resultsDir: path.join(state, 'results'),
    statePath: path.join(state, 'state.json'),
    statusPath: path.join(state, 'runtime', 'status.json'),
    logPath: path.join(state, 'logs', 'guardian.log'),
    eventsPath: path.join(state, 'logs', 'events.jsonl'),
    daemonPath: path.join(state, 'runtime', 'daemon.json'),
    stopPath: path.join(state, 'runtime', 'stop.request'),
    dshHome: home,
    profileDir,
    appExe: expand(config.appExe),
    appUserDataDir: expand(config.appUserDataDir),
    nodeExe: config.nodeExe ? expand(config.nodeExe) : process.execPath,
  };
}

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const clampInt = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  config.intervalMs = clampInt(config.intervalMs, 1000, 60000, DEFAULT_CONFIG.intervalMs);
  config.settleMs = clampInt(config.settleMs, 500, 120000, DEFAULT_CONFIG.settleMs);
  config.probationMs = clampInt(config.probationMs, 10000, 24 * 3600 * 1000, DEFAULT_CONFIG.probationMs);
  config.startupGraceMs = clampInt(config.startupGraceMs, 15000, 15 * 60 * 1000, DEFAULT_CONFIG.startupGraceMs);
  config.crashConfirmMs = clampInt(config.crashConfirmMs, 5000, 10 * 60 * 1000, DEFAULT_CONFIG.crashConfirmMs);
  config.failureThreshold = clampInt(config.failureThreshold, 1, 60, DEFAULT_CONFIG.failureThreshold);
  config.verifyDelayMs = clampInt(config.verifyDelayMs, 0, 30 * 60 * 1000, DEFAULT_CONFIG.verifyDelayMs);
  config.maxSnapshots = clampInt(config.maxSnapshots, 2, 200, DEFAULT_CONFIG.maxSnapshots);
  config.maxHistory = clampInt(config.maxHistory, 2, 100, DEFAULT_CONFIG.maxHistory);
  config.maxIncidents = clampInt(config.maxIncidents, 2, 500, DEFAULT_CONFIG.maxIncidents);
  for (const flag of ['autoVerify', 'autoRollback', 'autoRestartStable', 'notify', 'observeOnly', 'dryRun']) {
    config[flag] = Boolean(config[flag]);
  }
  config.profile = String(config.profile || 'desktop');
  config.appProcessName = String(config.appProcessName || DEFAULT_CONFIG.appProcessName);
  return config;
}

export async function loadConfig() {
  const raw = await readJsonSafe(configPath(), {});
  const merged = normalizeConfig(raw && typeof raw === 'object' ? raw : {});
  const paths = resolvePaths(merged);
  const nodeExe = merged.nodeExe || process.execPath;
  return { config: { ...merged, nodeExe }, paths, exists: await pathExists(configPath()) };
}

export async function saveConfig(config) {
  const clean = normalizeConfig(config);
  await writeJsonAtomic(configPath(), clean);
  return clean;
}

export async function ensureStateDirs(paths) {
  for (const dir of [
    paths.stateDir,
    paths.runtimeDir,
    paths.logsDir,
    paths.snapshotsDir,
    paths.incidentsDir,
    paths.quarantineDir,
    paths.commandsDir,
    paths.resultsDir,
  ]) {
    await ensureDir(dir);
  }
}

export async function ensureConfigFile() {
  const loaded = await loadConfig();
  if (!loaded.exists) {
    const config = { ...loaded.config };
    if (!config.nodeExe || config.nodeExe === process.execPath) {
      config.nodeExe = process.execPath;
    }
    await saveConfig(config);
    return { ...loaded, config, exists: true };
  }
  return loaded;
}

export async function initDefaults() {
  const config = normalizeConfig({});
  config.dshHome = process.env.DSH_HOME ?? config.dshHome;
  config.nodeExe = process.execPath;
  if (process.env.DSH_WEB_URL) config.webUrlHint = process.env.DSH_WEB_URL;
  await saveConfig(config);
  return loadConfig();
}

export function describeConfig(config) {
  const secretFree = { ...config };
  return secretFree;
}

export function readConfigFileRaw() {
  return fs.readFile(configPath(), 'utf8');
}
