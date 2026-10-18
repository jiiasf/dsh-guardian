import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectProfile, diffProfileAgainstMeta } from './profile.mjs';
import { createSnapshot, restoreSnapshot, listSnapshots } from './snapshot.mjs';
import { planTick } from './decide.mjs';
import { defaultState, pushEvent } from './state.mjs';

function health(state, overrides = {}) {
  return {
    state,
    mainPid: state === 'down' ? null : 1000,
    hostPid: state === 'down' ? null : 1001,
    mainStartedAt: Date.now() - 60000,
    hostStartedAt: Date.now() - 60000,
    port: state === 'down' ? null : 54321,
    httpStatus: state === 'healthy' ? 401 : null,
    error: state === 'healthy' ? null : state,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function profileView({ fingerprint, deps = {}, bundles = [], files = [] }) {
  return {
    ok: true,
    exists: true,
    dir: 'C:\\fake',
    fingerprint,
    files: files.map((name) => ({ name, hash: 'h-' + name, size: 10, mtime: 1 })),
    deps,
    bundles,
    nodeModules: { exists: false, names: [], scopes: {}, signature: 'none' },
    latestOperation: null,
    collectedAt: Date.now(),
    durationMs: 1,
    error: null,
  };
}

function context({ now, healthValue, profile, baselineMeta, profileStable = true, config = {} }) {
  return {
    now,
    config: {
      probationMs: 180000,
      startupGraceMs: 120000,
      crashConfirmMs: 20000,
      failureThreshold: 3,
      autoVerify: false,
      autoRollback: true,
      autoRestartStable: false,
      ...config,
    },
    health: healthValue,
    profile,
    profileStable,
    baselineMeta,
  };
}

export async function runSelfTest({ verbose = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guardian-selftest-'));
  const profileDir = path.join(root, 'profile');
  const paths = {
    root,
    stateDir: path.join(root, 'state'),
    snapshotsDir: path.join(root, 'state', 'snapshots'),
    incidentsDir: path.join(root, 'state', 'incidents'),
    quarantineDir: path.join(root, 'state', 'quarantine'),
    logsDir: path.join(root, 'state', 'logs'),
    logPath: path.join(root, 'state', 'logs', 'guardian.log'),
    eventsPath: path.join(root, 'state', 'logs', 'events.jsonl'),
    statePath: path.join(root, 'state', 'state.json'),
  };
  for (const dir of [profileDir, paths.stateDir, paths.snapshotsDir, paths.incidentsDir, paths.quarantineDir, paths.logsDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2),
  );
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');
  await fs.writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n');

  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      if (verbose) console.log(`  ✓ ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
      if (verbose) console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (verbose) console.log('DSH 守护者 · 离线自检\n');

  let baselineProfile;
  let baselineMeta;
  let baselineState;

  await check('采集 profile 指纹与清单', async () => {
    baselineProfile = await collectProfile(profileDir);
    assert.equal(baselineProfile.ok, true);
    assert.ok(baselineProfile.fingerprint);
    assert.ok(baselineProfile.files.some((file) => file.name === 'package.json'));
    assert.equal(baselineProfile.bundles[0], '@deepseek-ai/dsh-base');
  });

  await check('创建良好快照', async () => {
    baselineMeta = await createSnapshot(paths, baselineProfile, { reason: 'baseline', note: 'selftest' });
    assert.ok(baselineMeta.id);
    const snapshots = await listSnapshots(paths);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, baselineMeta.id);
  });

  await check('检测新增插件依赖', async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'));
    packageJson.dependencies['@example/bad-plugin'] = '1.0.0';
    packageJson.dsh.profile.bundles.push('@example/bad-plugin');
    await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: bad\n  name: "@example/bad-plugin"\n');
    const changed = await collectProfile(profileDir);
    const diff = diffProfileAgainstMeta(baselineMeta, changed);
    assert.ok(diff.addedDeps.includes('@example/bad-plugin'));
    assert.ok(diff.addedBundles.includes('@example/bad-plugin'));
    assert.ok(diff.changedFiles.includes('package.json'));
    assert.ok(diff.summary.length > 0);
  });

  await check('启动失败时回滚到安装前快照', async () => {
    const badProfile = await collectProfile(profileDir);
    const result = await restoreSnapshot(paths, baselineMeta, {
      profileDir,
      currentProfile: badProfile,
      incidentId: 'selftest-restore',
    });
    assert.equal(result.errors.length, 0);
    const packageJson = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'));
    assert.equal(packageJson.dependencies['@example/bad-plugin'], undefined);
    assert.deepEqual(packageJson.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
    const restored = await collectProfile(profileDir);
    assert.equal(restored.fingerprint, baselineMeta.fingerprint);
  });

  await check('回滚会隔离新增依赖并清理空的 node_modules', async () => {
    const nodeModules = path.join(profileDir, 'node_modules');
    await fs.mkdir(path.join(nodeModules, 'added-pkg'), { recursive: true });
    const dirty = await collectProfile(profileDir);
    assert.ok(dirty.nodeModules.names.includes('added-pkg'));
    const result = await restoreSnapshot(paths, baselineMeta, {
      profileDir,
      currentProfile: dirty,
      incidentId: 'selftest-node-modules',
    });
    assert.ok(result.quarantined.includes('added-pkg'));
    let exists = true;
    try {
      await fs.access(nodeModules);
    } catch {
      exists = false;
    }
    assert.equal(exists, false);
    const restored = await collectProfile(profileDir);
    assert.equal(restored.fingerprint, baselineMeta.fingerprint);
  });

  await check('node_modules 目录时间变化不会误报插件变更', async () => {
    const nodeModules = path.join(profileDir, 'node_modules');
    await fs.mkdir(path.join(nodeModules, 'pkg-a'), { recursive: true });
    const first = await collectProfile(profileDir);
    await fs.utimes(nodeModules, new Date(), new Date(Date.now() + 60000));
    const second = await collectProfile(profileDir);
    assert.equal(second.nodeModules.signature, first.nodeModules.signature);
    assert.equal(second.fingerprint, first.fingerprint);
    await fs.mkdir(path.join(nodeModules, 'pkg-b'), { recursive: true });
    const third = await collectProfile(profileDir);
    assert.notEqual(third.fingerprint, second.fingerprint);
    await fs.rm(nodeModules, { recursive: true, force: true });
  });

  await check('主流程：稳定 → 检测变更 → 试用 → 通过', async () => {
    baselineState = defaultState();
    baselineState.baseline = {
      id: baselineMeta.id,
      createdAt: baselineMeta.createdAt,
      fingerprint: baselineMeta.fingerprint,
      note: null,
    };
    baselineState.history = [baselineState.baseline];
    let state = baselineState;
    let now = Date.now();
    let result = planTick(state, context({
      now,
      healthValue: health('healthy'),
      profile: profileView({ fingerprint: baselineMeta.fingerprint }),
      baselineMeta,
    }));
    assert.equal(result.state.phase, 'stable');

    const changedProfile = profileView({
      fingerprint: 'fp-bad',
      deps: { '@example/bad-plugin': '1.0.0' },
      bundles: ['@deepseek-ai/dsh-base', '@example/bad-plugin'],
    });
    result = planTick(result.state, context({ now, healthValue: health('healthy'), profile: changedProfile, baselineMeta }));
    assert.equal(result.state.phase, 'awaiting');
    assert.ok(result.actions.some((action) => action.type === 'CANDIDATE_DETECTED'));

    now += 5000;
    result = planTick(result.state, context({
      now,
      healthValue: health('healthy', { mainPid: 2000, mainStartedAt: now - 2000 }),
      profile: changedProfile,
      baselineMeta,
    }));
    assert.equal(result.state.phase, 'probation');
    assert.ok(result.actions.some((action) => action.type === 'ENTER_PROBATION'));

    now += 181000;
    result = planTick(result.state, context({
      now,
      healthValue: health('healthy', { mainPid: 2000, mainStartedAt: now - 190000 }),
      profile: changedProfile,
      baselineMeta,
    }));
    assert.ok(result.actions.some((action) => action.type === 'PROMOTE'));
  });

  await check('主流程：试用期崩溃触发回滚', async () => {
    let state = defaultState();
    state.baseline = { id: baselineMeta.id, createdAt: baselineMeta.createdAt, fingerprint: baselineMeta.fingerprint };
    state.history = [state.baseline];
    const now = Date.now();
    const changedProfile = profileView({ fingerprint: 'fp-bad', deps: { bad: '1.0.0' }, bundles: ['bad'] });
    let result = planTick(state, context({ now, healthValue: health('healthy'), profile: changedProfile, baselineMeta }));
    result = planTick(result.state, context({
      now: now + 5000,
      healthValue: health('healthy', { mainPid: 2000, mainStartedAt: now + 3000 }),
      profile: changedProfile,
      baselineMeta,
    }));
    assert.equal(result.state.phase, 'probation');
    let current = result.state;
    for (let index = 0; index < 3; index += 1) {
      result = planTick(current, context({
        now: now + 6000 + index * 4000,
        healthValue: health('down'),
        profile: changedProfile,
        baselineMeta,
      }));
      current = result.state;
    }
    assert.ok(result.actions.some((action) => action.type === 'ROLLBACK'));
  });

  await check('崩溃证据存在时等待中的插件也会回滚', async () => {
    const now = Date.now();
    const changedProfile = profileView({ fingerprint: 'fp-bad', deps: { bad: '1.0.0' } });
    let state = defaultState();
    state.baseline = { id: baselineMeta.id, createdAt: baselineMeta.createdAt, fingerprint: baselineMeta.fingerprint };
    state.history = [state.baseline];
    let result = planTick(state, context({ now, healthValue: health('healthy'), profile: changedProfile, baselineMeta }));
    assert.equal(result.state.phase, 'awaiting');
    result.state.app.crashEvidence = { found: true, events: [{ id: 1000 }], checkedAt: now };
    result.state.app.lastHealthyAt = now - 60000;
    result.state.app.downSince = now - 30000;
    result = planTick(result.state, context({
      now: now + 1000,
      healthValue: health('down'),
      profile: changedProfile,
      baselineMeta,
    }));
    assert.ok(result.actions.some((action) => action.type === 'ROLLBACK'));
  });

  await check('主动退出（无崩溃证据）不自动回滚', async () => {
    const now = Date.now();
    const changedProfile = profileView({ fingerprint: 'fp-bad', deps: { bad: '1.0.0' } });
    let state = defaultState();
    state.baseline = { id: baselineMeta.id, createdAt: baselineMeta.createdAt, fingerprint: baselineMeta.fingerprint };
    state.history = [state.baseline];
    let result = planTick(state, context({ now, healthValue: health('healthy'), profile: changedProfile, baselineMeta }));
    result.state.app.crashEvidence = { found: false, events: [], checkedAt: now };
    result.state.app.lastHealthyAt = now - 60000;
    result.state.app.downSince = now - 30000;
    result = planTick(result.state, context({
      now: now + 1000,
      healthValue: health('down'),
      profile: changedProfile,
      baselineMeta,
    }));
    assert.ok(!result.actions.some((action) => action.type === 'ROLLBACK'));
    assert.equal(result.state.attention?.reason, 'app-exit-during-probation');
  });

  await check('诊断查询失败不会被当作崩溃', async () => {
    const now = Date.now();
    let state = defaultState();
    state.baseline = { id: baselineMeta.id, createdAt: baselineMeta.createdAt, fingerprint: baselineMeta.fingerprint };
    state.history = [state.baseline];
    state.phase = 'stable';
    const result = planTick(state, context({
      now,
      healthValue: health('unknown'),
      profile: profileView({ fingerprint: baselineMeta.fingerprint }),
      baselineMeta,
    }));
    assert.equal(result.state.phase, 'stable');
    assert.equal(result.actions.filter((action) => action.type === 'ROLLBACK').length, 0);
  });

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  const ok = results.every((item) => item.ok);
  if (verbose) {
    const passed = results.filter((item) => item.ok).length;
    console.log(`\n结果：${passed}/${results.length} 通过${ok ? '，全部正常。' : '，存在失败项。'}`);
  }
  return { ok, results };
}
