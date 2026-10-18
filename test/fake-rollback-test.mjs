import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeHealth } from '../lib/proc.mjs';
import { sleep } from '../lib/util.mjs';

const execFileAsync = promisify(execFile);
const nodeExe = process.execPath;
const guardianRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(guardianRoot, 'guardian.mjs');

let currentRoot = null;
let daemon = null;
let fakeApp = null;

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function cleanup() {
  if (currentRoot) {
    const configPath = path.join(currentRoot, 'config.json');
    const env = { ...process.env, DSH_GUARDIAN_CONFIG: configPath, DSH_GUARDIAN_HOME: path.join(currentRoot, 'state') };
    await execFileAsync(nodeExe, [cli, 'stop'], { env, timeout: 20000, windowsHide: true }).catch(() => {});
  }
  await execFileAsync('taskkill.exe', ['/IM', 'FakeDsh.exe', '/T', '/F'], { windowsHide: true }).catch(() => {});
  daemon?.kill();
  fakeApp?.kill();
  if (currentRoot) await sleep(500);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guardian-fake-'));
  currentRoot = root;
  log(`temp root: ${root}`);
  const profileDir = path.join(root, 'profile');
  const stateDir = path.join(root, 'state');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  log('compile FakeDsh.exe');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const exe = path.join(root, 'FakeDsh.exe');
  const compile = await execFileAsync(csc, ['/nologo', '/target:exe', `/out:${exe}`, path.join(guardianRoot, 'test', 'FakeDsh.cs')], {
    timeout: 60000,
    windowsHide: true,
  });
  if (compile.stderr.trim()) log(`csc stderr: ${compile.stderr.trim()}`);

  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        version: '1.0.0',
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');
  await fs.writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n');

  const config = {
    version: 1,
    profile: 'desktop',
    dshHome: root,
    profileDir,
    appExe: exe,
    appProcessName: 'FakeDsh.exe',
    intervalMs: 1000,
    settleMs: 1000,
    probationMs: 15000,
    startupGraceMs: 15000,
    crashConfirmMs: 3000,
    failureThreshold: 2,
    verifyDelayMs: 1000,
    autoVerify: false,
    autoRollback: true,
    autoRestartStable: false,
    notify: false,
    maxSnapshots: 5,
    maxHistory: 5,
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const env = { ...process.env, DSH_GUARDIAN_CONFIG: configPath, DSH_GUARDIAN_HOME: stateDir };
  const statusPath = path.join(stateDir, 'runtime', 'status.json');
  const statePath = path.join(stateDir, 'state.json');

  log('start fake DSH');
  fakeApp = spawn(exe, [], { stdio: 'ignore', windowsHide: true });
  fakeApp.once('exit', (code) => log(`fake DSH exited: ${code}`));
  const initialHealth = await waitFor(
    async () => {
      const value = await probeHealth(config);
      return value.state === 'healthy' ? value : null;
    },
    { timeoutMs: 20000, label: 'fake DSH healthy' },
  );
  log(`fake DSH healthy: main=${initialHealth.mainPid} host=${initialHealth.hostPid} port=${initialHealth.port}`);

  log('start guardian daemon');
  const outFd = await fs.open(path.join(root, 'daemon.log'), 'a');
  const errFd = await fs.open(path.join(root, 'daemon.err.log'), 'a');
  daemon = spawn(nodeExe, [cli, 'run'], { env, windowsHide: true, stdio: ['ignore', outFd.fd, errFd.fd] });
  daemon.once('exit', (code, signal) => log(`daemon exited: code=${code} signal=${signal}`));

  const baseline = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state?.baseline ? state : null;
    },
    { timeoutMs: 30000, label: 'baseline' },
  );
  log(`baseline: ${baseline.baseline.id}`);

  log('install fake bad plugin + arm fail flag');
  const packageJsonPath = path.join(profileDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson.dependencies['@example/bad-plugin'] = '1.0.0';
  packageJson.dsh.profile.bundles.push('@example/bad-plugin');
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(root, 'fail.flag'), '1');
  const written = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  log(`wrote bad plugin: ${Object.keys(written.dependencies).join(',')}`);

  const candidate = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state?.candidate ? state : null;
    },
    { timeoutMs: 20000, label: 'candidate detected' },
  );
  log(`candidate: ${candidate.candidate.phase} ${candidate.candidate.changeSummary?.summary}`);

  log('run guardian verify');
  let verifyStdout = '';
  try {
    const verify = await execFileAsync(nodeExe, [cli, 'verify'], { env, timeout: 120000, windowsHide: true });
    verifyStdout = verify.stdout;
  } catch (error) {
    // A failed verification with a successful rollback is the expected outcome here.
    const text = String(error.stdout ?? '');
    if (text.includes('已自动回滚') || text.includes('验证失败')) verifyStdout = text;
    else throw error;
  }
  log(`verify stdout:\n${verifyStdout.trim()}`);

  const after = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state && state.counters?.rollbacks >= 1 ? state : null;
    },
    { timeoutMs: 30000, label: 'rollback counted' },
  );
  const status = await readJson(statusPath);
  const restored = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const incidents = await fs.readdir(path.join(stateDir, 'incidents')).catch(() => []);
  const incidentDir = incidents.length ? path.join(stateDir, 'incidents', incidents[0]) : null;
  const incidentFiles = incidentDir ? await fs.readdir(incidentDir).catch(() => []) : [];
  const report = incidentDir ? await fs.readFile(path.join(incidentDir, 'incident.md'), 'utf8').catch(() => '') : '';

  const checks = {
    baselineCreated: Boolean(baseline.baseline?.id),
    candidateDetected: Boolean(candidate.candidate),
    rollbackCounted: (after?.counters?.rollbacks ?? 0) >= 1,
    pluginRemoved: restored.dependencies['@example/bad-plugin'] === undefined,
    bundleRemoved: !restored.dsh.profile.bundles.includes('@example/bad-plugin'),
    appHealthyAgain: status?.app?.state === 'healthy',
    incidentCreated: incidentFiles.includes('incident.md') && incidentFiles.includes('evidence.json'),
    reportHasResult: report.includes('回滚结果') && report.includes('成功'),
    phaseStable: after?.phase === 'stable',
  };

  // ---- scenario 2: plugin loads fine but crashes during the probation window ----
  log('scenario 2: crash during probation');
  const packageJson2 = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson2.dependencies['@example/crash-plugin'] = '2.0.0';
  packageJson2.dsh.profile.bundles.push('@example/crash-plugin');
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson2, null, 2));
  await fs.writeFile(path.join(root, 'crash.flag'), '1');

  const candidate2 = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state?.candidate?.pluginNames?.includes('@example/crash-plugin') ? state : null;
    },
    { timeoutMs: 20000, label: 'second candidate detected' },
  );
  log(`candidate2: ${candidate2.candidate.phase} ${candidate2.candidate.changeSummary?.summary}`);

  const verify2 = await execFileAsync(nodeExe, [cli, 'verify'], { env, timeout: 120000, windowsHide: true });
  log(`verify2 stdout: ${verify2.stdout.trim().split('\n').slice(-1)[0]}`);
  const probation = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state?.candidate?.phase === 'probation' ? state : null;
    },
    { timeoutMs: 20000, label: 'probation entered' },
  );
  log('probation entered; waiting for crash detection and rollback');

  const afterCrash = await waitFor(
    async () => {
      const state = await readJson(statePath);
      return state && state.counters?.rollbacks >= 2 ? state : null;
    },
    { timeoutMs: 45000, label: 'crash rollback counted' },
  );
  const restored2 = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const health2 = await probeHealth(config);
  const incidents2 = await fs.readdir(path.join(stateDir, 'incidents')).catch(() => []);
  const report2 = incidents2.length
    ? await fs.readFile(path.join(stateDir, 'incidents', incidents2[incidents2.length - 1], 'incident.md'), 'utf8').catch(() => '')
    : '';

  checks.probationEntered = probation.candidate.phase === 'probation';
  checks.crashRollbackCounted = (afterCrash.counters.rollbacks ?? 0) >= 2;
  checks.crashPluginRemoved = restored2.dependencies['@example/crash-plugin'] === undefined;
  checks.crashBundleRemoved = !restored2.dsh.profile.bundles.includes('@example/crash-plugin');
  checks.crashAppHealthyAgain = health2.state === 'healthy';
  checks.crashPhaseStable = afterCrash.phase === 'stable';
  checks.crashIncidentCreated = incidents2.length >= 2;
  checks.crashReportHasResult = report2.includes('回滚结果') && report2.includes('成功');

  log(`checks: ${JSON.stringify(checks)}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks, incident: incidentDir, root }, null, 2));
  if (!ok) throw new Error('checks failed');
}

const watchdog = setTimeout(async () => {
  console.error('测试总超时，强制退出');
  await cleanup().catch(() => {});
  process.exit(2);
}, 240000);

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await cleanup().catch(() => {});
}
