const DOW = ['일','월','화','수','목','금','토'];
let sessions = [];
let config = { biweeklyFridayRef: null, testMode: false, hasPin: false };
let showHistory = false;
let showCandidates = false;
let isAdmin = !!localStorage.getItem('yoga_admin_token');
let loginMode = null;
let pendingCancel = null;
let pendingDeleteSession = null; // 삭제 확인 대기 중인 세션 날짜
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
    throw new Error((data &&
