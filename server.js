const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const DEFAULT_CONFIG = { biweeklyFridayRef: null, adminPinHash: null, testMode: false, autoGenerate: true, skippedDates: [] };
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

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

// 앞으로 7일 안의 월/수/격주금 날짜 중, 아직 없고("existing") 관리자가 일부러 지운 적도 없는("skipped")
// 날짜만 골라 새 세션으로 채워 넣는다. 반환값: 세션이 하나라도 추가됐는지 여부.
function ensureUpcomingSessions(sessions, config) {
  if (config.autoGenerate === false) return false;
  const skipped = new Set(config.skippedDates || []);
  const existing = new Set(sessions.map(s => s.date));
  const todayKST = fmtKST(Date.now());
  const startMs = kstMidnight(todayKST).getTime();
  let changed = false;
  for (let i = 0; i < 7; i++) {
    const ds = fmtKST(startMs + i * 24 * 3600 * 1000);
    if (isClassDay(ds, config) && !existing.has(ds) && !skipped.has(ds)) {
      sessions.push({ date: ds, signups: [], waitlist: [], cancelled: [] });
      existing.add(ds);
      changed = true;
    }
  }
  if (changed) sessions.sort((a, b) => a.date.localeCompare(b.date));
  return changed;
}

function ensureSessionShape(session) {
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
  const matches = subscriptions.filter(item => item.date === date && item.name === name && item.subscription);
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

// ---------- 앱 ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  const date = req.body.date;
  const name = (req.body.name || '').trim();
  const subscription = req.body.subscription;
  if (!date || !DATE_RE.test(date) || !name || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '알림 등록 정보가 올바르지 않아요.' });
  }

  const subscriptions = await storage.getPushSubscriptions();
  const withoutSameEndpoint = subscriptions.filter(item => item.subscription && item.subscription.endpoint !== subscription.endpoint);
  withoutSameEndpoint.push({
    date,
    name,
    subscription,
    createdAt: new Date().toISOString()
  });
  await storage.savePushSubscriptions(withoutSameEndpoint);
  res.json({ ok: true });
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
  sessions.push({ date, signups: [], waitlist: [], cancelled: [] });
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
  if (s.signups.length < 14) {
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

// 월별 참석 통계: 대기(waitlist)는 제외하고, 실제 신청 완료(signups)된 횟수만 이름별로 집계
app.get('/api/stats', requireAdmin, async (req, res) => {
  const month = req.query.month; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month || '')) {
    return res.status(400).json({ error: '월 형식이 올바르지 않아요 (예: 2026-07).' });
  }
  const sessions = await storage.getSessions();
  sessions.forEach(ensureSessionShape);
  const inMonth = sessions.filter(s => s.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  const sessionDates = inMonth.map(s => s.date);

  const data = {}; // name -> { count, attended: { date: true } }
  inMonth.forEach(s => {
    s.signups.forEach(name => {
      if (!data[name]) data[name] = { count: 0, attended: {} };
      data[name].count += 1;
      data[name].attended[s.date] = true;
    });
  });
  const rows = Object.entries(data)
    .map(([name, v]) => ({ name, count: v.count, attended: v.attended }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));

  res.json({ month, sessionCount: inMonth.length, sessionDates, rows });
});

app.listen(PORT, () => {
  console.log(`요가동호회 신청 앱이 http://localhost:${PORT} 에서 실행 중입니다.`);
});
