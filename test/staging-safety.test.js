const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
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
