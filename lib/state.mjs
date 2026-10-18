import { nowIso, readJsonSafe, writeJsonAtomic } from './util.mjs';

export const GUARDIAN_VERSION = '1.0.1';

export const PHASE_LABELS = {
  starting: '初始化',
  stable: '守护中 · 稳定',
  awaiting: '检测到变更 · 等待加载',
  probation: '新插件试用期',
  verifying: '正在安全重启验证',
  'rolling-back': '正在回滚',
  attention: '需要处理',
  paused: '已暂停',
};

export const HEALTH_LABELS = {
  healthy: '运行正常',
  starting: '启动中',
  degraded: '服务异常',
  down: '未运行',
  unknown: '状态未知',
};

export function defaultState() {
  return {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'starting',
    paused: false,
    baseline: null,
    history: [],
    candidate: null,
    app: {
      state: null,
      mainPid: null,
      hostPid: null,
      port: null,
      mainStartedAt: null,
      consecutiveUnhealthy: 0,
      downSince: null,
      lastHealthyAt: null,
      lastBootAt: null,
      lastProbe: null,
      restartHistory: [],
    },
    counters: { promotions: 0, rollbacks: 0, restarts: 0, incidents: 0, crashes: 0 },
    timeline: [],
    lastEvent: null,
    install: { lastOperationAt: null, lastOperationName: null },
    lastIncident: null,
    lastRollback: null,
    attention: null,
    daemonStartedAt: null,
  };
}

export async function loadState(paths) {
  const raw = await readJsonSafe(paths.statePath, null);
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    app: { ...base.app, ...(raw.app ?? {}) },
    counters: { ...base.counters, ...(raw.counters ?? {}) },
    install: { ...base.install, ...(raw.install ?? {}) },
    history: Array.isArray(raw.history) ? raw.history : [],
    timeline: Array.isArray(raw.timeline) ? raw.timeline.slice(-120) : [],
  };
}

export async function saveState(paths, state) {
  state.updatedAt = Date.now();
  if (state.timeline.length > 120) state.timeline = state.timeline.slice(-120);
  await writeJsonAtomic(paths.statePath, state);
}

export function pushEvent(state, level, code, message, data, { quiet = false } = {}) {
  const entry = { at: Date.now(), level, code, message, ...(data === undefined ? {} : { data }) };
  state.timeline.push(entry);
  if (state.timeline.length > 120) state.timeline = state.timeline.slice(-120);
  if (!quiet) state.lastEvent = entry;
  return entry;
}

export function describeHealth(health) {
  if (!health) return { state: 'unknown', label: HEALTH_LABELS.unknown };
  return {
    state: health.state,
    label: HEALTH_LABELS[health.state] ?? health.state,
    mainPid: health.mainPid ?? null,
    hostPid: health.hostPid ?? null,
    port: health.port ?? null,
    url: health.port ? `http://127.0.0.1:${health.port}/` : null,
    httpStatus: health.httpStatus ?? null,
    error: health.error ?? null,
    mainStartedAt: health.mainStartedAt ?? null,
    checkedAt: health.checkedAt ?? null,
    durationMs: health.durationMs ?? null,
    uptimeSec: health.mainStartedAt ? Math.max(0, Math.round((Date.now() - health.mainStartedAt) / 1000)) : null,
  };
}

export function buildStatus({ state, config, paths, health, profile, logger, daemonPid, lastTickAt }) {
  const phase = state.paused ? 'paused' : state.phase;
  const probationRemainingMs =
    state.candidate?.phase === 'probation' && state.candidate.probationEndsAt
      ? Math.max(0, state.candidate.probationEndsAt - Date.now())
      : null;
  const candidate = state.candidate
    ? {
        fingerprint: state.candidate.fingerprint,
        shortFingerprint: state.candidate.fingerprint?.slice(0, 12) ?? null,
        phase: state.candidate.phase,
        detectedAt: state.candidate.detectedAt,
        probationEndsAt: state.candidate.probationEndsAt ?? null,
        probationRemainingMs,
        bootDeadline: state.candidate.bootDeadline ?? null,
        changeSummary: state.candidate.changeSummary ?? null,
        pluginNames: state.candidate.pluginNames ?? [],
        failures: state.candidate.failures ?? 0,
      }
    : null;
  const baseline = state.baseline
    ? {
        ...state.baseline,
        shortId: state.baseline.id,
        ageSec: state.baseline.createdAt ? Math.round((Date.now() - state.baseline.createdAt) / 1000) : null,
      }
    : null;
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    updatedAtIso: nowIso(),
    guardianVersion: GUARDIAN_VERSION,
    daemon: {
      running: true,
      pid: daemonPid ?? process.pid,
      startedAt: state.daemonStartedAt,
      uptimeSec: state.daemonStartedAt ? Math.round((Date.now() - state.daemonStartedAt) / 1000) : null,
      lastTickAt: lastTickAt ?? Date.now(),
      intervalMs: config.intervalMs,
      mode: config.observeOnly ? 'observe' : config.dryRun ? 'dry-run' : 'active',
    },
    phase,
    phaseLabel: PHASE_LABELS[phase] ?? phase,
    paused: state.paused,
    app: describeHealth(health),
    profile: {
      dir: paths.profileDir,
      exists: profile?.exists ?? false,
      fingerprint: profile?.fingerprint ?? null,
      shortFingerprint: profile?.fingerprint?.slice(0, 12) ?? null,
      fileCount: profile?.files?.length ?? 0,
      deps: profile?.deps ?? {},
      bundles: profile?.bundles ?? [],
      latestOperation: profile?.latestOperation ?? null,
      error: profile?.error ?? null,
    },
    baseline,
    candidate,
    install: state.install,
    counters: state.counters,
    lastIncident: state.lastIncident,
    lastRollback: state.lastRollback,
    attention: state.attention,
    lastEvent: state.lastEvent,
    recentEvents: state.timeline.slice(-12),
    logTail: logger ? logger.recent(10) : [],
    config: {
      autoVerify: config.autoVerify,
      autoRollback: config.autoRollback,
      autoRestartStable: config.autoRestartStable,
      notify: config.notify,
      probationMs: config.probationMs,
      startupGraceMs: config.startupGraceMs,
      observeOnly: config.observeOnly,
      dryRun: config.dryRun,
    },
    paths: {
      stateDir: paths.stateDir,
      logPath: paths.logPath,
      incidentsDir: paths.incidentsDir,
      snapshotsDir: paths.snapshotsDir,
      profileDir: paths.profileDir,
    },
  };
}

export async function readStatus(paths) {
  return readJsonSafe(paths.statusPath, null);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
