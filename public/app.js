const DOW = ['일','월','화','수','목','금','토'];
let sessions = [];
let config = { biweeklyFridayRef: null, testMode: false, hasPin: false };
let showHistory = false;
let showCandidates = false;
let isAdmin = !!localStorage.getItem('yoga_admin_token');
let loginMode = null;
let pendingCancel = null;
let candidates = [];
let connError = null;

function token(){ return localStorage.getItem('yoga_admin_token'); }
function authHeaders(){
  const t = token();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
async function api(path, opts = {}){
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
    if(res.status === 401){ isAdmin = false; localStorage.removeItem('yoga_admin_token'); }
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
function openTime(dateStr){ const d=parseLocal(dateStr); d.setHours(9,0,0,0); return d; }
function isLocked(dateStr){
  if(config.testMode) return false;
  return new Date() < openTime(dateStr);
}
function escapeHtml(str){
  return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function refreshState(){
  try{
    const data = await api('/state');
    sessions = data.sessions;
    config = data.config;
    connError = null;
  }catch(e){
    connError = '서버에 연결할 수 없어요. 네트워크 상태를 확인해주세요.';
  }
  render();
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

async function join(dateStr, inputEl, errEl){
  const name = inputEl.value.trim();
  errEl.textContent = '';
  if(!name){ errEl.textContent = '이름을 입력해주세요.'; return; }
  try{
    await api(`/sessions/${dateStr}/join`, { method:'POST', body: JSON.stringify({ name }) });
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
  }catch(e){ /* 조용히 무시, 다음 refresh에서 상태 재동기화 */ }
  pendingCancel = null;
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

function renderAdminUI(){
  document.getElementById('adminActions').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('adminLoginBtn').style.display = isAdmin ? 'none' : 'inline-block';
  document.getElementById('adminLogoutBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('adminStatus').textContent = isAdmin ? '관리자 모드' : '일반 회원 모드';
  if(!isAdmin){
    document.getElementById('settingsPanel').style.display = 'none';
    document.getElementById('candidatesBox').innerHTML = '';
  }
  renderLoginBox();
}

function renderTestBanner(){
  document.getElementById('testBannerBox').innerHTML = config.testMode
    ? `<div class="test-banner">🧪 테스트 모드 켜짐 — 9시 잠금이 해제되어 있어요. 실제 운영 전에 꺼주세요.</div>`
    : '';
}

function renderConnError(){
  document.getElementById('connErrorBox').innerHTML = connError
    ? `<div class="conn-error">${connError}</div>` : '';
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
  const locked = isLocked(s.date);
  const full = s.signups.length >= 14;
  let statusLabel, statusClass;
  if(locked){ statusLabel = '오전 9시부터 신청 오픈'; statusClass='locked'; }
  else if(full){ statusLabel = '정원 마감 · 대기 접수 중'; statusClass='full'; }
  else { statusLabel = `신청 가능 · ${14-s.signups.length}자리 남음`; statusClass='open'; }

  const matsHtml = Array.from({length:14}).map((_,i)=>
    `<div class="mat ${i < s.signups.length ? 'filled' : ''}"></div>`
  ).join('');

  const rowHtml = (n, idx, fromWaitlist) => {
    const isPending = pendingCancel && pendingCancel.date===s.date && pendingCancel.name===n && pendingCancel.fromWaitlist===fromWaitlist;
    const actions = isPending
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
  const joinBtnLabel = full ? '대기 신청' : '신청하기';

  return `
  <div class="card" data-session="${s.date}">
    <div class="session-head">
      <div><span class="session-date">${s.date}</span><span class="session-day">${dayLabel(s.date)}요일</span></div>
      <div class="status ${statusClass}">${statusLabel}</div>
    </div>
    <div class="mats">${matsHtml}</div>
    <div class="list-label">신청 (${s.signups.length}/14)</div>
    ${signupsHtml}
    ${s.waitlist.length ? `<div class="list-label">대기</div>${waitHtml}` : ''}
    ${locked
      ? `<div class="locked-msg">이 수업은 ${s.date} 오전 9시부터 신청할 수 있어요.</div>`
      : `<div class="join-row">
          <input type="text" placeholder="이름을 입력하세요" data-input="${s.date}">
          <button class="${full ? 'waitlist' : ''}" data-join="${s.date}">${joinBtnLabel}</button>
        </div>
        <p class="field-error" data-err="${s.date}"></p>`
    }
  </div>`;
}

function render(){
  renderConnError();
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

  listEl.querySelectorAll('[data-join]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const date = btn.dataset.join;
      const input = listEl.querySelector(`[data-input="${date}"]`);
      const err = listEl.querySelector(`[data-err="${date}"]`);
      join(date, input, err);
    });
  });
  listEl.querySelectorAll('[data-input]').forEach(inp=>{
    inp.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){
        const date = inp.dataset.input;
        const err = listEl.querySelector(`[data-err="${date}"]`);
        join(date, inp, err);
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

  document.getElementById('refDate').value = config.biweeklyFridayRef || '';
  document.getElementById('testModeToggle').checked = !!config.testMode;
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
  render();
});
document.getElementById('showCandidatesBtn').addEventListener('click', async ()=>{
  if(!isAdmin) return;
  showCandidates = !showCandidates;
  await loadCandidatesIfNeeded();
  render();
});
document.getElementById('toggleSettingsBtn').addEventListener('click', ()=>{
  if(!isAdmin) return;
  const panel = document.getElementById('settingsPanel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
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
document.getElementById('historyToggle').addEventListener('click', ()=>{
  showHistory = !showHistory;
  render();
});

refreshState();
setInterval(refreshState, 15000); // 15초마다 다른 사람의 신청 현황 동기화
