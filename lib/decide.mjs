import { diffProfileAgainstMeta } from './profile.mjs';

function clone(value) {
  return structuredClone(value);
}

function notify(level, title, message) {
  return { type: 'NOTIFY', level, title, message };
}

function makeCandidate({ now, config, health, profile, diff }) {
  return {
    fingerprint: profile.fingerprint,
    detectedAt: now,
    detectedMainPid: health.mainPid ?? null,
    detectedMainStartedAt: health.mainStartedAt ?? null,
    phase: 'awaiting',
    probationEndsAt: null,
    bootDeadline: null,
    bootPid: null,
    bootStartedAt: null,
    everHealthy: health.state === 'healthy',
    sawBoot: false,
    bootRestarts: 0,
    failures: 0,
    crashCheckRequested: false,
    changeSummary: diff
      ? {
          summary: diff.summary,
          addedDeps: diff.addedDeps,
          removedDeps: diff.removedDeps,
          changedDeps: diff.changedDeps,
          addedBundles: diff.addedBundles,
          removedBundles: diff.removedBundles,
          addedFiles: diff.addedFiles,
          removedFiles: diff.removedFiles,
          changedFiles: diff.changedFiles,
          pluginNames: diff.pluginNames,
        }
      : null,
    pluginNames: diff?.pluginNames ?? [],
    probationMs: config.probationMs,
  };
}

function newBootSeen(health, candidate) {
  if (!health?.mainPid) return false;
  const referencePid = candidate.bootPid ?? candidate.detectedMainPid;
  if (referencePid === null) return true;
  if (health.mainPid !== referencePid) return true;
  const referenceStart = candidate.bootPid !== null && candidate.bootStartedAt
    ? candidate.bootStartedAt
    : candidate.detectedAt;
  if (health.mainStartedAt && referenceStart && health.mainStartedAt > referenceStart + 1000) {
    return true;
  }
  return false;
}

function exceededRestartBudget(state, now) {
  const windowMs = 10 * 60 * 1000;
  state.app.restartHistory = (state.app.restartHistory ?? []).filter((at) => now - at < windowMs);
  return state.app.restartHistory.length >= 2;
}

function setAttention(state, reason, message, now) {
  state.attention = { reason, message, since: now };
  state.phase = 'attention';
}

function recentlyHealthy(state, now, windowMs = 5 * 60 * 1000) {
  return Boolean(state.app.lastHealthyAt && now - state.app.lastHealthyAt < windowMs);
}

export function planTick(previousState, context) {
  const { now, config, health, profile, profileStable, baselineMeta } = context;
  const state = clone(previousState);
  const actions = [];
  const wasHealthy = state.app.state === 'healthy';
  const prevMainPid = state.app.lastMainPid ?? null;

  // ---- record health transition -------------------------------------------
  state.app.state = health.state;
  state.app.lastProbe = {
    state: health.state,
    checkedAt: health.checkedAt,
    mainPid: health.mainPid ?? null,
    hostPid: health.hostPid ?? null,
    port: health.port ?? null,
    httpStatus: health.httpStatus ?? null,
    error: health.error ?? null,
  };
  if (health.state === 'healthy') {
    state.app.lastHealthyAt = now;
    state.app.consecutiveUnhealthy = 0;
    state.app.downSince = null;
    state.app.crashEvidence = null;
    state.app.crashCheckRequested = false;
    if (!wasHealthy || prevMainPid !== (health.mainPid ?? null) || !state.app.healthySince) {
      state.app.healthySince = now;
    }
    if (state.attention && ['app-down', 'app-degraded', 'app-exited', 'app-crashed', 'app-exit-during-probation'].includes(state.attention.reason)) {
      state.attention = null;
    }
  } else {
    state.app.healthySince = null;
    state.app.consecutiveUnhealthy = (state.app.consecutiveUnhealthy ?? 0) + 1;
    if (state.app.downSince === null || state.app.downSince === undefined) state.app.downSince = now;
  }
  if (health.mainPid && prevMainPid && health.mainPid !== prevMainPid) {
    state.app.lastBootAt = now;
  }
  if (health.mainPid) state.app.lastMainPid = health.mainPid;
  state.app.mainPid = health.mainPid ?? null;
  state.app.hostPid = health.hostPid ?? null;
  state.app.port = health.port ?? null;
  state.app.mainStartedAt = health.mainStartedAt ?? state.app.mainStartedAt ?? null;

  if (state.paused) {
    state.phase = 'paused';
    return { state, actions };
  }

  // A failed diagnostic query must never be treated as a crash.
  if (health.state === 'unknown') {
    return { state, actions };
  }

  // ---- no baseline yet ------------------------------------------------------
  if (!state.baseline) {
    state.phase = 'starting';
    if (health.state === 'healthy' && profileStable && profile.ok) {
      actions.push({ type: 'ADOPT_BASELINE', reason: 'initial' });
    }
    return { state, actions };
  }

  const baselineFingerprint = state.baseline.fingerprint;

  // ---- profile returned to baseline (plugin removed by hand) ---------------
  if (
    state.candidate &&
    profileStable &&
    profile.ok &&
    profile.fingerprint &&
    baselineFingerprint &&
    profile.fingerprint === baselineFingerprint
  ) {
    state.candidate = null;
    state.phase = 'stable';
    state.attention = null;
    actions.push({ type: 'CANDIDATE_CLEARED', reason: 'profile-restored' });
    actions.push(notify('info', 'DSH 守护', 'profile 已恢复到良好版本，插件试用已取消。'));
  }

  // ---- new or changed candidate --------------------------------------------
  if (profileStable && profile.ok && profile.fingerprint && profile.fingerprint !== baselineFingerprint) {
    if (!state.candidate) {
      const diff = baselineMeta ? diffProfileAgainstMeta(baselineMeta, profile) : null;
      state.candidate = makeCandidate({ now, config, health, profile, diff });
      state.phase = 'awaiting';
      const names = state.candidate.pluginNames.join('、');
      actions.push({ type: 'CANDIDATE_DETECTED', summary: state.candidate.changeSummary?.summary ?? 'profile 发生变化' });
      actions.push(
        notify(
          'info',
          'DSH 守护 · 检测到插件变更',
          names
            ? `新增 ${names}。DSH 重启加载后进入 ${Math.round(config.probationMs / 60000)} 分钟试用期，异常会自动回滚。`
            : 'profile 发生变化。DSH 重启加载后进入试用期，异常会自动回滚。',
        ),
      );
    } else if (state.candidate.fingerprint !== profile.fingerprint) {
      const diff = baselineMeta ? diffProfileAgainstMeta(baselineMeta, profile) : null;
      const previousPhase = state.candidate.phase;
      state.candidate = makeCandidate({ now, config, health, profile, diff });
      state.phase = 'awaiting';
      actions.push({ type: 'CANDIDATE_UPDATED', previousPhase, summary: state.candidate.changeSummary?.summary });
      actions.push(notify('info', 'DSH 守护 · 插件再次变更', '试用计时已重置，等待 DSH 重启加载新配置。'));
    }
  }

  const candidate = state.candidate;

  if (candidate) {
    const boot = newBootSeen(health, candidate);
    const healthy = health.state === 'healthy';
    const bootAge = candidate.bootStartedAt ? now - candidate.bootStartedAt : 0;

    if (candidate.phase === 'awaiting') {
      if (healthy && boot) {
        candidate.phase = 'probation';
        candidate.everHealthy = true;
        candidate.bootPid = health.mainPid;
        candidate.bootStartedAt = now;
        candidate.probationEndsAt = now + config.probationMs;
        candidate.failures = 0;
        state.phase = 'probation';
        state.attention = null;
        actions.push({ type: 'ENTER_PROBATION', probationMs: config.probationMs });
        actions.push(
          notify(
            'info',
            'DSH 守护 · 新插件已加载',
            `已开始 ${Math.round(config.probationMs / 60000)} 分钟稳定性观察；若崩溃或服务无响应，将回滚到 ${state.baseline.id}。`,
          ),
        );
      } else if (healthy) {
        candidate.everHealthy = true;
        if (config.autoVerify && now - candidate.detectedAt >= config.verifyDelayMs) {
          candidate.phase = 'verifying';
          candidate.bootPid = null;
          candidate.bootStartedAt = now;
          candidate.bootDeadline = now + config.startupGraceMs;
          candidate.sawBoot = false;
          state.phase = 'verifying';
          actions.push({ type: 'VERIFY_RESTART', reason: 'auto-verify' });
        }
      } else if (boot || health.state === 'starting') {
        candidate.phase = 'verifying';
        candidate.bootPid = health.mainPid ?? null;
        candidate.bootStartedAt = now;
        candidate.bootDeadline = now + config.startupGraceMs;
        candidate.sawBoot = Boolean(health.mainPid);
        state.phase = 'verifying';
        actions.push({ type: 'BOOT_CONFIRM', state: health.state });
      } else if (
        recentlyHealthy(state, now, 15 * 60 * 1000) &&
        state.app.downSince &&
        now - state.app.downSince >= config.crashConfirmMs
      ) {
        if (health.mainPid) {
          state.phase = 'awaiting';
          actions.push({ type: 'ROLLBACK', reason: 'service-degraded-after-change', kind: 'plugin-degraded' });
        } else if (config.autoVerify) {
          candidate.phase = 'verifying';
          candidate.bootPid = null;
          candidate.bootStartedAt = now;
          candidate.bootDeadline = now + config.startupGraceMs;
          state.phase = 'verifying';
          actions.push({ type: 'VERIFY_RESTART', reason: 'auto-verify-after-exit' });
        } else if (state.app.crashEvidence?.found) {
          actions.push({ type: 'ROLLBACK', reason: 'plugin-crash-evidence', kind: 'plugin-crash' });
        } else if (state.app.crashEvidence && !state.app.crashEvidence.found) {
          if (state.attention?.reason !== 'app-exit-during-probation') {
            const message =
              'DSH 在插件试用窗口内退出，但未发现 Windows 崩溃记录（可能是主动退出）。守护暂不自动回滚；下次启动 DSH 时会继续验证该插件。';
            setAttention(state, 'app-exit-during-probation', message, now);
            actions.push(notify('warn', 'DSH 守护 · DSH 已退出', message));
          }
        } else if (!candidate.crashCheckRequested) {
          candidate.crashCheckRequested = true;
          actions.push({ type: 'CHECK_CRASH', minutes: 20 });
        }
      }
    } else if (candidate.phase === 'verifying') {
      if (healthy) {
        candidate.phase = 'probation';
        candidate.everHealthy = true;
        candidate.bootPid = health.mainPid;
        candidate.bootStartedAt = now;
        candidate.probationEndsAt = now + config.probationMs;
        candidate.failures = 0;
        candidate.sawBoot = true;
        state.phase = 'probation';
        state.attention = null;
        actions.push({ type: 'ENTER_PROBATION', probationMs: config.probationMs, afterVerify: true });
        actions.push(
          notify(
            'info',
            'DSH 守护 · 启动成功',
            `新配置已成功启动，进入 ${Math.round(config.probationMs / 60000)} 分钟试用期。`,
          ),
        );
      } else {
        if (health.mainPid) candidate.sawBoot = true;
        if (state.app.consecutiveUnhealthy >= config.failureThreshold && candidate.sawBoot && !health.mainPid) {
          actions.push({ type: 'ROLLBACK', reason: 'boot-process-exited', kind: 'plugin-boot-crash' });
        } else if (now >= candidate.bootDeadline) {
          actions.push({ type: 'ROLLBACK', reason: 'boot-timeout', kind: 'plugin-boot-timeout' });
        }
      }
    } else if (candidate.phase === 'probation') {
      if (healthy) {
        candidate.failures = 0;
        candidate.everHealthy = true;
        if (boot) {
          candidate.bootRestarts += 1;
          candidate.bootPid = health.mainPid;
          candidate.bootStartedAt = now;
          candidate.probationEndsAt = now + config.probationMs;
          if (candidate.bootRestarts > 2) {
            actions.push({ type: 'ROLLBACK', reason: 'repeated-restarts-in-probation', kind: 'plugin-unstable' });
          } else {
            actions.push({ type: 'PROBATION_EXTENDED', restarts: candidate.bootRestarts });
          }
        } else if (now >= candidate.probationEndsAt) {
          actions.push({ type: 'PROMOTE', reason: 'probation-passed' });
        }
      } else if (health.state === 'starting' && bootAge < config.startupGraceMs) {
        // A restart is underway; give it the startup grace window before counting failures.
      } else {
        candidate.failures = (candidate.failures ?? 0) + 1;
        if (candidate.failures >= config.failureThreshold) {
          actions.push({ type: 'ROLLBACK', reason: 'crash-during-probation', kind: 'plugin-crash' });
        }
      }
    }
  } else {
    // ---- stable / no candidate ---------------------------------------------
    if (health.state === 'healthy') {
      state.phase = 'stable';
    } else if (
      recentlyHealthy(state, now, 15 * 60 * 1000) &&
      state.app.downSince &&
      now - state.app.downSince >= config.crashConfirmMs
    ) {
      const mainGone = !health.mainPid;
      const canRestart = config.autoRestartStable && !exceededRestartBudget(state, now);
      if (mainGone) {
        if (state.app.crashEvidence?.found) {
          if (canRestart) {
            state.app.restartHistory.push(now);
            state.phase = 'stable';
            actions.push({ type: 'RESTART_APP', reason: 'crash-evidence' });
          } else if (state.attention?.reason !== 'app-crashed') {
            setAttention(state, 'app-crashed', 'DSH 崩溃退出，自动重启次数已达上限或已关闭。请手动启动 DSH。', now);
            actions.push(notify('error', 'DSH 守护 · DSH 崩溃', '检测到 DSH 崩溃退出，请手动启动或查看事件报告。'));
          }
        } else if (state.app.crashEvidence && !state.app.crashEvidence.found) {
          if (state.attention?.reason !== 'app-exited') {
            setAttention(state, 'app-exited', 'DSH 已退出（未发现崩溃记录）。主动退出时守护不会自动重启。', now);
            actions.push(notify('warn', 'DSH 守护 · DSH 已退出', '守护已记录退出；如需自动重启请打开面板操作。'));
          }
        } else if (!state.app.crashCheckRequested) {
          state.app.crashCheckRequested = true;
          actions.push({ type: 'CHECK_CRASH', minutes: 15 });
        }
      } else if (config.autoRestartStable && canRestart) {
        state.app.restartHistory.push(now);
        actions.push({ type: 'RESTART_APP', reason: 'service-degraded' });
      } else if (state.attention?.reason !== 'app-degraded') {
        setAttention(state, 'app-degraded', 'DSH 进程仍在运行，但 Agent/Web 服务无响应。', now);
        actions.push(notify('warn', 'DSH 守护 · 服务无响应', 'DSH 进程仍存活，但 Agent/Web 服务无响应。'));
      }
    }
  }

  // ---- periodic healthy snapshot (default: every 12 hours) -----------------
  const autoSnapshotDue =
    Boolean(config.autoSnapshotEnabled) &&
    !state.candidate &&
    !state.attention &&
    state.phase === 'stable' &&
    health.state === 'healthy' &&
    profileStable &&
    profile.ok &&
    Boolean(state.autoSnapshot?.nextAt) &&
    now >= state.autoSnapshot.nextAt &&
    Boolean(state.app.healthySince) &&
    now - state.app.healthySince >= config.autoSnapshotMinHealthyMs;
  if (autoSnapshotDue) {
    actions.push({ type: 'AUTO_SNAPSHOT', reason: 'scheduled', dueAt: state.autoSnapshot.nextAt });
  }

  return { state, actions };
}

export { newBootSeen };
