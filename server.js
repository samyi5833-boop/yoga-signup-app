const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const DEFAULT_CONFIG = { biweeklyFridayRef: null, adminPinHash: null, testMode: false, autoGenerate: true, skippedDates: [] };
const APP_ENV = process.env.APP_ENV || 'production';
const IS_PRODUCTION = APP_ENV === 'production';
const IS_STAGING = APP_ENV === 'staging';
const STAGING_USERNAME = process.env.STAGING_USERNAME || '';
const STAGING_PASSWORD = process.env.STAGING_PASSWORD || '';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_MODE = process.env.PUSH_MODE || (IS_PRODUCTION ? 'live' : 'disabled');
const REMINDER_SCHEDULER_REQUESTED = (process.env.REMINDER_SCHEDULER_ENABLED || (IS_PRODUCTION ? 'true' : 'false')) === 'true';
const PUSH_ENABLED = PUSH_MODE === 'live' && !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
const REMINDER_SCHEDULER_ENABLED = REMINDER_SCHEDULER_REQUESTED && PUSH_ENABLED;
const CLASS_REMINDER_TYPE = 'classReminder';
const PROMOTION_PUSH_TYPE = 'promotion';
const DEFAULT_CAPACITY = 14;
const MAX_CAPACITY = 100;

if (!['production', 'staging', 'development', 'test'].includes(APP_ENV)) {
  throw new Error(`Unsupported APP_ENV: ${APP_ENV}`);
}
if (!['disabled', 'live'].includes(PUSH_MODE)) {
  throw new Error(`Unsupported PUSH_MODE: ${PUSH_MODE}`);
}
if (!IS_PRODUCTION && PUSH_MODE === 'live') {
  throw new Error('Push delivery can only be enabled in production.');
}
if (!IS_PRODUCTION && REMINDER_SCHEDULER_REQUESTED) {
  throw new Error('The reminder scheduler can only be enabled in production.');
}
if (IS_STAGING && (!STAGING_USERNAME || !STAGING_PASSWORD)) {
  throw new Error('Staging requires STAGING_USERNAME and STAGING_PASSWORD.');
}

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('Browser push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable notifications.');
}

// ---------- 관리자 토큰 (메모리 저장, 서버 재시작 시 초기화) ----------
const tokens = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expires = token && tokens.get(token);
  if (!expires || expires < Date.now()) {
    return res.status(401).json({ error: '관리자 인증이 필요해요.' });
  }
  next();
}

// ---------- 날짜/규칙 유틸 ----------
// 서버가 어떤 타임존(대부분 UTC)에서 돌아가든 상관없이, 모든 계산을 "한국시간(KST=UTC+9)" 기준으로 고정한다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD" 문자열이 가리키는, 그 날짜의 한국시간 자정(00:00 KST)에 해당하는 절대시각
function kstMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // KST 00:00 == UTC 전날 15:00. UTC 00:00을 만든 뒤 9시간을 빼면 KST 00:00의 절대시각이 된다.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 60 * 60 * 1000);
}
// 요일 계산 (0=일 ... 6=토), 한국시간 기준 — 서버 타임존과 무관
function dowOf(dateStr) {
  return new Date(kstMidnight(dateStr).getTime() + 9 * 60 * 60 * 1000).getUTCDay();
}
// 현재 절대시각(ms)을 한국시간 기준 "YYYY-MM-DD" 문자열로 변환
function fmtKST(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear(), m = String(kst.getUTCMonth() + 1).padStart(2, '0'), d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function isClassDay(dateStr, config) {
  const dow = dowOf(dateStr);
  if (dow === 1 || dow === 3) return true;
  if (dow === 5 && config.biweeklyFridayRef) {
    const diffMs = kstMidnight(dateStr).getTime() - kstMidnight(config.biweeklyFridayRef).getTime();
    const diffWeeks = diffMs / (7 * 24 * 3600 * 1000);
    return Number.isInteger(diffWeeks) && Math.abs(Math.round(diffWeeks)) % 2 === 0;
  }
  return false;
}
// 신청 오픈/마감 시각 (한국시간 기준). 요가 수업이 오전 11시 40분 시작이라, 그 전에 마감.
const OPEN_HOUR = 9;
const CLOSE_HOUR = 12;

// 해당 날짜, 한국시간 오전 9시에 해당하는 절대시각
function openTime(dateStr) {
  return new Date(kstMidnight(dateStr).getTime() + OPEN_HOUR * 60 * 60 * 1000);
}
// 해당 날짜, 한국시간 오후 12시(정오)에 해당하는 절대시각
function closeTime(dateStr) {
  return new Date(kstMidnight(dateStr).getTime() + CLOSE_HOUR * 60 * 60 * 1000);
}
function isLocked(dateStr, config) {
  if (config.testMode) return false;
  return Date.now() < openTime(dateStr).getTime();
}
function isClosed(dateStr, config) {
  if (config.testMode) return false;
  return Date.now() >= closeTime(dateStr).getTime();
}
function isAttendanceFinalized(dateStr) {
  return Date.now() >= closeTime(dateStr).getTime();
}
function isValidDateString(dateStr) {
  if (!DATE_RE.test(dateStr || '')) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function sessionCapacity(session) {
  return Number.isInteger(session.capacity) && session.capacity > 0 ? session.capacity : DEFAULT_CAPACITY;
}

// 앞으로 14일 안의 월/수/격주금 날짜 중, 아직 없고("existing") 관리자가 일부러 지운 적도 없는("skipped")
// 날짜만 골라 새 세션으로 채워 넣는다. 반환값: 세션이 하나라도 추가됐는지 여부.
function ensureUpcomingSessions(sessions, config) {
  if (config.autoGenerate === false) return false;
  const skipped = new Set(config.skippedDates || []);
  const existing = new Set(sessions.map(s => s.date));
  const todayKST = fmtKST(Date.now());
  const startMs = kstMidnight(todayKST).getTime();
  let changed = false;
  for (let i = 0; i < 14; i++) {
    const ds = fmtKST(startMs + i * 24 * 3600 * 1000);
    if (isClassDay(ds, config) && !existing.has(ds) && !skipped.has(ds)) {
      sessions.push({ date: ds, capacity: DEFAULT_CAPACITY, signups: [], waitlist: [], cancelled: [] });
      existing.add(ds);
      changed = true;
    }
  }
  if (changed) sessions.sort((a, b) => a.date.localeCompare(b.date));
  return changed;
}

function ensureSessionShape(session) {
  if (!Number.isInteger(session.capacity) || session.capacity < 1) session.capacity = DEFAULT_CAPACITY;
  if (!Array.isArray(session.signups)) session.signups = [];
  if (!Array.isArray(session.waitlist)) session.waitlist = [];
  if (!Array.isArray(session.cancelled)) session.cancelled = [];
}

function recordCancellation(session, name, from, promotedName = null) {
  ensureSessionShape(session);
  session.cancelled.push({
    name,
    from,
    promotedName,
    cancelledAt: new Date().toISOString()
  });
}

async function sendPromotionPush(date, name) {
  if (!PUSH_ENABLED || !name) return;
  const subscriptions = await storage.getPushSubscriptions();
  const matches = subscriptions.filter(item => (item.type || PROMOTION_PUSH_TYPE) === PROMOTION_PUSH_TYPE && item.date === date && item.name === name && item.subscription);
  if (matches.length === 0) return;

  const payload = JSON.stringify({
    title: '요가 모임 신청이 확정되었습니다',
    body: `${date} 수업 대기자에서 신청자로 승급되었어요.`,
    url: '/'
  });

  const staleEndpoints = new Set();
  await Promise.all(matches.map(async item => {
    try {
      await webpush.sendNotification(item.subscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleEndpoints.add(item.subscription.endpoint);
      } else {
        console.error('Push notification failed:', err.message || err);
      }
    }
  }));

  if (staleEndpoints.size > 0) {
    await storage.savePushSubscriptions(
      subscriptions.filter(item => !item.subscription || !staleEndpoints.has(item.subscription.endpoint))
    );
  }
}

function kstParts(nowMs = Date.now()) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return {
    date: fmtKST(nowMs),
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes()
  };
}

async function sendClassReminderIfDue() {
  if (!PUSH_ENABLED) return;

  const now = kstParts();
  if (now.hour !== OPEN_HOUR) return;

  const config = await storage.getConfig();
  const sentDates = new Set(config.sentClassReminderDates || []);
  if (sentDates.has(now.date)) return;

  const skipped = new Set(config.skippedDates || []);
  if (skipped.has(now.date) || !isClassDay(now.date, config)) return;

  const subscriptions = await storage.getPushSubscriptions();
  const matches = subscriptions.filter(item => item.type === CLASS_REMINDER_TYPE && item.subscription);
  if (matches.length === 0) {
    config.sentClassReminderDates = [...sentDates, now.date];
    await storage.saveConfig(config);
    return;
  }

  const payload = JSON.stringify({
    title: '요가 수업 신청이 열렸어요',
    body: `${now.date} 수업 신청이 오전 9시에 시작됐어요.`,
    url: '/'
  });

  const staleEndpoints = new Set();
  await Promise.all(matches.map(async item => {
    try {
      await webpush.sendNotification(item.subscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleEndpoints.add(item.subscription.endpoint);
      } else {
        console.error('Class reminder push failed:', err.message || err);
      }
    }
  }));

  if (staleEndpoints.size > 0) {
    await storage.savePushSubscriptions(
      subscriptions.filter(item => !item.subscription || !staleEndpoints.has(item.subscription.endpoint))
    );
  }

  config.sentClassReminderDates = [...sentDates, now.date].slice(-60);
  await storage.saveConfig(config);
}

// ---------- 앱 ----------
const app = express();

function safeTextEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(actual || '', 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected || '', 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

app.use((req, res, next) => {
  if (!IS_STAGING) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const expires = tokens.get(token);
    if (expires && expires >= Date.now()) return next();
  }
  const encoded = auth.startsWith('Basic ') ? auth.slice(6) : '';
  let username = '';
  let password = '';
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  } catch (err) {
    // Invalid credentials are handled below.
  }
  if (!safeTextEqual(username, STAGING_USERNAME) || !safeTextEqual(password, STAGING_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Yoga staging", charset="UTF-8"');
    return res.status(401).send('Staging access requires authentication.');
  }
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/environment', (req, res) => {
  res.json({
    ...storage.getDiagnostics(),
    pushMode: PUSH_MODE,
    pushEnabled: PUSH_ENABLED,
    reminderSchedulerEnabled: REMINDER_SCHEDULER_ENABLED
  });
});

app.get('/api/state', async (req, res) => {
  try {
    let sessions = await storage.getSessions();
    sessions.forEach(ensureSessionShape);
    const config = await storage.getConfig();
    const changed = ensureUpcomingSessions(sessions, config);
    if (changed) {
      await storage.saveSessions(sessions);
    }
    res.json({
      sessions,
      config: {
        biweeklyFridayRef: config.biweeklyFridayRef,
        testMode: config.testMode,
        autoGenerate: config.autoGenerate !== false,
        hasPin: !!config.adminPinHash,
        environment: APP_ENV,
        openHour: OPEN_HOUR,
        closeHour: CLOSE_HOUR
      },
      serverNow: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 저장소에 연결할 수 없어요.' });
  }
});

app.get('/api/push/public-key', (req, res) => {
  res.json({ enabled: PUSH_ENABLED, publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', async (req, res) => {
  if (!PUSH_ENABLED) {
    return res.status(503).json({ error: '브라우저 푸시 알림이 아직 설정되지 않았어요.' });
  }

  const type = req.body.type === CLASS_REMINDER_TYPE ? CLASS_REMINDER_TYPE : PROMOTION_PUSH_TYPE;
  const date = req.body.date;
  const name = (req.body.name || '').trim();
  const subscription = req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '알림 등록 정보가 올바르지 않아요.' });
  }

  if (type === PROMOTION_PUSH_TYPE && (!date || !DATE_RE.test(date) || !name)) {
    return res.status(400).json({ error: '알림 등록 정보가 올바르지 않아요.' });
  }

  const subscriptions = await storage.getPushSubscriptions();
  const withoutSameEndpoint = subscriptions.filter(item => {
    if (!item.subscription || item.subscription.endpoint !== subscription.endpoint) return true;
    const itemType = item.type || PROMOTION_PUSH_TYPE;
    if (type === CLASS_REMINDER_TYPE) return itemType !== CLASS_REMINDER_TYPE;
    return !(itemType === PROMOTION_PUSH_TYPE && item.date === date && item.name === name);
  });
  withoutSameEndpoint.push({
    type,
    date,
    name,
    subscription,
    createdAt: new Date().toISOString()
  });
  await storage.savePushSubscriptions(withoutSameEndpoint);
  res.json({ ok: true });
});

app.get('/api/push/class-reminder/check', async (req, res) => {
  try {
    await sendClassReminderIfDue();
    res.json({ ok: true });
  } catch (err) {
    console.error('Class reminder check failed:', err.message || err);
    res.status(500).json({ error: '수업 신청 알림 확인에 실패했어요.' });
  }
});

app.get('/api/candidates', requireAdmin, async (req, res) => {
  const config = await storage.getConfig();
  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const existing = new Set(sessions.map(s => s.date));
  const out = [];
  const todayKST = fmtKST(Date.now());
  const startMs = kstMidnight(todayKST).getTime();
  for (let i = 0; i < 21; i++) {
    const ds = fmtKST(startMs + i * 24 * 3600 * 1000);
    if (isClassDay(ds, config) && !existing.has(ds)) out.push(ds);
  }
  res.json({ candidates: out });
});

app.post('/api/admin/setup', async (req, res) => {
  const config = await storage.getConfig();
  if (config.adminPinHash) {
    return res.status(400).json({ error: '이미 관리자 PIN이 설정되어 있어요.' });
  }
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) {
    return res.status(400).json({ error: 'PIN을 4자 이상 입력해주세요.' });
  }
  const newConfig = { ...DEFAULT_CONFIG, ...config, adminPinHash: await bcrypt.hash(String(pin), 10) };
  await storage.saveConfig(newConfig);
  res.json({ token: issueToken() });
});

app.post('/api/admin/login', async (req, res) => {
  const config = await storage.getConfig();
  if (!config.adminPinHash) {
    return res.status(400).json({ error: '아직 관리자 PIN이 설정되지 않았어요.' });
  }
  const { pin } = req.body;
  const ok = pin && await bcrypt.compare(String(pin), config.adminPinHash);
  if (!ok) return res.status(401).json({ error: 'PIN이 일치하지 않아요.' });
  res.json({ token: issueToken() });
});

app.post('/api/config/biweekly-ref', requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않아요.' });
  if (dowOf(date) !== 5) return res.status(400).json({ error: '금요일을 선택해주세요.' });
  const config = await storage.getConfig();
  config.biweeklyFridayRef = date;
  await storage.saveConfig(config);
  res.json({ ok: true, config });
});

app.post('/api/config/test-mode', requireAdmin, async (req, res) => {
  const config = await storage.getConfig();
  config.testMode = !!req.body.enabled;
  await storage.saveConfig(config);
  res.json({ ok: true, testMode: config.testMode });
});

app.post('/api/config/auto-generate', requireAdmin, async (req, res) => {
  const config = await storage.getConfig();
  config.autoGenerate = !!req.body.enabled;
  await storage.saveConfig(config);
  res.json({ ok: true, autoGenerate: config.autoGenerate });
});

app.post('/api/sessions', requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않아요.' });
  const sessions = await storage.getSessions();
  if (sessions.find(s => s.date === date)) return res.status(400).json({ error: '이미 등록된 날짜예요.' });
  sessions.push({ date, capacity: DEFAULT_CAPACITY, signups: [], waitlist: [], cancelled: [] });
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  await storage.saveSessions(sessions);

  // 예전에 관리자가 이 날짜를 삭제해서 스킵 목록에 있었다면, 수동으로 다시 추가한 것이므로 스킵 해제
  const config = await storage.getConfig();
  if (config.skippedDates && config.skippedDates.includes(date)) {
    config.skippedDates = config.skippedDates.filter(d => d !== date);
    await storage.saveConfig(config);
  }
  res.json({ ok: true, sessions });
});

app.delete('/api/sessions/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  let sessions = await storage.getSessions();
  sessions = sessions.filter(s => s.date !== date);
  await storage.saveSessions(sessions);

  // 자동생성이 같은 날짜를 다시 채워 넣지 않도록 스킵 목록에 기록
  const config = await storage.getConfig();
  const skip = new Set(config.skippedDates || []);
  skip.add(date);
  config.skippedDates = [...skip];
  await storage.saveConfig(config);

  res.json({ ok: true, sessions });
});

app.post('/api/sessions/:date/join', async (req, res) => {
  const date = req.params.date;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });

  const config = await storage.getConfig();
  if (isLocked(date, config)) {
    return res.status(403).json({ error: `아직 신청 오픈 전이에요 (해당 수업일 오전 ${OPEN_HOUR}시부터 가능).` });
  }
  if (isClosed(date, config)) {
    return res.status(403).json({ error: `신청이 마감됐어요 (${CLOSE_HOUR === 12 ? '정오(낮 12시)' : `오후 ${CLOSE_HOUR - 12}시`}에 마감).` });
  }
  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const s = sessions.find(x => x.date === date);
  if (!s) return res.status(404).json({ error: '존재하지 않는 세션이에요.' });

  if (s.signups.includes(name) || s.waitlist.includes(name)) {
    return res.status(409).json({ error: `${name}님은 이미 신청/대기 명단에 있어요.` });
  }
  let waitlisted = false;
  if (s.signups.length < sessionCapacity(s)) {
    s.signups.push(name);
  } else {
    s.waitlist.push(name);
    waitlisted = true;
  }
  await storage.saveSessions(sessions);
  res.json({ ok: true, waitlisted, sessions });
});

app.post('/api/sessions/:date/cancel', async (req, res) => {
  const date = req.params.date;
  const name = (req.body.name || '').trim();
  const fromWaitlist = !!req.body.fromWaitlist;
  if (isAttendanceFinalized(date)) {
    return res.status(403).json({ error: `취소 가능 시간이 지났어요 (${CLOSE_HOUR === 12 ? '정오(낮 12시)' : `오후 ${CLOSE_HOUR - 12}시`} 마감).` });
  }
  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const s = sessions.find(x => x.date === date);
  if (!s) return res.status(404).json({ error: '존재하지 않는 세션이에요.' });

  if (fromWaitlist) {
    const before = s.waitlist.length;
    s.waitlist = s.waitlist.filter(n => n !== name);
    if (s.waitlist.length < before) {
      recordCancellation(s, name, 'waitlist');
    }
  } else {
    const before = s.signups.length;
    s.signups = s.signups.filter(n => n !== name);
    let promotedName = null;
    if (s.signups.length < before) {
      if (s.waitlist.length > 0) {
        promotedName = s.waitlist.shift();
        s.signups.push(promotedName);
      }
      recordCancellation(s, name, 'signup', promotedName);
    }
    await storage.saveSessions(sessions);
    if (promotedName) {
      await sendPromotionPush(date, promotedName);
    }
    return res.json({ ok: true, promotedName, sessions });
  }
  await storage.saveSessions(sessions);
  res.json({ ok: true, sessions });
});

app.patch('/api/sessions/:date/capacity', requireAdmin, async (req, res) => {
  const date = req.params.date;
  const capacity = Number(req.body.capacity);
  if (isAttendanceFinalized(date)) {
    return res.status(403).json({ error: '정오 마감으로 출석이 확정된 수업은 정원을 변경할 수 없어요.' });
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return res.status(400).json({ error: `정원은 1명부터 ${MAX_CAPACITY}명까지 정수로 입력해주세요.` });
  }

  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const session = sessions.find(item => item.date === date);
  if (!session) return res.status(404).json({ error: '존재하지 않는 세션이에요.' });
  if (capacity < session.signups.length) {
    return res.status(409).json({ error: `현재 신청자 ${session.signups.length}명보다 정원을 낮출 수 없어요.` });
  }

  session.capacity = capacity;
  const promotedNames = [];
  while (session.signups.length < capacity && session.waitlist.length > 0) {
    const promotedName = session.waitlist.shift();
    session.signups.push(promotedName);
    promotedNames.push(promotedName);
  }
  await storage.saveSessions(sessions);
  for (const promotedName of promotedNames) {
    await sendPromotionPush(date, promotedName);
  }
  res.json({ ok: true, capacity, promotedNames, sessions });
});

// 기간별 출석 통계: 정오 마감이 지난 수업의 확정 신청자만 집계한다.
app.get('/api/stats', requireAdmin, async (req, res) => {
  let { start, end } = req.query;
  const month = req.query.month;
  if ((!start || !end) && /^\d{4}-\d{2}$/.test(month || '')) {
    const [year, monthNumber] = month.split('-').map(Number);
    start = `${month}-01`;
    end = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
  }
  if (!isValidDateString(start) || !isValidDateString(end)) {
    return res.status(400).json({ error: '시작일과 종료일을 올바르게 선택해주세요.' });
  }
  if (start > end) {
    return res.status(400).json({ error: '시작일은 종료일보다 늦을 수 없어요.' });
  }
  const rangeDays = Math.round((kstMidnight(end).getTime() - kstMidnight(start).getTime()) / (24 * 3600 * 1000)) + 1;
  if (rangeDays > 366) {
    return res.status(400).json({ error: '조회 기간은 최대 1년(366일)까지 선택할 수 있어요.' });
  }
  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const inRange = sessions.filter(s => s.date >= start && s.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const finalized = inRange.filter(s => isAttendanceFinalized(s.date));
  const sessionDates = finalized.map(s => s.date);

  const data = {}; // name -> { count, attended: { date: true } }
  finalized.forEach(s => {
    s.signups.forEach(name => {
      if (!data[name]) data[name] = { count: 0, attended: {} };
      data[name].count += 1;
      data[name].attended[s.date] = true;
    });
  });
  const rows = Object.entries(data)
    .map(([name, v]) => ({ name, count: v.count, attended: v.attended }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));

  res.json({
    start,
    end,
    month: month || null,
    sessionCount: finalized.length,
    excludedOpenSessionCount: inRange.length - finalized.length,
    sessionDates,
    rows
  });
});

if (REMINDER_SCHEDULER_ENABLED) {
  setInterval(() => {
    sendClassReminderIfDue().catch(err => {
      console.error('Class reminder scheduler failed:', err.message || err);
    });
  }, 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`요가동호회 신청 앱이 http://localhost:${PORT} 에서 실행 중입니다.`);
  console.log(`환경: ${APP_ENV}, 푸시: ${PUSH_ENABLED ? '활성' : '차단'}, 알림 스케줄러: ${REMINDER_SCHEDULER_ENABLED ? '활성' : '차단'}`);
});
