const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const DEFAULT_CONFIG = { biweeklyFridayRef: null, adminPinHash: null, testMode: false };

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

function kstMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 60 * 60 * 1000);
}
function dowOf(dateStr) {
  return new Date(kstMidnight(dateStr).getTime() + 9 * 60 * 60 * 1000).getUTCDay();
}
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
function openTime(dateStr) {
  return new Date(kstMidnight(dateStr).getTime() + 9 * 60 * 60 * 1000);
}
function isLocked(dateStr, config) {
  if (config.testMode) return false;
  return Date.now() < openTime(dateStr).getTime();
}

// ---------- 앱 ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (req, res) => {
  try {
    const sessions = await storage.getSessions();
    const config = await storage.getConfig();
    res.json({
      sessions,
      config: {
        biweeklyFridayRef: config.biweeklyFridayRef,
        testMode: config.testMode,
        hasPin: !!config.adminPinHash
      },
      serverNow: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 저장소에 연결할 수 없어요.' });
  }
});

app.get('/api/candidates', requireAdmin, async (req, res) => {
  const config = await storage.getConfig();
  const sessions = await storage.getSessions();
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

app.post('/api/sessions', requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않아요.' });
  const sessions = await storage.getSessions();
  if (sessions.find(s => s.date === date)) return res.status(400).json({ error: '이미 등록된 날짜예요.' });
  sessions.push({ date, signups: [], waitlist: [] });
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  await storage.saveSessions(sessions);
  res.json({ ok: true, sessions });
});

app.delete('/api/sessions/:date', requireAdmin, async (req, res) => {
  let sessions = await storage.getSessions();
  sessions = sessions.filter(s => s.date !== req.params.date);
  await storage.saveSessions(sessions);
  res.json({ ok: true, sessions });
});

app.post('/api/sessions/:date/join', async (req, res) => {
  const date = req.params.date;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });

  const config = await storage.getConfig();
  if (isLocked(date, config)) {
    return res.status(403).json({ error: '아직 신청 오픈 전이에요 (해당 수업일 오전 9시부터 가능).' });
  }
  const sessions = await storage.getSessions();
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
  const s = sessions.find(x => x.date === date);
  if (!s) return res.status(404).json({ error: '존재하지 않는 세션이에요.' });

  if (fromWaitlist) {
    s.waitlist = s.waitlist.filter(n => n !== name);
  } else {
    const before = s.signups.length;
    s.signups = s.signups.filter(n => n !== name);
    if (s.signups.length < before && s.waitlist.length > 0) {
      s.signups.push(s.waitlist.shift());
    }
  }
  await storage.saveSessions(sessions);
  res.json({ ok: true, sessions });
});

app.listen(PORT, () => {
  console.log(`요가동호회 신청 앱이 http://localhost:${PORT} 에서 실행 중입니다.`);
});
