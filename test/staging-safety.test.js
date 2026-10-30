const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const baseEnv = { ...process.env };
delete baseEnv.MONGODB_URI;
delete baseEnv.MONGODB_DB;
delete baseEnv.VAPID_PUBLIC_KEY;
delete baseEnv.VAPID_PRIVATE_KEY;
delete baseEnv.REMINDER_SCHEDULER_ENABLED;

function runModule(modulePath, extraEnv) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)})`], {
    cwd: process.cwd(),
    env: { ...baseEnv, ...extraEnv },
    encoding: 'utf8'
  });
}

test('staging refuses the production database name', () => {
  const result = runModule('./storage', {
    APP_ENV: 'staging',
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    MONGODB_DB: 'yoga_signup'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Staging must use MONGODB_DB=yoga_signup_test/);
});

test('staging refuses live push delivery', () => {
  const result = runModule('./server', {
    APP_ENV: 'staging',
    PUSH_MODE: 'live',
    STAGING_USERNAME: 'tester',
    STAGING_PASSWORD: 'test-password'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Push delivery can only be enabled in production/);
});

test('staging refuses the reminder scheduler', () => {
  const result = runModule('./server', {
    APP_ENV: 'staging',
    PUSH_MODE: 'disabled',
    REMINDER_SCHEDULER_ENABLED: 'true',
    STAGING_USERNAME: 'tester',
    STAGING_PASSWORD: 'test-password'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reminder scheduler can only be enabled in production/i);
});

test('valid staging is password protected and reports safe diagnostics', async (t) => {
  const port = 32123;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...baseEnv,
      APP_ENV: 'staging',
      PUSH_MODE: 'disabled',
      REMINDER_SCHEDULER_ENABLED: 'false',
      STAGING_USERNAME: 'tester',
      STAGING_PASSWORD: 'test-password',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('실행 중입니다')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => reject(new Error(`server exited early: ${code}`)));
  });

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/environment`);
  assert.equal(unauthorized.status, 401);

  const authorization = `Basic ${Buffer.from('tester:test-password').toString('base64')}`;
  const authorized = await fetch(`http://127.0.0.1:${port}/api/environment`, {
    headers: { authorization }
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    backend: 'local-file',
    database: null,
    environment: 'staging',
    pushMode: 'disabled',
    pushEnabled: false,
    reminderSchedulerEnabled: false
  });
});

test('period stats finalize at noon and per-session capacity promotes waitlist safely', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoga-staging-test-'));
  fs.copyFileSync(path.join(process.cwd(), 'server.js'), path.join(tempDir, 'server.js'));
  fs.copyFileSync(path.join(process.cwd(), 'storage.js'), path.join(tempDir, 'storage.js'));
  fs.mkdirSync(path.join(tempDir, 'public'));
  const port = 32200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: tempDir,
    env: {
      ...baseEnv,
      NODE_PATH: path.join(process.cwd(), 'node_modules'),
      APP_ENV: 'staging',
      PUSH_MODE: 'disabled',
      REMINDER_SCHEDULER_ENABLED: 'false',
      STAGING_USERNAME: 'tester',
      STAGING_PASSWORD: 'test-password',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('실행 중입니다')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => reject(new Error(`server exited early: ${code}`)));
  });

  const basic = `Basic ${Buffer.from('tester:test-password').toString('base64')}`;
  const request = async (route, options = {}, authorization = basic) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization, ...(options.headers || {}) }
  });
  const setup = await request('/api/admin/setup', { method: 'POST', body: JSON.stringify({ pin: '1234' }) });
  assert.equal(setup.status, 200);
  const admin = `Bearer ${(await setup.json()).token}`;
  assert.equal((await request('/api/config/test-mode', { method: 'POST', body: JSON.stringify({ enabled: true }) }, admin)).status, 200);

  const pastDate = '2025-01-06';
  assert.equal((await request('/api/sessions', { method: 'POST', body: JSON.stringify({ date: pastDate }) }, admin)).status, 200);
  assert.equal((await request(`/api/sessions/${pastDate}/join`, { method: 'POST', body: JSON.stringify({ name: '출석자' }) })).status, 200);
  const closedCancel = await request(`/api/sessions/${pastDate}/cancel`, { method: 'POST', body: JSON.stringify({ name: '출석자' }) });
  assert.equal(closedCancel.status, 403);
  const closedCapacity = await request(`/api/sessions/${pastDate}/capacity`, { method: 'PATCH', body: JSON.stringify({ capacity: 20 }) }, admin);
  assert.equal(closedCapacity.status, 403);

  const stats = await request(`/api/stats?start=${pastDate}&end=${pastDate}`);
  assert.equal(stats.status, 200);
  const statsBody = await stats.json();
  assert.equal(statsBody.sessionCount, 1);
  assert.deepEqual(statsBody.rows, [{ name: '출석자', count: 1, attended: { [pastDate]: true } }]);

  const futureDate = '2099-01-05';
  assert.equal((await request('/api/sessions', { method: 'POST', body: JSON.stringify({ date: futureDate }) }, admin)).status, 200);
  assert.equal((await request(`/api/sessions/${futureDate}/capacity`, { method: 'PATCH', body: JSON.stringify({ capacity: 2 }) }, admin)).status, 200);
  for (const name of ['가', '나', '다']) {
    assert.equal((await request(`/api/sessions/${futureDate}/join`, { method: 'POST', body: JSON.stringify({ name }) })).status, 200);
  }
  const expanded = await request(`/api/sessions/${futureDate}/capacity`, { method: 'PATCH', body: JSON.stringify({ capacity: 3 }) }, admin);
  assert.equal(expanded.status, 200);
  assert.deepEqual((await expanded.json()).promotedNames, ['다']);
  const tooSmall = await request(`/api/sessions/${futureDate}/capacity`, { method: 'PATCH', body: JSON.stringify({ capacity: 2 }) }, admin);
  assert.equal(tooSmall.status, 409);
  const openCancel = await request(`/api/sessions/${futureDate}/cancel`, { method: 'POST', body: JSON.stringify({ name: '가', fromWaitlist: false }) });
  assert.equal(openCancel.status, 200);
  assert.equal((await openCancel.json()).sessions.find(session => session.date === futureDate).signups.includes('가'), false);
});
