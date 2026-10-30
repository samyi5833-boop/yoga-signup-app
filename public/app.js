const DOW = ['일','월','화','수','목','금','토'];
let sessions = [];
let config = { biweeklyFridayRef: null, testMode: false, autoGenerate: true, hasPin: false, environment: 'production', openHour: 9, closeHour: 12 };
let showHistory = false;
let showCandidates = false;
let settingsOpen = false;
let activeView = 'main';
let isAdmin = !!localStorage.getItem('yoga_admin_token');
let loginMode = null;
let pendingCancel = null;
let pendingDeleteSession = null; // 삭제 확인 대기 중인 세션 날짜
let candidates = [];
let connError = null;
let pushState = { supported: false, enabled: false, publicKey: null, reason: '' };
let calendarMonth = null; // 'YYYY-MM', 초기 렌더 때 오늘 기준으로 채움
let attendanceKing = null;

function token(){ return localStorage.getItem('yoga_admin_token'); }
function authHeaders(){
  const t = token();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
async function api(path, opts = {}, retryAfterExpiredAdmin = true){
  const hadAdminToken = !!token();
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(opts.headers || {})
    }
  });
  let data = null;
  try { data = await res.json(); } catch(e){ /* no body */ }
  if(!res.ok){
    if(res.status === 401 && hadAdminToken){
      isAdmin = false;
      localStorage.removeItem('yoga_admin_token');
      if(retryAfterExpiredAdmin){
        return api(path, opts, false);
      }
    }
    throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  }
  return data;
}

function todayStr(){ return fmt(new Date()); }
function fmt(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function parseLocal(str){ const [y,m,d]=str.split('-').map(Number); return new Date(y,m-1,d); }
function dayLabel(dateStr){ return DOW[parseLocal(dateStr).getDay()]; }
function openTime(dateStr){ const d=parseLocal(dateStr); d.setHours(config.openHour ?? 9, 0, 0, 0); return d; }
function closeTime(dateStr){ const d=parseLocal(dateStr); d.setHours(config.closeHour ?? 12, 0, 0, 0); return d; }
function isLocked(dateStr){
  if(config.testMode) return false;
  return new Date() < openTime(dateStr);
}
function isClosed(dateStr){
  if(config.testMode) return false;
  return new Date() >= closeTime(dateStr);
}
function escapeHtml(str){
  return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function capacityFor(session){
  return Number.isInteger(session.capacity) && session.capacity > 0 ? session.capacity : 14;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

async function loadPushState(){
  pushState.supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if(!pushState.supported){
    pushState.reason = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? 'iPhone/iPad는 Safari에서 공유 버튼 → 홈 화면에 추가 후, 홈 화면 아이콘으로 열어야 알림을 켤 수 있어요.'
      : '이 모바일 브라우저는 브라우저 푸시 알림을 지원하지 않아요. Chrome 또는 Edge 최신 버전에서 다시 열어보세요.';
    return;
  }
  try{
    const data = await api('/push/public-key');
    pushState.enabled = !!data.enabled;
    pushState.publicKey = data.publicKey;
    pushState.reason = pushState.enabled ? '' : '서버 알림 설정이 아직 완료되지 않았어요.';
  }catch(e){
    pushState.enabled = false;
    pushState.reason = '서버 알림 설정을 확인하지 못했어요.';
  }
}

async function registerPromotionPush(date, name){
  if(!pushState.supported) throw new Error('이 브라우저는 푸시 알림을 지원하지 않아요.');
  if(!pushState.enabled || !pushState.publicKey) throw new Error('서버 푸시 알림 설정이 아직 완료되지 않았어요.');
  if(Notification.permission === 'denied') throw new Error('브라우저 알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요.');

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if(permission !== 'granted') throw new Error('알림 권한을 허용해야 승급 알림을 받을 수 있어요.');

  const registration = await navigator.serviceWorker.register('/sw.js');
  let subscription = await registration.pushManager.getSubscription();
  if(!subscription){
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushState.publicKey)
    });
  }

  await api('/push/subscribe', {
    method:'POST',
    body: JSON.stringify({ date, name, subscription: subscription.toJSON ? subscription.toJSON() : subscription })
  });
  localStorage.setItem(`yoga_push_${date}_${name}`, '1');
}

async function registerClassReminderPush(){
  if(!pushState.supported) throw new Error('이 브라우저는 푸시 알림을 지원하지 않아요.');
  if(!pushState.enabled || !pushState.publicKey) throw new Error('서버 푸시 알림 설정이 아직 완료되지 않았어요.');
  if(Notification.permission === 'denied') throw new Error('브라우저 알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요.');

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if(permission !== 'granted') throw new Error('알림 권한을 허용해야 수업 신청 알림을 받을 수 있어요.');

  const registration = await navigator.serviceWorker.register('/sw.js');
  let subscription = await registration.pushManager.getSubscription();
  if(!subscription){
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushState.publicKey)
    });
  }

  await api('/push/subscribe', {
    method:'POST',
    body: JSON.stringify({
      type: 'classReminder',
      subscription: subscription.toJSON ? subscription.toJSON() : subscription
    })
  });
  localStorage.setItem('yoga_class_reminder_push', '1');
}

async function refreshState(){
  try{
    const data = await api('/state');
    sessions = data.sessions;
    config = data.config;
    connError = null;
    await loadAttendanceKing();
  }catch(e){
    connError = '서버에 연결할 수 없어요. 네트워크 상태를 확인해주세요.';
  }
  render();
}

async function loadAttendanceKing(){
  const now = new Date();
  const start = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
  const end = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  try{
    attendanceKing = await api(`/stats?start=${start}&end=${end}`);
  }catch(e){
    attendanceKing = { start, end, sessionCount: 0, rows: [], error: true };
  }
}

async function loadCandidatesIfNeeded(){
  if(!isAdmin || !showCandidates){ candidates = []; return; }
  try{
    const data = await api('/candidates');
    candidates = data.candidates;
  }catch(e){ candidates = []; }
}

async function addSessionDate(dateStr){
  if(!isAdmin) return;
  try{
    await api('/sessions', { method:'POST', body: JSON.stringify({ date: dateStr }) });
    showCandidates = false;
    await refreshState();
  }catch(e){ alertInline('candidatesBox', e.message); }
}

function alertInline(boxId, msg){
  const box = document.getElementById(boxId);
  const p = document.createElement('p');
  p.className = 'field-error';
  p.textContent = msg;
  box.prepend(p);
  setTimeout(()=>p.remove(), 4000);
}

async function join(dateStr, inputEl, errEl, pushEl){
  const name = inputEl.value.trim();
  errEl.textContent = '';
  if(!name){ errEl.textContent = '이름을 입력해주세요.'; return; }
  try{
    await api(`/sessions/${dateStr}/join`, { method:'POST', body: JSON.stringify({ name }) });
    if(pushEl && pushEl.checked){
      try{
        await registerPromotionPush(dateStr, name);
      }catch(pushErr){
        errEl.textContent = pushErr.message;
      }
    }
    inputEl.value = '';
    await refreshState();
  }catch(e){ errEl.textContent = e.message; }
}

function requestCancel(date, name, fromWaitlist){
  if(pendingCancel && pendingCancel.date===date && pendingCancel.name===name){
    pendingCancel = null;
  } else {
    pendingCancel = { date, name, fromWaitlist };
  }
  render();
}
async function confirmCancel(date, name, fromWaitlist){
  try{
    await api(`/sessions/${date}/cancel`, { method:'POST', body: JSON.stringify({ name, fromWaitlist }) });
  }catch(e){
    pendingCancel = null;
    render();
    alertInline('sessionList', e.message);
    return;
  }
  pendingCancel = null;
  await refreshState();
}

function requestDeleteSession(date){
  if(!isAdmin) return;
  pendingDeleteSession = (pendingDeleteSession === date) ? null : date;
  render();
}
async function confirmDeleteSession(date){
  if(!isAdmin) return;
  try{
    await api(`/sessions/${date}`, { method:'DELETE' });
  }catch(e){ /* 조용히 무시, 다음 refresh에서 상태 재동기화 */ }
  pendingDeleteSession = null;
  await refreshState();
}

function renderLoginBox(){
  const box = document.getElementById('loginBox');
  if(!loginMode){ box.innerHTML=''; return; }

  if(loginMode === 'setup'){
    box.innerHTML = `
      <div class="login-box">
        <p class="help" style="margin-top:0;">처음 설정이에요. 관리자 PIN을 새로 만들어주세요 (4자 이상 권장).</p>
        <div class="panel-row">
          <input type="password" id="pinNew" placeholder="새 PIN">
          <input type="password" id="pinNew2" placeholder="PIN 확인">
        </div>
        <div class="panel-row">
          <button id="pinSetupBtn">설정하고 로그인</button>
          <button class="secondary" id="pinCancelBtn">취소</button>
        </div>
        <p class="field-error" id="pinError"></p>
      </div>`;
    document.getElementById('pinSetupBtn').addEventListener('click', async ()=>{
      const p1 = document.getElementById('pinNew').value;
      const p2 = document.getElementById('pinNew2').value;
      const err = document.getElementById('pinError');
      if(!p1 || p1.length < 4){ err.textContent = 'PIN을 4자 이상 입력해주세요.'; return; }
      if(p1 !== p2){ err.textContent = '두 PIN이 서로 달라요.'; return; }
      try{
        const data = await api('/admin/setup', { method:'POST', body: JSON.stringify({ pin: p1 }) });
        localStorage.setItem('yoga_admin_token', data.token);
        isAdmin = true; loginMode = null;
        await refreshState();
      }catch(e){ err.textContent = e.message; }
    });
    document.getElementById('pinCancelBtn').addEventListener('click', ()=>{ loginMode=null; render(); });
  } else {
    box.innerHTML = `
      <div class="login-box">
        <div class="panel-row">
          <input type="password" id="pinInput" placeholder="관리자 PIN">
          <button id="pinLoginBtn">확인</button>
          <button class="secondary" id="pinCancelBtn2">취소</button>
        </div>
        <p class="field-error" id="pinError2"></p>
      </div>`;
    document.getElementById('pinLoginBtn').addEventListener('click', async ()=>{
      const val = document.getElementById('pinInput').value;
      const err = document.getElementById('pinError2');
      try{
        const data = await api('/admin/login', { method:'POST', body: JSON.stringify({ pin: val }) });
        localStorage.setItem('yoga_admin_token', data.token);
        isAdmin = true; loginMode = null;
        await refreshState();
      }catch(e){ err.textContent = e.message; }
    });
    document.getElementById('pinCancelBtn2').addEventListener('click', ()=>{ loginMode=null; render(); });
  }
}

function renderViewNavigation(){
  const views = ['main', 'stats', 'admin'];
  views.forEach(view => {
    const panel = document.getElementById(`${view}View`);
    const button = document.getElementById(`view${view[0].toUpperCase()}${view.slice(1)}Btn`);
    const active = activeView === view;
    panel.style.display = active ? 'block' : 'none';
    button.classList.toggle('active', active);
    if(active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function renderAdminUI(){
  document.getElementById('adminActions').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('adminLoginBtn').style.display = isAdmin ? 'none' : 'inline-block';
  document.getElementById('adminLogoutBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('adminStatus').textContent = isAdmin ? '관리자 모드' : '일반 회원 모드';
  if(!isAdmin){
    showCandidates = false;
    settingsOpen = false;
    document.getElementById('settingsPanel').style.display = 'none';
    document.getElementById('candidatesBox').innerHTML = '';
  } else {
    document.getElementById('settingsPanel').style.display = settingsOpen ? 'block' : 'none';
  }
  document.getElementById('showCandidatesBtn').classList.toggle('active', isAdmin && showCandidates);
  document.getElementById('toggleSettingsBtn').classList.toggle('active', isAdmin && settingsOpen);
  renderLoginBox();
}

function renderAttendanceKing(){
  const box = document.getElementById('attendanceKingBox');
  if(!attendanceKing || attendanceKing.error){ box.innerHTML = ''; return; }
  if(attendanceKing.rows.length === 0){
    box.innerHTML = `<div class="attendance-king">
      <div class="king-icon">🏆</div>
      <div><strong>이달의 출석왕</strong><p>아직 정오 마감이 끝난 출석 기록이 없어요.</p></div>
    </div>`;
    return;
  }
  const topCount = attendanceKing.rows[0].count;
  const leaders = attendanceKing.rows.filter(row => row.count === topCount);
  box.innerHTML = `<div class="attendance-king">
    <div class="king-icon">🏆</div>
    <div>
      <strong>이달의 출석왕</strong>
      <div class="king-names">${leaders.map(row => `<span>${escapeHtml(row.name)}</span>`).join('')}</div>
      <p>${topCount}회 출석 · 정오 마감 완료 수업 기준${leaders.length > 1 ? ' · 공동 1위' : ''}</p>
    </div>
  </div>`;
}

function renderTestBanner(){
  const banners = [];
  if(config.environment === 'staging'){
    banners.push('<div class="test-banner">🧪 STAGING 테스트 사이트 — 운영 데이터와 푸시 알림에 연결되지 않습니다.</div>');
  }
  if(config.testMode){
    banners.push('<div class="test-banner">테스트 모드 켜짐 — 9시 잠금이 해제되어 있어요.</div>');
  }
  document.getElementById('testBannerBox').innerHTML = banners.join('');
}

async function saveSessionCapacity(date, inputEl, errEl){
  if(!isAdmin) return;
  errEl.textContent = '';
  const capacity = Number(inputEl.value);
  if(!Number.isInteger(capacity) || capacity < 1 || capacity > 100){
    errEl.textContent = '정원은 1명부터 100명까지 정수로 입력해주세요.';
    return;
  }
  try{
    const data = await api(`/sessions/${date}/capacity`, {
      method:'PATCH',
      body: JSON.stringify({ capacity })
    });
    await refreshState();
    if(data.promotedNames && data.promotedNames.length){
      alertInline('sessionList', `대기자 ${data.promotedNames.join(', ')}님이 신청자로 승급됐어요.`);
    }
  }catch(e){ errEl.textContent = e.message; }
}

function renderConnError(){
  document.getElementById('connErrorBox').innerHTML = connError
    ? `<div class="conn-error">${connError}</div>` : '';
}

function renderReminderBox(){
  const box = document.getElementById('reminderBox');
  if(!box) return;

  const enabled = localStorage.getItem('yoga_class_reminder_push') === '1';
  const disabled = !pushState.supported || !pushState.enabled;
  const help = disabled && pushState.reason ? `<p class="push-help">${escapeHtml(pushState.reason)}</p>` : '';
  box.innerHTML = `
    <div class="reminder-panel">
      <div>
        <strong>수업 신청 알림</strong>
        <span>수업일 오전 9시에 신청 시작 알림을 받을 수 있어요.</span>
      </div>
      <button id="classReminderBtn" ${enabled || disabled ? 'disabled' : ''}>${enabled ? '알림 켜짐' : '알림 받기'}</button>
    </div>
    ${help}`;

  const btn = document.getElementById('classReminderBtn');
  if(btn && !enabled && !disabled){
    btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      try{
        await registerClassReminderPush();
        renderReminderBox();
      }catch(e){
        btn.disabled = false;
        box.insertAdjacentHTML('beforeend', `<p class="field-error">${escapeHtml(e.message)}</p>`);
      }
    });
  }
}

function shiftMonth(monthStr, delta){
  const [y,m] = monthStr.split('-').map(Number);
  const d = new Date(y, m-1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function renderCalendar(){
  if(!calendarMonth) calendarMonth = todayStr().slice(0,7);
  const [year, monthNum] = calendarMonth.split('-').map(Number);
  const today = todayStr();

  const firstDow = new Date(year, monthNum-1, 1).getDay();
  const daysInMonth = new Date(year, monthNum, 0).getDate();

  const sessionByDate = {};
  sessions.forEach(s => { sessionByDate[s.date] = s; });

  let cells = '';
  for(let i=0; i<firstDow; i++){
    cells += `<div class="cal-cell empty"></div>`;
  }
  for(let day=1; day<=daysInMonth; day++){
    const dateStr = `${year}-${String(monthNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const s = sessionByDate[dateStr];
    let countClass = '';
    let countLabel = '';
    if(s){
      const capacity = capacityFor(s);
      const full = s.signups.length >= capacity;
      const locked = isLocked(dateStr);
      const closed = !locked && isClosed(dateStr);
      countClass = locked ? 'count-locked' : (closed ? 'count-closed' : (full ? 'count-full' : 'count-open'));
      countLabel = `${s.signups.length}/${capacity}`;
    }
    const isToday = dateStr === today;
    cells += `<div class="cal-cell${s ? ' has-session' : ''}${isToday ? ' today' : ''}" ${s ? `data-cal-date="${dateStr}"` : ''}>
      <span class="cal-daynum">${day}</span>
      ${s ? `<span class="cal-count ${countClass}">${countLabel}</span>` : ''}
    </div>`;
  }

  const box = document.getElementById('calendarBox');
  box.innerHTML = `
    <div class="calendar-panel">
      <div class="calendar-header">
        <button class="cal-nav-btn" id="calPrevBtn" aria-label="이전 달">‹</button>
        <span class="calendar-title">${year}년 ${monthNum}월</span>
        <button class="cal-nav-btn" id="calNextBtn" aria-label="다음 달">›</button>
      </div>
      <div class="calendar-grid calendar-dow">
        ${DOW.map(d=>`<div class="cal-dow-label">${d}</div>`).join('')}
      </div>
      <div class="calendar-grid">${cells}</div>
      <div class="calendar-legend">
        <span><span class="cal-dot dot-open"></span>신청 가능</span>
        <span><span class="cal-dot dot-locked"></span>오픈 전</span>
        <span><span class="cal-dot dot-full"></span>정원마감</span>
        <span><span class="cal-dot dot-closed"></span>시간마감</span>
      </div>
    </div>`;

  document.getElementById('calPrevBtn').addEventListener('click', ()=>{
    calendarMonth = shiftMonth(calendarMonth, -1);
    render();
  });
  document.getElementById('calNextBtn').addEventListener('click', ()=>{
    calendarMonth = shiftMonth(calendarMonth, 1);
    render();
  });
  box.querySelectorAll('[data-cal-date]').forEach(el=>{
    el.addEventListener('click', ()=> scrollToSession(el.dataset.calDate));
  });
}

function scrollToSession(dateStr){
  const exists = sessions.find(s => s.date === dateStr);
  if(!exists) return;
  const needsHistory = dateStr < todayStr() && !showHistory;
  if(needsHistory){ showHistory = true; render(); }
  const el = document.querySelector(`[data-session="${dateStr}"]`);
  if(el) el.scrollIntoView({ behavior:'smooth', block:'center' });
}

function renderCandidates(){
  const box = document.getElementById('candidatesBox');
  if(!isAdmin || !showCandidates){ box.innerHTML=''; return; }
  if(candidates.length===0){
    box.innerHTML = `<div class="panel"><p class="help" style="margin-top:0;">추가할 수 있는 다음 수업일 후보가 없어요. 격주 금요일 기준일을 먼저 설정해주세요.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="panel">
    <h3>수업일 후보</h3>
    <div class="candidates">
      ${candidates.map(ds=>`<button class="cand-btn" data-date="${ds}">${ds} (${dayLabel(ds)})</button>`).join('')}
    </div>
  </div>`;
  box.querySelectorAll('.cand-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> addSessionDate(btn.dataset.date));
  });
}

function sessionCard(s){
  const capacity = capacityFor(s);
  const locked = isLocked(s.date);
  const closed = !locked && isClosed(s.date);
  const full = s.signups.length >= capacity;
  let statusLabel, statusClass;
  if(locked){ statusLabel = `오전 ${config.openHour ?? 9}시부터 신청 오픈`; statusClass='locked'; }
  else if(closed){ statusLabel = '신청 마감'; statusClass='closed'; }
  else if(full){ statusLabel = '정원 마감 · 대기 접수 중'; statusClass='full'; }
  else { statusLabel = `신청 가능 · ${capacity-s.signups.length}자리 남음`; statusClass='open'; }

  const matsHtml = Array.from({length:capacity}).map((_,i)=>
    `<div class="mat ${i < s.signups.length ? 'filled' : ''}"></div>`
  ).join('');

  const rowHtml = (n, idx, fromWaitlist) => {
    const isPending = pendingCancel && pendingCancel.date===s.date && pendingCancel.name===n && pendingCancel.fromWaitlist===fromWaitlist;
    const actions = closed
      ? ''
      : isPending
      ? `<button class="confirm-chip yes" data-act="confirm" data-date="${s.date}" data-name="${escapeHtml(n)}" data-wait="${fromWaitlist?1:0}">취소 확정</button>
         <button class="confirm-chip no" data-act="dismiss">아니오</button>`
      : `<button class="cancel-btn" data-act="request" data-date="${s.date}" data-name="${escapeHtml(n)}" data-wait="${fromWaitlist?1:0}">✕</button>`;
    return `<li><span style="display:flex;align-items:center;min-width:0;">
        <span class="name-idx">${idx+1}</span><span class="name-text">${escapeHtml(n)}</span>
      </span>
      <span class="row-actions">${actions}</span></li>`;
  };

  const signupsHtml = s.signups.length
    ? `<ul class="namelist">${s.signups.map((n,i)=>rowHtml(n,i,false)).join('')}</ul>`
    : `<p class="empty-note">아직 신청자가 없어요.</p>`;
  const waitHtml = s.waitlist.length
    ? `<ul class="namelist">${s.waitlist.map((n,i)=>rowHtml(n,i,true)).join('')}</ul>`
    : '';
  const cancelledHtml = Array.isArray(s.cancelled) && s.cancelled.length
    ? `<div class="list-label">취소 내역</div>
      <ul class="namelist cancelled-list">
        ${s.cancelled.slice().reverse().map(item => {
          const when = item.cancelledAt ? new Date(item.cancelledAt).toLocaleString('ko-KR') : '';
          const fromLabel = item.from === 'waitlist' ? '대기 취소' : '신청 취소';
          const promoted = item.promotedName ? ` · ${escapeHtml(item.promotedName)} 승급` : '';
          return `<li><span style="display:flex;align-items:center;min-width:0;">
            <span class="name-text">${escapeHtml(item.name)} <span class="cancel-meta">${fromLabel}${promoted}</span></span>
          </span><span class="cancel-time">${escapeHtml(when)}</span></li>`;
        }).join('')}
      </ul>`
    : '';
  const joinBtnLabel = full ? '대기 신청' : '신청하기';

  const pushAvailable = pushState.supported && pushState.enabled;
  const pushHelpHtml = pushAvailable || !full || !pushState.reason
    ? ''
    : `<p class="push-help">${escapeHtml(pushState.reason)}</p>`;

  const isPendingDelete = pendingDeleteSession === s.date;
  const isAdminScreen = isAdmin && activeView === 'admin';
  const capacityHtml = isAdminScreen && !closed
    ? `<div class="capacity-row">
        <label for="capacity-${s.date}">회당 최대 인원</label>
        <input id="capacity-${s.date}" type="number" min="${Math.max(1, s.signups.length)}" max="100" value="${capacity}" data-capacity-input="${s.date}">
        <button data-capacity-save="${s.date}">저장</button>
        <span class="field-error" data-capacity-error="${s.date}"></span>
      </div>`
    : '';
  const adminDeleteHtml = isAdminScreen
    ? (isPendingDelete
        ? `<div class="delete-confirm-row">
            <span class="field-error" style="margin:0;">이 수업일을 삭제할까요? 신청자·대기자 명단도 함께 사라져요.</span>
            <button class="confirm-chip yes" data-act="delete-confirm" data-date="${s.date}">삭제 확정</button>
            <button class="confirm-chip no" data-act="delete-dismiss">아니오</button>
          </div>`
        : `<div class="delete-confirm-row">
            <button class="admin-delete-btn" data-act="delete-request" data-date="${s.date}">이 수업일 삭제</button>
          </div>`)
    : '';

  return `
  <div class="card" data-session="${s.date}">
    <div class="session-head">
      <div><span class="session-date">${s.date}</span><span class="session-day">${dayLabel(s.date)}요일</span></div>
      <div class="status ${statusClass}">${statusLabel}</div>
    </div>
    ${capacityHtml}
    ${adminDeleteHtml}
    <div class="mats" style="grid-template-columns:repeat(${Math.min(capacity, 20)},1fr)">${matsHtml}</div>
    <div class="list-label">신청 (${s.signups.length}/${capacity})</div>
    ${signupsHtml}
    ${cancelledHtml}
    ${s.waitlist.length ? `<div class="list-label">대기</div>${waitHtml}` : ''}
    ${locked
      ? `<div class="locked-msg">이 수업은 ${s.date} 오전 ${config.openHour ?? 9}시부터 신청할 수 있어요.</div>`
      : closed
      ? `<div class="closed-msg">신청이 마감됐어요 (${(config.closeHour ?? 12) === 12 ? '정오(낮 12시)' : `오후 ${(config.closeHour ?? 12) - 12}시`}에 마감).</div>`
      : `<div class="join-row">
          <input type="text" placeholder="이름을 입력하세요" data-input="${s.date}">
          <button class="${full ? 'waitlist' : ''}" data-join="${s.date}">${joinBtnLabel}</button>
        </div>
        ${full ? `<label class="push-opt"><input type="checkbox" data-push="${s.date}" ${pushState.enabled ? '' : 'disabled'}> 승급되면 브라우저 알림 받기</label>` : ''}
        <p class="field-error" data-err="${s.date}"></p>`
    }
  </div>`;
}

function render(){
  renderConnError();
  renderReminderBox();
  renderCalendar();
  renderAttendanceKing();
  renderViewNavigation();
  renderAdminUI();
  renderTestBanner();
  renderCandidates();

  const today = todayStr();
  const visible = sessions.filter(s => showHistory ? true : s.date >= today);
  const sorted = [...visible].sort((a,b)=>a.date.localeCompare(b.date));

  const listEl = document.getElementById('sessionList');
  if(sorted.length===0){
    listEl.innerHTML = `<div class="empty-state">등록된 수업일이 없어요.${isAdmin ? "<br>위의 '다음 수업일 추가' 버튼으로 시작해보세요." : ""}</div>`;
  } else {
    listEl.innerHTML = sorted.map(sessionCard).join('');
  }

  const showSessionList = activeView === 'main' || (activeView === 'admin' && isAdmin);
  listEl.style.display = showSessionList ? 'block' : 'none';
  document.querySelector('.footer-toggle').style.display = showSessionList ? 'block' : 'none';

  if(pushState.reason){
    listEl.querySelectorAll('[data-push]:disabled').forEach(input=>{
      const label = input.closest('.push-opt');
      if(label && !label.nextElementSibling?.classList.contains('push-help')){
        label.insertAdjacentHTML('afterend', `<p class="push-help">${escapeHtml(pushState.reason)}</p>`);
      }
    });
  }

  listEl.querySelectorAll('[data-join]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const date = btn.dataset.join;
      const input = listEl.querySelector(`[data-input="${date}"]`);
      const err = listEl.querySelector(`[data-err="${date}"]`);
      const push = listEl.querySelector(`[data-push="${date}"]`);
      join(date, input, err, push);
    });
  });
  listEl.querySelectorAll('[data-input]').forEach(inp=>{
    inp.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){
        const date = inp.dataset.input;
        const err = listEl.querySelector(`[data-err="${date}"]`);
        const push = listEl.querySelector(`[data-push="${date}"]`);
        join(date, inp, err, push);
      }
    });
  });
  listEl.querySelectorAll('[data-act="request"]').forEach(btn=>{
    btn.addEventListener('click', ()=> requestCancel(btn.dataset.date, btn.dataset.name, btn.dataset.wait==='1'));
  });
  listEl.querySelectorAll('[data-act="confirm"]').forEach(btn=>{
    btn.addEventListener('click', ()=> confirmCancel(btn.dataset.date, btn.dataset.name, btn.dataset.wait==='1'));
  });
  listEl.querySelectorAll('[data-act="dismiss"]').forEach(btn=>{
    btn.addEventListener('click', ()=> { pendingCancel = null; render(); });
  });
  listEl.querySelectorAll('[data-act="delete-request"]').forEach(btn=>{
    btn.addEventListener('click', ()=> requestDeleteSession(btn.dataset.date));
  });
  listEl.querySelectorAll('[data-act="delete-confirm"]').forEach(btn=>{
    btn.addEventListener('click', ()=> confirmDeleteSession(btn.dataset.date));
  });
  listEl.querySelectorAll('[data-act="delete-dismiss"]').forEach(btn=>{
    btn.addEventListener('click', ()=> { pendingDeleteSession = null; render(); });
  });
  listEl.querySelectorAll('[data-capacity-save]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const date = btn.dataset.capacitySave;
      const input = listEl.querySelector(`[data-capacity-input="${date}"]`);
      const err = listEl.querySelector(`[data-capacity-error="${date}"]`);
      saveSessionCapacity(date, input, err);
    });
  });

  document.getElementById('refDate').value = config.biweeklyFridayRef || '';
  document.getElementById('testModeToggle').checked = !!config.testMode;
  document.getElementById('autoGenToggle').checked = config.autoGenerate !== false;
  document.getElementById('historyToggle').textContent = showHistory ? '지난 수업 숨기기' : '지난 수업 기록 보기';
}

document.getElementById('adminLoginBtn').addEventListener('click', ()=>{
  loginMode = config.hasPin ? 'login' : 'setup';
  render();
});
document.getElementById('adminLogoutBtn').addEventListener('click', ()=>{
  isAdmin = false;
  localStorage.removeItem('yoga_admin_token');
  showCandidates = false;
  settingsOpen = false;
  render();
});
document.getElementById('showCandidatesBtn').addEventListener('click', async ()=>{
  if(!isAdmin) return;
  showCandidates = !showCandidates;
  settingsOpen = false;
  await loadCandidatesIfNeeded();
  render();
});
document.getElementById('toggleSettingsBtn').addEventListener('click', ()=>{
  if(!isAdmin) return;
  settingsOpen = !settingsOpen;
  showCandidates = false;
  render();
});
document.getElementById('saveRefBtn').addEventListener('click', async ()=>{
  if(!isAdmin) return;
  const val = document.getElementById('refDate').value;
  const err = document.getElementById('refDateError');
  err.textContent = '';
  if(!val){ err.textContent = '날짜를 선택해주세요.'; return; }
  try{
    await api('/config/biweekly-ref', { method:'POST', body: JSON.stringify({ date: val }) });
    await refreshState();
  }catch(e){ err.textContent = e.message; }
});
document.getElementById('addManualBtn').addEventListener('click', async ()=>{
  if(!isAdmin) return;
  const val = document.getElementById('manualDate').value;
  const err = document.getElementById('manualDateError');
  err.textContent = '';
  if(!val){ err.textContent = '날짜를 선택해주세요.'; return; }
  try{
    await api('/sessions', { method:'POST', body: JSON.stringify({ date: val }) });
    document.getElementById('manualDate').value = '';
    await refreshState();
  }catch(e){ err.textContent = e.message; }
});
document.getElementById('testModeToggle').addEventListener('change', async (e)=>{
  if(!isAdmin){ e.target.checked = false; return; }
  try{
    await api('/config/test-mode', { method:'POST', body: JSON.stringify({ enabled: e.target.checked }) });
    await refreshState();
  }catch(err){ e.target.checked = !e.target.checked; }
});
document.getElementById('autoGenToggle').addEventListener('change', async (e)=>{
  if(!isAdmin){ e.target.checked = true; return; }
  try{
    await api('/config/auto-generate', { method:'POST', body: JSON.stringify({ enabled: e.target.checked }) });
    await refreshState();
  }catch(err){ e.target.checked = !e.target.checked; }
});
function switchView(view){
  activeView = view;
  if(view !== 'admin'){
    showCandidates = false;
    settingsOpen = false;
  }
  if(view === 'stats' && !document.getElementById('statsStart').value){
    setStatsMonth(0);
  }
  render();
}
document.getElementById('viewMainBtn').addEventListener('click', ()=>switchView('main'));
document.getElementById('viewStatsBtn').addEventListener('click', ()=>switchView('stats'));
document.getElementById('viewAdminBtn').addEventListener('click', ()=>switchView('admin'));
let lastStatsRows = null;
let lastStatsStart = null;
let lastStatsEnd = null;
let lastStatsSessionDates = null;
function setStatsMonth(offset){
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  document.getElementById('statsStart').value = fmt(first);
  document.getElementById('statsEnd').value = fmt(last);
}
document.getElementById('statsThisMonthBtn').addEventListener('click', ()=>setStatsMonth(0));
document.getElementById('statsLastMonthBtn').addEventListener('click', ()=>setStatsMonth(-1));
document.getElementById('statsLoadBtn').addEventListener('click', async ()=>{
  const start = document.getElementById('statsStart').value;
  const end = document.getElementById('statsEnd').value;
  const err = document.getElementById('statsError');
  const resultBox = document.getElementById('statsResult');
  const exportBtn = document.getElementById('statsExportBtn');
  err.textContent = '';
  if(!start || !end){ err.textContent = '시작일과 종료일을 모두 선택해주세요.'; return; }
  if(start > end){ err.textContent = '시작일은 종료일보다 늦을 수 없어요.'; return; }
  try{
    const data = await api(`/stats?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    lastStatsRows = data.rows;
    lastStatsStart = data.start;
    lastStatsEnd = data.end;
    lastStatsSessionDates = data.sessionDates;
    if(data.rows.length === 0){
      resultBox.innerHTML = `<p class="empty-note">선택한 기간에는 확정된 출석 기록이 없어요 (마감 완료 수업 ${data.sessionCount}개).</p>`;
      exportBtn.style.display = 'none';
    } else {
      const dateHeaders = data.sessionDates.map(d=>
        `<th>${d.slice(5)}<span class="stats-th-dow">${dayLabel(d)}</span></th>`
      ).join('');
      const bodyRows = data.rows.map(r => `
        <tr>
          <td class="stats-name-cell">${escapeHtml(r.name)}</td>
          ${data.sessionDates.map(d => `<td>${r.attended[d] ? '1' : ''}</td>`).join('')}
          <td class="stats-total-cell">${r.count}</td>
        </tr>`).join('');
      resultBox.innerHTML = `
        <p class="help" style="margin-top:10px;">${data.start} ~ ${data.end} · 마감 완료 수업 ${data.sessionCount}개 기준${data.excludedOpenSessionCount ? ` · 아직 마감 전 ${data.excludedOpenSessionCount}개 제외` : ''}</p>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>이름</th>${dateHeaders}<th>합계</th></tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`;
      exportBtn.style.display = 'inline-block';
    }
  }catch(e){ err.textContent = e.message; resultBox.innerHTML=''; exportBtn.style.display='none'; }
});
document.getElementById('statsExportBtn').addEventListener('click', ()=>{
  if(!lastStatsRows || !lastStatsStart || !lastStatsEnd || !lastStatsSessionDates) return;
  const escCsv = (v) => `"${String(v).replace(/"/g,'""')}"`;
  const header = ['이름', ...lastStatsSessionDates.map(d=>`${d.slice(5)}(${dayLabel(d)})`), '합계'];
  const lines = [header.map(escCsv).join(',')]
    .concat(lastStatsRows.map(r => {
      const cells = [r.name, ...lastStatsSessionDates.map(d => r.attended[d] ? '1' : ''), r.count];
      return cells.map(escCsv).join(',');
    }));
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM 포함 -> 엑셀에서 한글 깨짐 방지
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `출석통계_${lastStatsStart}_${lastStatsEnd}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
document.getElementById('historyToggle').addEventListener('click', ()=>{
  showHistory = !showHistory;
  render();
});

(async function init(){
  await loadPushState();
  await refreshState();
})();
setInterval(refreshState, 15000); // 15초마다 다른 사람의 신청 현황 동기화
