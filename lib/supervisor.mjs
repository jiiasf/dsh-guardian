import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  pathExists,
  readJsonSafe,
  shortId,
  sleep,
  writeJsonAtomic,
} from './util.mjs';
import { ensureStateDirs, loadConfig } from './config.mjs';
import {
  collectProfile,
  diffProfileAgainstMeta,
  profileAppVersion,
} from './profile.mjs';
import { createSnapshot, listSnapshots, loadSnapshot, pruneSnapshots, restoreSnapshot } from './snapshot.mjs';
import { buildStatus, defaultState, isProcessAlive, loadState, pushEvent, saveState } from './state.mjs';
import { probeHealth, restartApp, startApp, stopApp, waitForHealthy } from './proc.mjs';
import { planTick } from './decide.mjs';
import { notify } from './notify.mjs';
import { checkCrashEvidence, collectIncident } from './incident.mjs';
import { GUARDIAN_VERSION } from './state.mjs';

const LOCK_NAME = 'daemon.lock';

function historyEntry(meta) {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    fingerprint: meta.fingerprint,
    reason: meta.reason,
    note: meta.note ?? null,
    pluginNames: meta.pluginNames ?? [],
  };
}

export class GuardianDaemon {
  constructor({ config, paths, logger, overrides = {} }) {
    this.config = { ...config, ...overrides };
    this.overridesFromCli = overrides;
    this.paths = paths;
    this.logger = logger;
    this.state = defaultState();
    this.health = null;
    this.profile = null;
    this.observed = { fingerprint: null, stableSince: 0, lastChangeAt: 0 };
    this.lockPath = path.join(paths.runtimeDir, LOCK_NAME);
    this.stopping = false;
    this.lastStatusAt = 0;
    this.tickCount = 0;
    this.configMtime = 0;
    this.startedAt = Date.now();
    this.stopRequested = false;
    this._lastDryRunAt = 0;
  }

  async acquireLock() {
    await ensureDir(this.paths.runtimeDir);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        await handle.close();
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const record = await readJsonSafe(this.lockPath, null);
        if (record?.pid && record.pid !== process.pid && isProcessAlive(record.pid)) {
          throw new Error(`守护进程已在运行（PID ${record.pid}）`);
        }
        await fs.rm(this.lockPath, { force: true });
      }
    }
    throw new Error('无法获取守护进程锁');
  }

  async releaseLock() {
    try {
      const record = await readJsonSafe(this.lockPath, null);
      if (!record || record.pid === process.pid) await fs.rm(this.lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  async init() {
    await ensureStateDirs(this.paths);
    this.configMtime = await this.getConfigMtime();
    this.state = await loadState(this.paths);
    this.state.daemonStartedAt = Date.now();
    this.state.app.healthySince = null;
    this.syncAutoSnapshotSchedule(Date.now());
    pushEvent(this.state, 'info', 'daemon.start', '守护进程启动', {
      pid: process.pid,
      version: GUARDIAN_VERSION,
      mode: this.mode(),
    });
    await this.logger.info('daemon.start', 'DSH 守护进程启动', {
      pid: process.pid,
      version: GUARDIAN_VERSION,
      profileDir: this.paths.profileDir,
      stateDir: this.paths.stateDir,
      mode: this.mode(),
    });
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
  }

  mode() {
    if (this.config.observeOnly) return 'observe';
    if (this.config.dryRun) return 'dry-run';
    return 'active';
  }

  autoSnapshotIntervalMs() {
    return Math.max(60000, Number(this.config.autoSnapshotHours) * 3600 * 1000);
  }

  /** Recompute the next periodic healthy-snapshot deadline from the last saved version. */
  syncAutoSnapshotSchedule(now = Date.now()) {
    const auto = this.state.autoSnapshot ?? (this.state.autoSnapshot = {
      lastSavedAt: null,
      nextAt: null,
      lastId: null,
      lastPruned: [],
      lastError: null,
    });
    if (!this.config.autoSnapshotEnabled) {
      auto.nextAt = null;
      return;
    }
    const anchor = auto.lastSavedAt ?? this.state.baseline?.createdAt ?? null;
    if (!anchor) {
      auto.nextAt = null;
      return;
    }
    auto.nextAt = Math.max(now, anchor + this.autoSnapshotIntervalMs());
  }

  /** A baseline was (re)established; restart the 12-hour countdown from now. */
  rememberHealthyVersion(meta, now = Date.now()) {
    if (!meta) return;
    const auto = this.state.autoSnapshot ?? (this.state.autoSnapshot = {
      lastSavedAt: null,
      nextAt: null,
      lastId: null,
      lastPruned: [],
      lastError: null,
    });
    auto.lastSavedAt = now;
    auto.lastId = meta.id ?? null;
    auto.lastPruned = [];
    auto.lastError = null;
    this.syncAutoSnapshotSchedule(now);
  }

  /**
   * Save the current healthy profile and remove older snapshots according to
   * `autoSnapshotRetention` (default: keep only the new one).
   */
  async autoSnapshot(reason = 'scheduled') {
    const now = Date.now();
    const interval = this.autoSnapshotIntervalMs();
    if (this.config.observeOnly || this.config.dryRun) {
      const message = `演练/仅观察模式：将自动保存健康版本（${reason}），但未执行。`;
      this.state.autoSnapshot.nextAt = now + interval;
      this.state.autoSnapshot.lastError = null;
      pushEvent(this.state, 'warn', 'autoSnapshot.skipped', message, { reason });
      await this.logger.warn('autoSnapshot.skipped', message, { reason });
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
      return { ok: false, skipped: true, message };
    }

    const health = await probeHealth(this.config);
    this.health = health;
    if (health.state !== 'healthy') {
      this.state.autoSnapshot.nextAt = now + 60000;
      this.state.autoSnapshot.lastError = `自动快照推迟：DSH 状态为 ${health.state}`;
      pushEvent(this.state, 'warn', 'autoSnapshot.deferred', '自动快照推迟：DSH 当前不健康', {
        state: health.state,
        error: health.error ?? null,
      });
      await this.logger.warn('autoSnapshot.deferred', '自动快照推迟：DSH 当前不健康', {
        state: health.state,
        error: health.error ?? null,
      });
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
      return { ok: false, deferred: true, message: 'DSH 当前不健康，已推迟自动快照' };
    }

    const profile = await collectProfile(this.paths.profileDir);
    this.profile = profile;
    if (!profile.ok) {
      this.state.autoSnapshot.nextAt = now + 5 * 60000;
      this.state.autoSnapshot.lastError = `自动快照失败：profile 不可读`;
      pushEvent(this.state, 'error', 'autoSnapshot.failed', '自动快照失败：profile 不可读', {
        error: profile.error ?? null,
      });
      await this.logger.error('autoSnapshot.failed', '自动快照失败：profile 不可读', {
        error: profile.error ?? null,
      });
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
      return { ok: false, message: profile.error ?? 'profile 不可读' };
    }

    let meta;
    try {
      meta = await createSnapshot(this.paths, profile, {
        reason: 'auto',
        note: `每 ${this.config.autoSnapshotHours} 小时自动保存的健康版本`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.autoSnapshot.nextAt = now + 5 * 60000;
      this.state.autoSnapshot.lastError = `自动快照失败：${message}`;
      pushEvent(this.state, 'error', 'autoSnapshot.failed', '自动快照失败，稍后重试', { error: message });
      await this.logger.error('autoSnapshot.failed', '自动快照失败，稍后重试', { error: message });
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
      return { ok: false, message };
    }

    meta.pluginNames = Object.keys(profile.deps ?? {});
    const entry = historyEntry(meta);
    entry.pluginNames = meta.pluginNames;
    this.state.baseline = entry;
    this.state.history = [entry, ...(this.state.history ?? []).filter((item) => item.id !== entry.id)].slice(
      0,
      this.config.maxHistory,
    );
    this.state.phase = 'stable';
    this.state.attention = null;
    this.state.counters.autoSnapshots = (this.state.counters.autoSnapshots ?? 0) + 1;
    this.rememberHealthyVersion(meta, now);

    let pruned = [];
    try {
      pruned = await pruneSnapshots(this.paths, {
        keep: Math.min(this.config.autoSnapshotRetention, this.config.maxSnapshots),
        protect: [entry.id],
      });
      const remaining = await listSnapshots(this.paths);
      const ids = new Set(remaining.map((snapshot) => snapshot.id));
      this.state.history = this.state.history
        .filter((item) => item.id === entry.id || ids.has(item.id))
        .slice(0, this.config.maxHistory);
    } catch (error) {
      this.state.autoSnapshot.lastError = `旧快照清理失败：${error instanceof Error ? error.message : String(error)}`;
      await this.logger.warn('autoSnapshot.prune-failed', '自动快照已保存，但旧快照清理失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.state.autoSnapshot.lastPruned = pruned;
    this.state.autoSnapshot.lastError = this.state.autoSnapshot.lastError ?? null;

    pushEvent(this.state, 'info', 'autoSnapshot.saved', '已自动保存健康版本并清理旧快照', {
      id: entry.id,
      pruned,
      retention: this.config.autoSnapshotRetention,
    });
    await this.logger.info('autoSnapshot.saved', '已自动保存健康版本并清理旧快照', {
      id: entry.id,
      pruned,
      retention: this.config.autoSnapshotRetention,
    });
    notify(
      this.config,
      this.logger,
      'info',
      'DSH 守护 · 已自动保存健康版本',
      `已保存 ${entry.id} 为新的良好版本，并清理 ${pruned.length} 个旧版本。`,
    );
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    return { ok: true, id: entry.id, pruned };
  }

  async getConfigMtime() {
    try {
      return (await fs.stat(this.paths.configPath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async reloadConfigIfNeeded() {
    const mtime = await this.getConfigMtime();
    if (mtime === this.configMtime) return;
    this.configMtime = mtime;
    try {
      const loaded = await loadConfig();
      this.config = { ...loaded.config, ...this.overridesFromCli };
      this.syncAutoSnapshotSchedule(Date.now());
      await this.logger.info('config.reload', '配置已重新加载', describeFlags(this.config));
      await this.writeStatus(true);
    } catch (error) {
      await this.logger.warn('config.reload.failed', '配置重新加载失败，保留原配置', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setCliOverrides(overrides) {
    this.overridesFromCli = overrides ?? {};
  }

  async run() {
    await this.acquireLock();
    try {
      await this.init();
      process.on('SIGINT', () => {
        this.stopping = true;
      });
      process.on('SIGTERM', () => {
        this.stopping = true;
      });
      while (!this.stopping) {
        const cycleStarted = Date.now();
        try {
          await this.reloadConfigIfNeeded();
          await this.checkStopRequest();
          if (this.stopping) break;
          await this.processCommands();
          if (this.stopping) break;
          await this.tick();
        } catch (error) {
          await this.logger.error('tick.failed', '守护循环发生异常', {
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          });
          this.state.phase = 'attention';
          this.state.attention = {
            reason: 'daemon-error',
            message: error instanceof Error ? error.message : String(error),
            since: Date.now(),
          };
          await this.writeStatus(true).catch(() => {});
        }
        const elapsed = Date.now() - cycleStarted;
        const wait = Math.max(500, this.config.intervalMs - elapsed);
        await sleep(wait);
      }
    } finally {
      await this.shutdown();
    }
  }

  async checkStopRequest() {
    try {
      if (await pathExists(this.paths.stopPath)) {
        await fs.rm(this.paths.stopPath, { force: true });
        this.stopping = true;
      }
    } catch {
      /* ignore */
    }
  }

  async shutdown() {
    this.state.phase = this.state.paused ? 'paused' : this.state.phase;
    pushEvent(this.state, 'info', 'daemon.stop', '守护进程停止');
    await this.logger.info('daemon.stop', '守护进程停止', { pid: process.pid });
    try {
      await saveState(this.paths, this.state);
    } catch {
      /* ignore */
    }
    try {
      const status = buildStatus({
        state: this.state,
        config: this.config,
        paths: this.paths,
        health: this.health,
        profile: this.profile,
        logger: this.logger,
        daemonPid: process.pid,
      });
      status.daemon.running = false;
      status.daemon.pid = process.pid;
      status.updatedAt = Date.now();
      status.updatedAtIso = nowIso();
      await writeJsonAtomic(this.paths.statusPath, status);
    } catch {
      /* ignore */
    }
    await this.releaseLock();
    await this.logger.flush();
  }

  async tick() {
    this.tickCount += 1;
    const profile = await collectProfile(this.paths.profileDir);
    this.profile = profile;
    const now = Date.now();
    if (profile.fingerprint !== this.observed.fingerprint) {
      this.observed = {
        fingerprint: profile.fingerprint,
        stableSince: now,
        lastChangeAt: now,
      };
    }
    const settle = Math.max(this.config.settleMs, profile.latestOperation?.active ? 8000 : 0);
    const profileStable = Boolean(profile.fingerprint) && now - this.observed.stableSince >= settle;

    const health = await probeHealth(this.config);
    this.health = health;

    const baselineMeta = this.state.baseline ? await loadSnapshot(this.paths, this.state.baseline.id) : null;
    if (this.state.baseline && !baselineMeta) {
      if (!this.state.attention || this.state.attention.reason !== 'baseline-missing') {
        this.state.attention = {
          reason: 'baseline-missing',
          message: `基线快照 ${this.state.baseline.id} 丢失，无法自动回滚。请重新做一次「立即快照」。`,
          since: now,
        };
        await this.logger.error('baseline.missing', '基线快照丢失', { id: this.state.baseline.id });
        notify(this.config, this.logger, 'error', 'DSH 守护 · 基线丢失', '基线快照丢失，自动回滚已不可用，请重新快照。');
      }
    }

    const { state, actions } = planTick(this.state, {
      now,
      config: this.config,
      health,
      profile,
      profileStable,
      baselineMeta,
    });
    this.state = state;
    await this.executeActions(actions, { health, profile, baselineMeta });
    await saveState(this.paths, this.state);
    await this.writeStatus();
  }

  async writeStatus(force = false) {
    const now = Date.now();
    if (!force && now - this.lastStatusAt < 1200) return;
    this.lastStatusAt = now;
    const status = buildStatus({
      state: this.state,
      config: this.config,
      paths: this.paths,
      health: this.health,
      profile: this.profile,
      logger: this.logger,
      daemonPid: process.pid,
      lastTickAt: now,
    });
    await writeJsonAtomic(this.paths.statusPath, status).catch(() => {});
  }

  async executeActions(actions, context) {
    if (!actions?.length) return;
    for (const action of actions) {
      if (this.stopping) break;
      switch (action.type) {
        case 'ADOPT_BASELINE':
          await this.adoptBaseline(action.reason ?? 'initial');
          break;
        case 'CANDIDATE_DETECTED':
          pushEvent(this.state, 'warn', 'candidate.detected', '检测到 profile 变更，等待 DSH 重启加载', {
            summary: action.summary,
          });
          await this.logger.warn('candidate.detected', '检测到 profile 变更', { summary: action.summary });
          break;
        case 'CANDIDATE_UPDATED':
          pushEvent(this.state, 'warn', 'candidate.updated', '插件配置再次变化，试用计时重置', {
            summary: action.summary,
          });
          await this.logger.warn('candidate.updated', '插件配置再次变化', { summary: action.summary });
          break;
        case 'CANDIDATE_CLEARED':
          pushEvent(this.state, 'info', 'candidate.cleared', 'profile 已恢复到基线，取消试用', {
            reason: action.reason,
          });
          await this.logger.info('candidate.cleared', 'profile 已恢复到基线，取消试用');
          break;
        case 'ENTER_PROBATION':
          pushEvent(this.state, 'info', 'probation.enter', '新插件进入试用期', {
            probationMs: action.probationMs,
          });
          await this.logger.info('probation.enter', '新插件进入试用期', { probationMs: action.probationMs });
          break;
        case 'PROBATION_EXTENDED':
          await this.logger.warn('probation.extended', '试用期内检测到重启，试用期重新计时', {
            restarts: action.restarts,
          });
          break;
        case 'PROMOTE':
          await this.promote(action.reason ?? 'probation-passed');
          break;
        case 'AUTO_SNAPSHOT':
          await this.autoSnapshot(action.reason ?? 'scheduled');
          break;
        case 'ROLLBACK':
          await this.performRollback({ reason: action.reason, kind: action.kind, automated: true });
          return;
        case 'VERIFY_RESTART':
          await this.performVerifyRestart(action.reason ?? 'manual-verify');
          return;
        case 'RESTART_APP':
          await this.performRestart(action.reason ?? 'stable-restart');
          return;
        case 'CHECK_CRASH': {
          const evidence = await checkCrashEvidence(this.config, { minutes: action.minutes ?? 15 });
          this.state.app.crashEvidence = { ...evidence, checkedAt: Date.now() };
          await this.logger.info('crash.check', evidence.found ? '发现 Windows 崩溃记录' : '未发现 Windows 崩溃记录', {
            events: evidence.events?.length ?? 0,
          });
          break;
        }
        case 'BOOT_CONFIRM':
          await this.logger.info('boot.confirm', '检测到 DSH 正在启动', { state: action.state });
          break;
        case 'NOTIFY':
          notify(this.config, this.logger, action.level, action.title, action.message);
          break;
        default:
          await this.logger.warn('action.unknown', '未知的守护动作', { type: action.type });
      }
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
    }
  }

  async adoptBaseline(reason) {
    try {
      const profile = this.profile ?? (await collectProfile(this.paths.profileDir));
      const meta = await createSnapshot(this.paths, profile, {
        reason: reason === 'initial' ? 'baseline' : reason,
        note: reason === 'initial' ? '初始良好基线' : null,
      });
      meta.pluginNames = Object.keys(profile.deps ?? {});
      this.state.baseline = historyEntry(meta);
      this.state.history = [historyEntry(meta)];
      this.state.phase = 'stable';
      this.state.attention = null;
      this.rememberHealthyVersion(meta);
      pushEvent(this.state, 'info', 'baseline.adopted', '已记录当前状态为良好基线', { id: meta.id });
      await this.logger.info('baseline.adopted', '已记录当前状态为良好基线', {
        id: meta.id,
        files: meta.copiedFiles?.length ?? 0,
      });
      notify(this.config, this.logger, 'info', 'DSH 守护已就绪', `已记录当前 DSH 状态为良好基线（${meta.id}）。`);
      await this.writeStatus(true);
    } catch (error) {
      this.state.attention = {
        reason: 'snapshot-failed',
        message: `无法建立基线快照：${error instanceof Error ? error.message : String(error)}`,
        since: Date.now(),
      };
      this.state.phase = 'attention';
      await this.logger.error('baseline.failed', '建立基线快照失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      notify(this.config, this.logger, 'error', 'DSH 守护 · 快照失败', '无法建立良好基线，守护能力受限。');
    }
  }

  async promote(reason) {
    try {
      const profile = this.profile ?? (await collectProfile(this.paths.profileDir));
      const pluginNames = this.state.candidate?.pluginNames ?? [];
      const meta = await createSnapshot(this.paths, profile, {
        reason: 'promote',
        note: pluginNames.length ? `新插件通过验证：${pluginNames.join(', ')}` : '试用期通过',
      });
      const entry = historyEntry(meta);
      entry.pluginNames = pluginNames;
      this.state.baseline = entry;
      this.state.history = [entry, ...(this.state.history ?? []).filter((item) => item.id !== entry.id)].slice(
        0,
        this.config.maxHistory,
      );
      this.state.candidate = null;
      this.state.phase = 'stable';
      this.state.attention = null;
      this.state.counters.promotions += 1;
      this.rememberHealthyVersion(meta);
      pushEvent(this.state, 'info', 'baseline.promoted', '插件通过稳定性验证，已记为良好版本', { id: meta.id, pluginNames });
      await this.logger.info('baseline.promoted', '插件通过稳定性验证，已记为良好版本', {
        id: meta.id,
        pluginNames,
      });
      notify(
        this.config,
        this.logger,
        'info',
        'DSH 守护 · 插件验证通过',
        `${pluginNames.length ? pluginNames.join('、') : '新配置'} 已通过稳定性验证，并记为新的良好版本。`,
      );
      await pruneSnapshots(this.paths, {
        keep: this.config.maxSnapshots,
        protect: this.state.history.map((item) => item.id),
      });
      await this.writeStatus(true);
    } catch (error) {
      await this.logger.error('promote.failed', '记录良好版本失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.state.candidate) {
        this.state.candidate.probationEndsAt = Date.now() + 60000;
      }
    }
  }

  async collectRollbackEvidence({ kind, reason, health, profile, baselineMeta }) {
    let crashEvidence = this.state.app.crashEvidence ?? null;
    if (!crashEvidence) {
      crashEvidence = await checkCrashEvidence(this.config, { minutes: 20 });
    }
    return collectIncident({
      paths: this.paths,
      config: this.config,
      state: this.state,
      health: health ?? this.health,
      profile: profile ?? this.profile,
      baselineSnapshot: baselineMeta,
      kind,
      reason,
      crashEvidence,
      timeline: this.state.timeline,
      extra: { guardianVersion: GUARDIAN_VERSION, mode: this.mode() },
      logger: this.logger,
    });
  }

  async performRollback({ reason, kind, automated = true, targetId = null, explicitTarget = false }) {
    if (automated && !this.config.autoRollback) {
      if (this.state.attention?.reason !== 'auto-rollback-disabled') {
        this.state.attention = {
          reason: 'auto-rollback-disabled',
          message: `检测到异常（${reason}），但配置中 autoRollback=false，未执行自动回滚。可在面板手动回滚。`,
          since: Date.now(),
        };
        this.state.phase = 'attention';
        await this.logger.warn('rollback.disabled', '自动回滚已关闭，未执行', { reason });
        notify(this.config, this.logger, 'warn', 'DSH 守护 · 自动回滚已关闭', '检测到异常，但自动回滚已关闭；可在面板手动回滚。');
        await this.writeStatus(true);
      }
      return { ok: false, skipped: true, message: '自动回滚已关闭（autoRollback=false）' };
    }
    if (this.config.dryRun) {
      const now = Date.now();
      if (this._lastDryRunAt && now - this._lastDryRunAt < 60000) {
        return { ok: true, dryRun: true, skipped: true, message: '演练回滚冷却中（每分钟最多一次）' };
      }
      this._lastDryRunAt = now;
    }
    if (this.config.observeOnly) {
      this.state.attention = {
        reason: 'observe-only',
        message: `检测到需要回滚（${reason}），但守护处于仅观察模式，未执行任何操作。`,
        since: Date.now(),
      };
      this.state.phase = 'attention';
      await this.logger.warn('rollback.observe', '仅观察模式：检测到需要回滚，未执行', { reason });
      notify(this.config, this.logger, 'warn', 'DSH 守护 · 仅观察模式', '检测到异常，但守护当前只观察、不执行回滚。');
      await this.writeStatus(true);
      return { ok: false, skipped: true };
    }

    const health = this.health ?? (await probeHealth(this.config));
    const profile = this.profile ?? (await collectProfile(this.paths.profileDir));
    let target = targetId ? await loadSnapshot(this.paths, targetId) : null;
    if (!target && this.state.baseline) target = await loadSnapshot(this.paths, this.state.baseline.id);
    if (!target) {
      const snapshots = await listSnapshots(this.paths);
      target = snapshots[0] ?? null;
    }
    if (!target) {
      this.state.attention = {
        reason: 'no-snapshot',
        message: `检测到异常（${reason}），但没有任何可用快照，无法回滚。`,
        since: Date.now(),
      };
      this.state.phase = 'attention';
      await this.logger.error('rollback.no-snapshot', '没有可回滚的快照', { reason });
      notify(this.config, this.logger, 'error', 'DSH 守护 · 无法回滚', '没有任何可用快照，请手动检查插件。');
      await this.writeStatus(true);
      return { ok: false, error: 'no-snapshot' };
    }

    this.state.phase = 'rolling-back';
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    pushEvent(this.state, 'error', 'rollback.start', `开始回滚（${reason}）`, {
      target: target.id,
      kind,
    });
    await this.logger.error('rollback.start', '开始回滚到良好快照', {
      reason,
      kind,
      target: target.id,
      current: profile.fingerprint,
    });

    const incident = await this.collectRollbackEvidence({ kind, reason, health, profile, baselineMeta: target });

    if (this.config.dryRun) {
      const message = `演练模式：将回滚到 ${target.id}，但未执行停止/恢复/重启。`;
      this.state.attention = { reason: 'dry-run-rollback', message, since: Date.now() };
      this.state.phase = 'attention';
      await this.logger.warn('rollback.dry-run', message);
      notify(this.config, this.logger, 'warn', 'DSH 守护 · 演练模式', message);
      await this.writeStatus(true);
      return {
        ok: true,
        dryRun: true,
        message: `${message} 事件报告：${incident.reportPath}`,
        target: target.id,
        incidentId: incident.id,
        reportPath: incident.reportPath,
      };
    }

    const historyIds = (this.state.history ?? []).map((item) => item.id);
    const candidates = [target.id, ...historyIds.filter((id) => id !== target.id)];
    let attemptResult = null;

    for (const snapshotId of candidates) {
      const snapshot = await loadSnapshot(this.paths, snapshotId);
      if (!snapshot) continue;
      await this.logger.info('rollback.attempt', '尝试恢复到快照', { snapshotId });
      const stopResult = await stopApp(this.config, this.logger);
      if (!stopResult.ok) {
        attemptResult = { ok: false, error: 'stop-failed' };
        break;
      }
      const restoreResult = await restoreSnapshot(this.paths, snapshot, {
        profileDir: this.paths.profileDir,
        currentProfile: profile,
        logger: this.logger,
        incidentId: incident.id,
      });
      if (restoreResult.errors.length > 0) {
        await this.logger.warn('rollback.restore.warnings', '恢复过程中有警告', {
          errors: restoreResult.errors,
        });
      }
      await this.writeStatus(true);
      await startApp(this.config, this.logger);
      const boot = await waitForHealthy(this.config, {
        timeoutMs: this.config.startupGraceMs,
        onProgress: () => this.writeStatus().catch(() => {}),
      });
      this.health = boot.health;
      attemptResult = {
        ...boot,
        snapshotId: snapshot.id,
        restoreResult,
      };
      if (boot.ok) break;
      await this.logger.warn('rollback.boot-failed', '恢复后启动失败，尝试更早的快照', {
        snapshotId: snapshot.id,
        health: boot.health?.state,
      });
    }

    const finishedAt = Date.now();
    if (attemptResult?.ok) {
      const snapshot = await loadSnapshot(this.paths, attemptResult.snapshotId);
      this.state.candidate = null;
      this.state.phase = 'stable';
      this.state.attention = null;
      this.state.counters.rollbacks += 1;
      this.state.counters.incidents += 1;
      this.state.lastRollback = {
        at: finishedAt,
        baselineId: attemptResult.snapshotId,
        reason,
        kind,
        success: true,
      };
      if (snapshot) {
        const entry = historyEntry(snapshot);
        this.state.baseline = entry;
        this.state.history = [entry, ...(this.state.history ?? []).filter((item) => item.id !== entry.id)].slice(
          0,
          this.config.maxHistory,
        );
        this.rememberHealthyVersion(snapshot, finishedAt);
      }
      this.state.lastIncident = {
        id: incident.id,
        at: finishedAt,
        kind,
        reason,
        reportPath: incident.reportPath,
        rollbackId: attemptResult.snapshotId,
        success: true,
      };
      pushEvent(this.state, 'info', 'rollback.success', '回滚成功，DSH 已恢复运行', {
        snapshotId: attemptResult.snapshotId,
        incidentId: incident.id,
      });
      await this.logger.info('rollback.success', '回滚成功，DSH 已恢复运行', {
        snapshotId: attemptResult.snapshotId,
        incidentId: incident.id,
      });
      await appendReport(incident.reportPath, [
        '',
        '## 回滚结果',
        '',
        '- 结果：**成功**',
        `- 恢复快照：\`${attemptResult.snapshotId}\``,
        `- 恢复文件数：${attemptResult.restoreResult?.restored?.length ?? 0}`,
        `- 移除文件数：${attemptResult.restoreResult?.removed?.length ?? 0}`,
        `- 隔离依赖：${attemptResult.restoreResult?.quarantined?.join(', ') || '无'}`,
        `- DSH 新主进程 PID：${attemptResult.health?.mainPid ?? '未知'}`,
        `- 完成时间：${new Date(finishedAt).toLocaleString('zh-CN', { hour12: false })}`,
        '',
      ]);
      notify(
        this.config,
        this.logger,
        'info',
        'DSH 守护 · 已自动回滚',
        `检测到插件导致异常，已恢复到 ${attemptResult.snapshotId}，DSH 重新运行正常。报告：${path.basename(incident.dir)}`,
      );
      await pruneSnapshots(this.paths, {
        keep: this.config.maxSnapshots,
        protect: this.state.history.map((item) => item.id),
      });
    } else {
      this.state.phase = 'attention';
      this.state.counters.incidents += 1;
      this.state.attention = {
        reason: 'rollback-failed',
        message: `回滚后 DSH 仍未能正常运行。请打开事件报告或手动处理。${
          attemptResult?.health?.error ? `（${attemptResult.health.error}）` : ''
        }`,
        since: finishedAt,
      };
      this.state.lastIncident = {
        id: incident.id,
        at: finishedAt,
        kind,
        reason,
        reportPath: incident.reportPath,
        rollbackId: target.id,
        success: false,
      };
      pushEvent(this.state, 'error', 'rollback.failed', '回滚失败，需要人工处理', {
        incidentId: incident.id,
      });
      await this.logger.error('rollback.failed', '回滚失败，需要人工处理', {
        incidentId: incident.id,
        health: attemptResult?.health?.state,
      });
      await appendReport(incident.reportPath, [
        '',
        '## 回滚结果',
        '',
        '- 结果：**失败**',
        `- 最后尝试的快照：\`${attemptResult?.snapshotId ?? target.id}\``,
        `- 回滚后状态：${attemptResult?.health?.state ?? 'unknown'}`,
        `- 错误：${attemptResult?.health?.error ?? '未知'}`,
        `- 报告时间：${new Date(finishedAt).toLocaleString('zh-CN', { hour12: false })}`,
        '',
        '请手动启动 DSH，或在插件页禁用最近安装的插件。',
        '',
      ]);
      notify(
        this.config,
        this.logger,
        'error',
        'DSH 守护 · 回滚失败',
        '自动回滚后 DSH 仍无法正常运行，请查看事件报告并手动处理。',
      );
    }

    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    return {
      ok: Boolean(attemptResult?.ok),
      message: attemptResult?.ok
        ? `已回滚到 ${attemptResult.snapshotId}，DSH 已恢复正常。`
        : `回滚失败：DSH 未能正常启动，请查看事件报告 ${incident.reportPath}。`,
      snapshotId: attemptResult?.snapshotId,
      incidentId: incident.id,
      reportPath: incident.reportPath,
      health: attemptResult?.health?.state,
    };
  }

  async performVerifyRestart(reason) {
    if (this.config.observeOnly || this.config.dryRun) {
      const message = `演练/仅观察模式：将安全重启 DSH 验证插件（${reason}），但未执行。`;
      this.state.attention = { reason: 'verify-skipped', message, since: Date.now() };
      this.state.phase = 'attention';
      await this.logger.warn('verify.skipped', message);
      await this.writeStatus(true);
      return { ok: false, skipped: true };
    }
    this.state.phase = 'verifying';
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    await this.logger.info('verify.restart', '开始安全重启以验证插件', { reason });
    const before = this.health;
    const result = await restartApp(this.config, this.logger, {
      timeoutMs: this.config.startupGraceMs,
      onProgress: () => this.writeStatus().catch(() => {}),
    });
    this.health = result.health;
    if (result.ok) {
      if (this.state.candidate) {
        this.state.candidate.phase = 'probation';
        this.state.candidate.bootPid = result.health.mainPid;
        this.state.candidate.bootStartedAt = Date.now();
        this.state.candidate.probationEndsAt = Date.now() + this.config.probationMs;
        this.state.candidate.failures = 0;
        this.state.candidate.sawBoot = true;
        this.state.phase = 'probation';
        pushEvent(this.state, 'info', 'verify.success', '安全重启成功，进入试用期');
        await this.logger.info('verify.success', '安全重启成功，进入试用期');
        notify(this.config, this.logger, 'info', 'DSH 守护 · 验证重启成功', '新配置已启动，进入试用期观察。');
      } else {
        this.state.phase = 'stable';
      }
      await saveState(this.paths, this.state);
      await this.writeStatus(true);
      return { ok: true, health: result.health };
    }

    await this.logger.error('verify.failed', '安全重启后 DSH 未能正常运行，准备回滚', {
      health: result.health?.state,
      error: result.health?.error,
    });
    const rollback = await this.performRollback({
      reason: `verify-restart-failed: ${reason}`,
      kind: 'plugin-boot-failure',
      automated: true,
    });
    if (rollback?.ok) {
      return {
        ok: true,
        recovered: true,
        message: `插件加载失败，已自动回滚到 ${rollback.snapshotId}，DSH 已恢复运行。`,
        health: result.health,
        rollback,
      };
    }
    return {
      ok: false,
      message: `插件加载失败，且自动回滚未成功：${rollback?.message ?? '未知错误'}`,
      health: result.health,
      rollback,
    };
  }

  async performRestart(reason) {
    if (this.config.observeOnly || this.config.dryRun) {
      await this.logger.warn('restart.skipped', '仅观察/演练模式：不执行重启', { reason });
      return { ok: false, skipped: true };
    }
    await this.logger.info('restart.start', '重启 DSH', { reason });
    const result = await restartApp(this.config, this.logger, {
      timeoutMs: this.config.startupGraceMs,
      onProgress: () => this.writeStatus().catch(() => {}),
    });
    this.health = result.health;
    if (result.ok) {
      this.state.counters.restarts += 1;
      this.state.candidate = null;
      this.state.phase = 'stable';
      this.state.attention = null;
      pushEvent(this.state, 'info', 'app.restarted', 'DSH 已自动重启', { reason });
      await this.logger.info('app.restarted', 'DSH 已自动重启', { reason, pid: result.health.mainPid });
    } else {
      this.state.phase = 'attention';
      this.state.attention = {
        reason: 'restart-failed',
        message: `DSH 重启失败：${result.health?.error ?? '未知错误'}`,
        since: Date.now(),
      };
      notify(this.config, this.logger, 'error', 'DSH 守护 · 重启失败', '尝试重启 DSH 失败，请手动启动。');
    }
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    return result;
  }

  async manualSnapshot({ note = '手动快照', force = false } = {}) {
    const health = await probeHealth(this.config);
    this.health = health;
    if (!force && health.state !== 'healthy') {
      return { ok: false, message: `当前 DSH 状态为 ${health.state}，只有运行正常时才能记为良好版本（可用 --force 强制）。` };
    }
    const profile = await collectProfile(this.paths.profileDir);
    const meta = await createSnapshot(this.paths, profile, { reason: 'manual', note });
    meta.pluginNames = Object.keys(profile.deps ?? {});
    const entry = historyEntry(meta);
    entry.pluginNames = meta.pluginNames;
    this.state.baseline = entry;
    this.state.history = [entry, ...(this.state.history ?? []).filter((item) => item.id !== entry.id)].slice(
      0,
      this.config.maxHistory,
    );
    this.state.candidate = null;
    this.state.phase = health.state === 'healthy' ? 'stable' : 'attention';
    this.state.attention = health.state === 'healthy'
      ? null
      : {
          reason: 'forced-snapshot',
          message: '已在 DSH 非健康状态下强制记录快照，该快照可能不是良好版本。',
          since: Date.now(),
        };
    if (health.state === 'healthy') this.rememberHealthyVersion(meta);
    pushEvent(this.state, 'info', 'snapshot.manual', '手动记录良好版本', { id: meta.id, note });
    await this.logger.info('snapshot.manual', '手动记录良好版本', { id: meta.id, note });
    await saveState(this.paths, this.state);
    await this.writeStatus(true);
    notify(this.config, this.logger, 'info', 'DSH 守护 · 快照完成', `已记录当前状态为良好版本（${meta.id}）。`);
    return { ok: true, id: meta.id, message: `已记录良好版本 ${meta.id}` };
  }

  async processCommands() {
    let entries = [];
    try {
      entries = await fs.readdir(this.paths.commandsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      if (this.stopping) return;
      const full = path.join(this.paths.commandsDir, file);
      const command = await readJsonSafe(full, null);
      await fs.rm(full, { force: true }).catch(() => {});
      if (!command?.id || !command?.type) continue;
      if (command.createdAt && Date.now() - command.createdAt > 15 * 60 * 1000) {
        await this.writeCommandResult(command.id, { ok: false, message: '命令已过期' });
        continue;
      }
      const result = await this.handleCommand(command);
      await this.writeCommandResult(command.id, result);
    }
  }

  async writeCommandResult(id, result) {
    const payload = { id, ...result, finishedAt: Date.now(), finishedAtIso: nowIso() };
    await writeJsonAtomic(path.join(this.paths.resultsDir, `${id}.json`), payload).catch(() => {});
  }

  async handleCommand(command) {
    const args = command.args ?? {};
    try {
      switch (command.type) {
        case 'snapshot':
          return await this.manualSnapshot({ note: args.note ?? '手动快照', force: Boolean(args.force) });
        case 'rollback': {
          if (args.to) {
            const snapshot = await loadSnapshot(this.paths, args.to);
            if (!snapshot) return { ok: false, message: `找不到快照 ${args.to}` };
          }
          const previousDryRun = this.config.dryRun;
          if (args.dryRun) this.config.dryRun = true;
          try {
            return await this.performRollback({
              reason: args.reason ?? 'manual-rollback',
              kind: 'manual',
              automated: false,
              targetId: args.to ?? null,
              explicitTarget: Boolean(args.to),
            });
          } finally {
            this.config.dryRun = previousDryRun;
          }
        }
        case 'verify':
          return await this.performVerifyRestart(args.reason ?? 'manual-verify');
        case 'restart':
          return await this.performRestart(args.reason ?? 'manual-restart');
        case 'pause':
          this.state.paused = true;
          this.state.phase = 'paused';
          pushEvent(this.state, 'info', 'daemon.paused', '守护已暂停');
          await this.logger.info('daemon.paused', '守护已暂停');
          await saveState(this.paths, this.state);
          await this.writeStatus(true);
          return { ok: true, message: '守护已暂停' };
        case 'resume':
          this.state.paused = false;
          this.state.phase = this.state.candidate ? 'awaiting' : 'stable';
          pushEvent(this.state, 'info', 'daemon.resumed', '守护已恢复');
          await this.logger.info('daemon.resumed', '守护已恢复');
          await saveState(this.paths, this.state);
          await this.writeStatus(true);
          return { ok: true, message: '守护已恢复' };
        case 'promote':
          await this.promote(args.reason ?? 'manual-promote');
          return { ok: Boolean(this.state.baseline), message: '已记录为良好版本' };
        case 'clear-attention':
          this.state.attention = null;
          this.state.phase = this.state.candidate ? 'awaiting' : 'stable';
          await saveState(this.paths, this.state);
          await this.writeStatus(true);
          return { ok: true, message: '已清除提醒' };
        case 'reload':
          await this.reloadConfigIfNeeded();
          return { ok: true, message: '配置已重新加载', data: describeFlags(this.config) };
        case 'status':
          return { ok: true, message: 'status', data: await this.statusSnapshot() };
        case 'doctor':
          return { ok: true, message: 'doctor', data: await this.doctor() };
        default:
          return { ok: false, message: `未知命令：${command.type}` };
      }
    } catch (error) {
      await this.logger.error('command.failed', '命令执行失败', {
        type: command.type,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async statusSnapshot() {
    const status = buildStatus({
      state: this.state,
      config: this.config,
      paths: this.paths,
      health: this.health,
      profile: this.profile,
      logger: this.logger,
      daemonPid: process.pid,
    });
    return status;
  }

  async doctor() {
    const health = await probeHealth(this.config);
    const profile = await collectProfile(this.paths.profileDir);
    const snapshots = await listSnapshots(this.paths);
    const baseline = this.state.baseline ? await loadSnapshot(this.paths, this.state.baseline.id) : null;
    const appVersion = await profileAppVersion(this.paths.profileDir);
    return {
      guardianVersion: GUARDIAN_VERSION,
      mode: this.mode(),
      pid: process.pid,
      paths: {
        stateDir: this.paths.stateDir,
        profileDir: this.paths.profileDir,
        appExe: this.paths.appExe,
        logPath: this.paths.logPath,
      },
      health,
      profile: {
        exists: profile.exists,
        fingerprint: profile.fingerprint,
        files: profile.files.map((file) => file.name),
        deps: profile.deps,
        bundles: profile.bundles,
        appVersion,
        latestOperation: profile.latestOperation,
      },
      baseline: baseline ? { id: baseline.id, createdAt: baseline.createdAt, files: Object.keys(baseline.files) } : null,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        reason: snapshot.reason,
        note: snapshot.note,
      })),
      state: {
        phase: this.state.phase,
        paused: this.state.paused,
        candidate: this.state.candidate?.phase ?? null,
        attention: this.state.attention,
      },
    };
  }
}

async function appendReport(reportPath, lines) {
  try {
    await fs.appendFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function describeFlags(config) {
  return {
    autoVerify: config.autoVerify,
    autoRollback: config.autoRollback,
    autoRestartStable: config.autoRestartStable,
    autoSnapshotEnabled: config.autoSnapshotEnabled,
    autoSnapshotHours: config.autoSnapshotHours,
    autoSnapshotRetention: config.autoSnapshotRetention,
    notify: config.notify,
    observeOnly: config.observeOnly,
    dryRun: config.dryRun,
    intervalMs: config.intervalMs,
    probationMs: config.probationMs,
    settleMs: config.settleMs,
  };
}
