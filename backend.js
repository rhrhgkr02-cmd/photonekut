/* =========================================================
   PHOTO BOOTH ✦ 저장소 연결 (backend.js)
   - config.js에 Apps Script 주소가 있으면 → 선생님 구글 드라이브에 저장 (실제 운영)
   - 주소가 없으면 → '부스 모드' : 이 기기(브라우저) 안에 저장 → 같은 기기 선생님 모드에서 인쇄
   ========================================================= */
const SCRIPT_URL = String(window.PHOTOBOOTH_CONFIG?.APPS_SCRIPT_URL || '').trim();
export const MODE = /^https:\/\/script\.google\.com\/.+\/exec$/.test(SCRIPT_URL) ? 'remote' : 'local';
export const TEST_PASSWORD = String(window.PHOTOBOOTH_CONFIG?.BOOTH_PASSWORD || '0000');
const CODE_DAYS = 3;

function fail(code) { const e = new Error(code); e.code = code; return e; }
const blobToDataURL = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });

/* ---------- 1. 실제 운영: Google Apps Script ---------- */
async function call(action, data = {}) {
  let res;
  try {
    res = await fetch(SCRIPT_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 이 형식이어야 브라우저가 바로 보낼 수 있어요
      body: JSON.stringify({ action, ...data })
    });
  } catch (e) { throw fail('NETWORK'); }
  if (!res.ok) throw fail('NETWORK');
  let j; try { j = await res.json(); } catch (e) { throw fail('SERVER'); }
  if (!j.ok) throw fail(j.error || 'SERVER');
  return j;
}
const remote = {
  checkCode: code => call('checkCode', { code }),
  upload: async ({ code, blob, layout, style }) => call('upload', { code, layout, style, image: await blobToDataURL(blob) }),
  login: pw => call('login', { password: pw }),
  createCode: pw => call('createCode', { password: pw }),
  deleteCode: (pw, code) => call('deleteCode', { password: pw, code }),
  deletePhoto: (pw, id) => call('deletePhoto', { password: pw, id }),
  async list(pw) {
    const j = await call('list', { password: pw });
    j.items.forEach(it => {
      it.thumb = `https://drive.google.com/thumbnail?id=${encodeURIComponent(it.id)}&sz=w800`;
      it.full = `https://drive.google.com/thumbnail?id=${encodeURIComponent(it.id)}&sz=w2400`;
      it.download = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(it.id)}`;
      it.open = `https://drive.google.com/file/d/${encodeURIComponent(it.id)}/view`;
    });
    return j;
  },
  setPrinted: (pw, id, printed) => call('setPrinted', { password: pw, id, printed })
};

/* ---------- 2. 부스 모드: 이 기기 안에 저장 (IndexedDB) ---------- */
const mem = { active: null, photos: new Map() };      // IndexedDB를 못 쓰는 환경용 예비 저장소
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } }
};
let dbP = null;
function openDB() {
  if (!dbP) dbP = new Promise(res => {
    try {
      const r = indexedDB.open('photobooth-test', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  return dbP;
}
const store = {
  async put(p) {
    const db = await openDB(); if (!db) { mem.photos.set(p.id, p); return; }
    await new Promise((res, rej) => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').put(p); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async del(id) {
    const db = await openDB(); if (!db) { mem.photos.delete(id); return; }
    await new Promise((res, rej) => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').delete(id); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async all() {
    const db = await openDB(); if (!db) return [...mem.photos.values()];
    return new Promise((res, rej) => { const r = db.transaction('photos').objectStore('photos').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
};
const urlCache = new Map();
/* 코드 여러 개를 3일씩 보관 (만료된 코드는 자동으로 사라짐) */
const localCodes = () => {
  const now = Date.now(), list = (ls.get('pb_test_codes') || []).filter(c => now < c.expiresAt);
  const legacy = ls.get('pb_test_active');                       // 이전 버전 호환
  if (legacy && now < legacy.expiresAt && !list.some(c => c.code === legacy.code)) list.push(legacy);
  return list.sort((a, b) => b.createdAt - a.createdAt);
};
const saveCodes = list => { ls.set('pb_test_codes', list); ls.del('pb_test_active'); };
const checkPw = pw => { if (pw !== TEST_PASSWORD) throw fail('WRONG_PASSWORD'); };
const MAX_CODES = 10;
const local = {
  async checkCode(code) { const c = localCodes().find(c => c.code === String(code)); if (!c) throw fail('BAD_CODE'); return { ok: true, expiresAt: c.expiresAt }; },
  async upload({ code, blob, layout, style }) {
    await local.checkCode(code);
    const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
    await store.put({ id, blob, created: Date.now(), code: String(code), layout, style, printed: false });
    return { ok: true, id };
  },
  async login(pw) { checkPw(pw); return { ok: true, codes: localCodes() }; },
  async createCode(pw) {
    checkPw(pw);
    const list = localCodes();
    if (list.length >= MAX_CODES) throw fail('TOO_MANY_CODES');
    let code; do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (list.some(c => c.code === code));
    const c = { code, createdAt: Date.now(), expiresAt: Date.now() + CODE_DAYS * 864e5 };
    saveCodes([c, ...list]); return { ok: true, created: c, codes: localCodes() };
  },
  async deleteCode(pw, code) { checkPw(pw); saveCodes(localCodes().filter(c => c.code !== String(code))); return { ok: true, codes: localCodes() }; },
  async list(pw) {
    checkPw(pw);
    const items = (await store.all()).sort((a, b) => b.created - a.created).map(p => {
      if (!urlCache.has(p.id)) urlCache.set(p.id, URL.createObjectURL(p.blob));
      const u = urlCache.get(p.id);
      return { id: p.id, created: p.created, code: p.code, layout: p.layout, style: p.style, printed: p.printed, thumb: u, full: u, download: u, open: u, local: true };
    });
    return { ok: true, codes: localCodes(), items };
  },
  async setPrinted(pw, id, printed) {
    checkPw(pw);
    const p = (await store.all()).find(x => x.id === id); if (!p) throw fail('NOT_FOUND');
    p.printed = !!printed; await store.put(p); return { ok: true };
  },
  async deletePhoto(pw, id) {
    checkPw(pw); await store.del(id);
    if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
    return { ok: true };
  }
};

export const backend = MODE === 'remote' ? remote : local;

/* 오류 코드를 학생/선생님이 이해할 수 있는 문장으로 */
export function errorText(err) {
  switch (err && err.code) {
    case 'BAD_CODE': return '코드가 맞지 않거나 사용 기간이 끝났어요. 선생님께 다시 확인해 주세요.';
    case 'WRONG_PASSWORD': return '비밀번호가 맞지 않아요.';
    case 'NETWORK': return '인터넷 연결을 확인해 주세요. (와이파이)';
    case 'BAD_IMAGE': return '사진 파일에 문제가 있어요. 다시 시도해 주세요.';
    case 'TOO_MANY_CODES': return '코드는 최대 10개까지 만들 수 있어요. 안 쓰는 코드를 삭제해 주세요.';
    case 'NOT_FOUND': return '이미 삭제된 사진이에요.';
    default: return '잠시 문제가 생겼어요. 다시 시도해 주세요.';
  }
}
