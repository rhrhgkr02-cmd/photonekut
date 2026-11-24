/* =========================================================
   PHOTO BOOTH ✦ 선생님 모드 (admin.js)
   - 비밀번호 입장 → 입장 코드(4자리, 각 3일) 만들기 · 불러오기 · 삭제
   - 학생이 보낸 사진을 6초마다 자동 새로고침해서 보여줌
   - [원본 다운로드] [바로 인쇄] [인쇄 완료 표시] [사진 삭제]
   ========================================================= */
import { backend, MODE, TEST_PASSWORD, errorText } from './backend.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LAYOUT_NAME = { strip4: '세로 4컷', postcard: '엽서형 4컷', mini3: '미니 3컷' };
const PRINT_SIZE = { strip4: ['2in', '6in'], postcard: ['4in', '6in'], mini3: ['2in', '4.73in'] };
const POLL_MS = 6000;

let ui = { show: () => {}, toast: () => {} };
let pw = null, timer = null, filter = 'all', items = [], codes = [], firstLoad = true, armed = null;
let viewCode = null;      // 불러온(보고 있는) 코드. null = 가장 최근 코드
let codeFilter = 'all';   // 'all' | '1234' : 사진 목록을 코드별로 보기
const armTimers = {};
const seen = new Set(), cards = new Map();

const sess = {
  get() { try { return sessionStorage.getItem('pb_tpw'); } catch (e) { return pw; } },
  set(v) { try { v ? sessionStorage.setItem('pb_tpw', v) : sessionStorage.removeItem('pb_tpw'); } catch (e) {} }
};

/* ---------- 입장 ---------- */
export function enterTeacherLogin() {
  const saved = sess.get();
  if (saved) { pw = saved; ui.show('teacher'); return; }
  $('#tPw').value = ''; $('#tLoginErr').textContent = '';
  $('#tLoginHint').textContent = MODE === 'local' && TEST_PASSWORD === '0000' ? '처음 비밀번호는 0000 이에요. (config.js에서 바꿀 수 있어요)' : '비밀번호를 입력하세요.';
  setTimeout(() => $('#tPw').focus(), 100);
}
async function login(e) {
  e.preventDefault();
  const btn = $('#tLoginBtn'); btn.disabled = true; $('#tLoginErr').textContent = '';
  try { await backend.login($('#tPw').value.trim()); pw = $('#tPw').value.trim(); sess.set(pw); ui.show('teacher'); }
  catch (err) { $('#tLoginErr').textContent = errorText(err); $('#tPw').select(); }
  finally { btn.disabled = false; }
}

export function enterTeacher() {
  if (!pw) pw = sess.get();
  if (!pw) { ui.show('tlogin'); return; }
  $('#tModeBadge').hidden = MODE !== 'local';
  firstLoad = true; seen.clear(); viewCode = null; codeFilter = 'all'; armed = null; syncFilterUI();
  refresh();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}
export function leaveTeacher() { clearInterval(timer); timer = null; }

function logout() { pw = null; sess.set(null); leaveTeacher(); ui.show('home'); }

/* ---------- 데이터 불러오기 ---------- */
async function refresh() {
  try {
    const j = await backend.list(pw);
    codes = j.codes || []; items = j.items;
    let fresh = 0;
    items.forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); if (!firstLoad) { it._fresh = true; fresh++; } } });
    if (fresh) { ding(); ui.toast(`새 사진 ${fresh}장이 도착했어요 ✦`); }
    firstLoad = false;
    setLive('on', 'LIVE');
    if (!armed) { renderCode(); renderGallery(); }
  } catch (err) {
    if (err.code === 'WRONG_PASSWORD') { logout(); ui.toast('비밀번호가 바뀌었어요. 다시 입장해 주세요'); return; }
    setLive('off', '연결 확인 중');
  }
}
function setLive(cls, text) { const l = $('#tLive'); l.className = 'live ' + cls; $('#tLiveText').textContent = text; }

/* ---------- 입장 코드 (여러 개, 각 3일 보관 · 불러오기 · 삭제) ---------- */
function remainText(ms) {
  if (ms <= 0) return '만료됨';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return d ? `${d}일 ${h}시간 남음` : h ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}
const endText = t => new Date(t).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shownCode = () => codes.find(c => c.code === viewCode) || codes[0] || null;
const photoCount = code => items.filter(it => it.code === code).length;

/* 두 번 눌러야 실행 (실수 방지) */
function armed2(key, label, el) {
  if (armed === key) { armed = null; return true; }
  armed = key; el.textContent = label; el.classList.add('armed');
  clearTimeout(armTimers.t); armTimers.t = setTimeout(() => { if (armed === key) { armed = null; renderCode(); renderGallery(); } }, 3500);
  return false;
}

function renderCode() {
  const c = shownCode();
  $('#tCode').textContent = c ? c.code : '----';
  $('#tCode').classList.toggle('off', !c);
  $('#tCodeMeta').textContent = c ? `${remainText(c.expiresAt - Date.now())} · ${endText(c.expiresAt)}까지 · 사진 ${photoCount(c.code)}장`
    : '사용 중인 코드가 없어요. [새 코드 만들기]를 눌러 학생들에게 알려주세요.';
  $('#tCodeTag').textContent = c && codes.length > 1 ? (c === codes[0] ? '최근 코드' : '불러온 코드') : '';
  const list = $('#tCodeList');
  list.innerHTML = '';
  list.hidden = codes.length === 0;
  codes.forEach(code => {
    const row = document.createElement('div');
    const on = c && c.code === code.code;
    row.className = 'code-row' + (on ? ' on' : '');
    row.innerHTML = `<b class="cr-code"></b><span class="cr-meta"></span>
      <button class="btn btn-ghost cr-load" type="button"></button>
      <button class="btn btn-ghost cr-del" type="button">삭제</button>`;
    row.querySelector('.cr-code').textContent = code.code;
    row.querySelector('.cr-meta').textContent = `${remainText(code.expiresAt - Date.now())} · 사진 ${photoCount(code.code)}장`;
    const load = row.querySelector('.cr-load');
    load.textContent = on ? '보는 중' : '불러오기'; load.disabled = on;
    load.addEventListener('click', () => { viewCode = code.code; codeFilter = code.code; syncFilterUI(); renderCode(); renderGallery(); });
    const del = row.querySelector('.cr-del');
    del.addEventListener('click', () => deleteCode(code.code, del));
    list.appendChild(row);
  });
  $('#tCodeListHead').hidden = codes.length === 0;
}
async function newCode() {
  try {
    const j = await backend.createCode(pw);
    codes = j.codes; viewCode = j.created.code;
    ui.toast(`새 입장 코드: ${j.created.code} (3일 동안 사용 가능)`);
  } catch (err) { ui.toast(errorText(err)); }
  renderCode();
}
async function deleteCode(code, btn) {
  if (!armed2('code:' + code, '정말 삭제?', btn)) return;
  try {
    const j = await backend.deleteCode(pw, code);
    codes = j.codes;
    if (viewCode === code) viewCode = null;
    if (codeFilter === code) { codeFilter = 'all'; syncFilterUI(); }
    ui.toast(`코드 ${code}를 삭제했어요. 이 코드로는 더 이상 보낼 수 없어요 (사진은 그대로 남아요)`);
  } catch (err) { ui.toast(errorText(err)); }
  renderCode(); renderGallery();
}
function syncFilterUI() {
  $('#tCodeFilter').textContent = codeFilter === 'all' ? '모든 코드의 사진' : `코드 ${codeFilter} 사진만`;
  $('#tShowAll').hidden = codeFilter === 'all';
}

/* ---------- 사진 목록 ---------- */
const fmtTime = t => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function makeCard(it) {
  const card = document.createElement('article');
  card.className = 'card photo-card';
  card.innerHTML = `
    <div class="photo-box"><img alt="" loading="lazy" /><a class="img-fallback" target="_blank" rel="noopener" hidden>미리보기를 불러올 수 없어요<br><b>드라이브에서 열기 ↗</b></a>
      <span class="new-tag" hidden>NEW</span><span class="printed-tag" hidden>인쇄 완료</span></div>
    <div class="photo-info"><span><b class="no"></b> · <span class="lay"></span></span><span class="time"></span></div>
    <div class="photo-actions">
      <button class="btn btn-primary" data-act="download" type="button">⬇ 원본 다운로드</button>
      <button class="btn btn-ghost" data-act="print" type="button">🖨 바로 인쇄</button>
      <button class="btn btn-ghost" data-act="toggle" type="button"></button>
      <button class="btn btn-ghost btn-del" data-act="delete" type="button">🗑 삭제</button>
    </div>`;
  const img = card.querySelector('img'), fb = card.querySelector('.img-fallback');
  img.addEventListener('error', () => { img.hidden = true; fb.hidden = false; });
  img.src = it.thumb; fb.href = it.open;
  card.querySelector('[data-act="download"]').addEventListener('click', () => download(card._it));
  card.querySelector('[data-act="print"]').addEventListener('click', () => printPhoto(card._it));
  card.querySelector('[data-act="toggle"]').addEventListener('click', () => togglePrinted(card._it));
  card.querySelector('[data-act="delete"]').addEventListener('click', e => deletePhoto(card._it, e.currentTarget));
  return card;
}
function renderGallery() {
  const scope = codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter);
  const all = scope.length, done = scope.filter(d => d.printed).length;
  $('#statAll').textContent = all; $('#statDone').textContent = done; $('#statWait').textContent = all - done;
  const byCode = codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter);
  const list = byCode.filter(d => filter === 'all' || (filter === 'done' ? d.printed : !d.printed));
  const g = $('#gallery'), keep = new Set();
  list.forEach(it => {
    let card = cards.get(it.id);
    if (!card) { card = makeCard(it); cards.set(it.id, card); }
    card._it = it; keep.add(it.id);
    const no = items.length - items.indexOf(it);
    card.querySelector('.no').textContent = '#' + String(no).padStart(3, '0');
    card.querySelector('.lay').textContent = `${LAYOUT_NAME[it.layout] || '사진'} · 코드 ${it.code || '-'}`;
    const del = card.querySelector('[data-act="delete"]');
    if (armed !== 'photo:' + it.id) { del.textContent = '🗑 삭제'; del.classList.remove('armed'); }
    card.querySelector('.time').textContent = fmtTime(it.created);
    card.querySelector('.printed-tag').hidden = !it.printed;
    card.querySelector('[data-act="toggle"]').textContent = it.printed ? '↺ 대기로' : '✓ 인쇄 완료';
    card.classList.toggle('is-printed', !!it.printed);
    if (it._fresh) { card.querySelector('.new-tag').hidden = false; card.classList.remove('fresh'); void card.offsetWidth; card.classList.add('fresh'); delete it._fresh; }
    g.appendChild(card);                               // 순서 맞추기 (이미 있는 카드는 이동만 → 깜빡임 없음)
  });
  cards.forEach((c, id) => { if (!keep.has(id)) c.remove(); });
  $('#empty').hidden = list.length > 0;
}

/* ---------- 다운로드 / 인쇄 / 인쇄 완료 ---------- */
function download(it) {
  const no = items.length - items.indexOf(it);
  const a = document.createElement('a');
  a.href = it.download;
  if (it.local) a.download = `photobooth_${String(no).padStart(3, '0')}.png`; else { a.target = '_blank'; a.rel = 'noopener'; }
  document.body.appendChild(a); a.click(); a.remove();
}
function printPhoto(it) {
  const [w, h] = PRINT_SIZE[it.layout] || ['4in', '6in'];
  const win = window.open('', '_blank');
  if (!win) { ui.toast('팝업이 차단되었어요. 주소창에서 팝업을 허용해 주세요'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>인쇄</title><style>
    @page { size: ${w} ${h}; margin: 0; } html,body { margin:0; height:100%; }
    body { display:flex; align-items:center; justify-content:center; } img { width:${w}; height:${h}; object-fit:contain; }
    </style></head><body><img src="${it.full}" onload="setTimeout(function(){window.print();},300)"></body></html>`);
  win.document.close();
}
async function togglePrinted(it) {
  const next = !it.printed; it.printed = next; renderGallery();          // 화면 먼저 바꾸고
  try { await backend.setPrinted(pw, it.id, next); }                     // 저장
  catch (err) { it.printed = !next; renderGallery(); ui.toast(errorText(err)); }
}

async function deletePhoto(it, btn) {
  if (!armed2('photo:' + it.id, '정말 삭제?', btn)) return;
  const idx = items.indexOf(it);
  items = items.filter(x => x !== it); renderGallery(); renderCode();            // 화면에서 먼저 지우고
  try { await backend.deletePhoto(pw, it.id); ui.toast(MODE === 'remote' ? '사진을 삭제했어요 (드라이브 휴지통에서 30일 안에 복구 가능)' : '사진을 삭제했어요'); }
  catch (err) { items.splice(idx, 0, it); renderGallery(); renderCode(); ui.toast(errorText(err)); }
}

/* ---------- 새 사진 알림음 ---------- */
let ac;
function ding() {
  if (!$('#soundOn').checked) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    [880, 1318].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * .12;
      o.frequency.value = f; g.gain.setValueAtTime(.12, t); g.gain.exponentialRampToValueAtTime(.0001, t + .25);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + .3);
    });
  } catch (e) {}
}

/* ---------- 연결 ---------- */
export function initTeacher(api) {
  ui = api;
  $('#tLoginForm').addEventListener('submit', login);
  $('#tLoginBack').addEventListener('click', () => ui.show('home'));
  $('#tLogout').addEventListener('click', logout);
  $('#tNewCode').addEventListener('click', newCode);
  $('#tShowAll').addEventListener('click', () => { codeFilter = 'all'; syncFilterUI(); renderGallery(); });
  $('#tRefresh').addEventListener('click', refresh);
  $$('#tTabs button').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter; $$('#tTabs button').forEach(x => x.classList.toggle('on', x === b)); renderGallery();
  }));
  setInterval(() => { if (codes.length && document.body.dataset.screen === 'teacher' && !armed) renderCode(); }, 30000);
}
