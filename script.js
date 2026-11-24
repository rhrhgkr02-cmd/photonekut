/* =========================================================
   PHOTO BOOTH ✦ 학생용 스크립트 (script.js)
   ---------------------------------------------------------
   흐름: HOME(학생/선생님 선택) → 입장 코드 → 1 프레임 → 2 촬영(8장) → 3 확인/비교 → 4 고르기
         → 5 보정 → 6 꾸미기 → 7 전송
   * 미리보기와 최종 PNG는 '같은 Canvas 렌더러(renderFrame)'로 그립니다.
     그래서 화면에서 본 모습 = 인쇄되는 모습 입니다.
   ========================================================= */

/* ---------- 0. 기본 설정 ---------- */
import { backend, MODE, errorText } from './backend.js';
import { initTeacher, enterTeacherLogin, enterTeacher, leaveTeacher } from './admin.js';
const SHOTS_PER_SET = 8;     // 한 세트 촬영 장수
const COUNTDOWN_SEC = 8;     // 컷마다 카운트다운(초)
const EXPORT_SCALE = 1;      // 최종 PNG 배율 (1 = 300dpi 인쇄 품질. 2로 올리면 더 선명하지만 전송이 느려짐)
const MAX_CAPTURE_SIDE = 1920;

/* ---------- 1. 레이아웃 정의 (단위: 300dpi 기준 px) ----------
   slots 배열의 순서 = 학생이 클릭한 순서가 들어가는 순서
   2x2: [왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래] / 세로형: 위→아래  */
function buildStrip(id, name, sub, cuts) {
  const W = 600, side = 44, top = 60, pw = 512, ph = 360, gap = 20, capH = 240;
  const slots = [];
  for (let i = 0; i < cuts; i++) slots.push({ x: side, y: top + i * (ph + gap), w: pw, h: ph });
  const last = slots[cuts - 1];
  const capY = last.y + last.h;
  return { id, name, sub, cuts, kind: 'strip', w: W, h: capY + capH, side, gap, slots,
    header: null, caption: { x: 0, y: capY, w: W, h: capH } };
}
function buildPostcard() {
  const W = 1200, H = 1800, side = 56, gap = 28, top = 190, pw = 530, ph = 690;
  const slots = [
    { x: side, y: top, w: pw, h: ph },                         // 1 왼쪽 위
    { x: side + pw + gap, y: top, w: pw, h: ph },              // 2 오른쪽 위
    { x: side, y: top + ph + gap, w: pw, h: ph },              // 3 왼쪽 아래
    { x: side + pw + gap, y: top + ph + gap, w: pw, h: ph }    // 4 오른쪽 아래
  ];
  const capY = top + ph * 2 + gap;
  return { id: 'postcard', name: '엽서형 4컷', sub: '4×6 inch · 2×2 그리드', cuts: 4, kind: 'grid',
    w: W, h: H, side, gap, slots, header: { x: 0, y: 0, w: W, h: top }, caption: { x: 0, y: capY, w: W, h: H - capY } };
}
const LAYOUTS = {
  strip4: buildStrip('strip4', '세로 4컷', '2×6 inch · 클래식 스트립', 4),
  postcard: buildPostcard(),
  mini3: buildStrip('mini3', '미니 3컷', '2×4.7 inch · 컴팩트', 3)
};

/* ---------- 2. 꾸미기 옵션 ---------- */
const COLORS = [
  { name: '화이트', hex: '#FFFFFF' }, { name: '블랙', hex: '#1E1E22' },
  { name: '파스텔 핑크', hex: '#F8D3E0' }, { name: '스카이블루', hex: '#CFE8F8' },
  { name: '크림 옐로우', hex: '#FBF1CF' }, { name: '라벤더', hex: '#E3DAF5' },
  { name: '민트', hex: '#D5F0E3' }, { name: '실버', hex: '#E4E5EA' },
  { name: '빈티지 페이퍼', hex: '#E9DCC0' }, { name: '차콜', hex: '#3A3A42' }
];
const FONTS = [
  { id: 'Nanum Pen Script', label: '손글씨', weight: 400, scale: 1.35 },
  { id: 'Jua', label: '둥근체', weight: 400, scale: 1.0 },
  { id: 'Gothic A1', label: '고딕', weight: 700, scale: 0.95 },
  { id: 'Nanum Myeongjo', label: '명조', weight: 700, scale: 0.95 },
  { id: 'Gaegu', label: '말랑체', weight: 700, scale: 1.15 }
];
const fontById = id => FONTS.find(f => f.id === id) || FONTS[1];

/* ---------- 3. 상태 (State) ----------
   ⚠️ 모든 사진 데이터는 여기에만 존재합니다. resetAll()로 완전히 비웁니다. */
const DEFAULT_ADJUST = () => ({ soft: false, mono: false, brightness: 0, saturation: 0, contrast: 0 });
const DEFAULT_DECO = () => ({ style: 'classic', color: '#FFFFFF', text: '', font: 'Jua' });
const MAX_STICKERS = 20;
const state = {
  screen: 'home',
  layoutId: null,
  setA: null,          // 첫 촬영 8장
  setB: null,          // 다시 찍은 8장
  retakeUsed: false,   // 다시 찍기 1회 사용 여부
  shootingFor: 'A',    // 지금 촬영 중인 세트
  compareChoice: null, // 비교 화면에서 고른 세트 'A' | 'B'
  confirmed: null,     // 최종 확정된 8장
  selection: [],       // 고른 사진 인덱스 (클릭 순서 = 슬롯 순서)
  adjust: DEFAULT_ADJUST(),
  deco: DEFAULT_DECO(),
  stickers: [],        // [{ id, type, x, y, size, rot }] (프레임 좌표)
  finalBlob: null, finalUrl: null,
  sending: false, sent: false
};
const layout = () => LAYOUTS[state.layoutId] || LAYOUTS.strip4;

/* 입장 코드: 이 기기에 기억 (코드 만료 시각까지) */
const codeStore = {
  get() { try { const c = JSON.parse(localStorage.getItem('pb_code')); return c && Date.now() < c.expiresAt ? c : null; } catch (e) { return codeStore._m && Date.now() < codeStore._m.expiresAt ? codeStore._m : null; } },
  set(c) { codeStore._m = c; try { localStorage.setItem('pb_code', JSON.stringify(c)); } catch (e) {} },
  clear() { codeStore._m = null; try { localStorage.removeItem('pb_code'); } catch (e) {} }
};

/* ---------- 4. 작은 도우미들 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v);
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
  return .2126 * r + .7152 * g + .0722 * b;
}
function shade(hex, amt) { // amt: -1(어둡게) ~ 1(밝게)
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; }
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* 폰트 로딩 (한글 웹폰트는 글자 단위로 나뉘어 있어 '쓸 글자'까지 함께 요청) */
async function ensureFont(family, weight = 400, text = '') {
  try { await document.fonts.load(`${weight} 40px "${family}"`, text || 'Aa가나✦'); } catch (e) { /* 무시 */ }
}
const BASE_FONTS_READY = Promise.all([
  ensureFont('Unbounded', 700, 'PHOTOBOOTH'), ensureFont('Space Mono', 400, '0123456789.✦ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  ensureFont('Space Mono', 700, '0123456789'), ensureFont('Press Start 2P', 400, 'PHOTOBOOTH♥'),
  ensureFont('Nanum Myeongjo', 700, 'PHOTOBOOTHAlwayslikethefirsttime')
]);

/* ---------- 5. 사운드 (파일 없이 WebAudio로 생성) ---------- */
let audioCtx = null;
function initAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) { audioCtx = null; }
}
function beep(freq = 880, dur = 0.08, vol = 0.15) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
  o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur + .02);
}
function shutterSound() {
  if (!audioCtx) return;
  const make = (delay, len, vol) => {
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * len), audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = audioCtx.createGain(); g.gain.value = vol;
    src.connect(hp).connect(g).connect(audioCtx.destination);
    src.start(audioCtx.currentTime + delay);
  };
  make(0, 0.05, 0.9); make(0.07, 0.09, 0.6); // "찰-칵"
}

/* ---------- 6. 샘플 사진 (카메라가 없을 때 체험용 & 썸네일용) ---------- */
const SAMPLE_TONES = [['#F9D5E3', '#F4A9C8'], ['#D7ECFA', '#A9D9F5'], ['#FBF1CF', '#F5D98B'], ['#E3DAF5', '#C3B3EA'],
  ['#D5F0E3', '#9ED9BD'], ['#F7F7F7', '#D6D7DD'], ['#FCE1D4', '#F5B79A'], ['#DDE3F7', '#A9B6EA']];
function makeSample(i, w = 960, h = 720, label = '') {
  const c = mkCanvas(w, h), x = c.getContext('2d');
  const [a, b] = SAMPLE_TONES[i % SAMPLE_TONES.length];
  const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, a); g.addColorStop(1, b);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const cx = w * (0.5 + ((i % 3) - 1) * 0.08), u = Math.min(w, h);
  x.fillStyle = 'rgba(255,255,255,.88)';
  x.beginPath(); x.ellipse(cx, h * 1.02, u * .36, u * .34, 0, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.arc(cx, h * .46, u * .17, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(39,39,45,.55)';
  x.beginPath(); x.arc(cx - u * .055, h * .45, u * .014, 0, Math.PI * 2); x.arc(cx + u * .055, h * .45, u * .014, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(39,39,45,.5)'; x.lineWidth = u * .012; x.lineCap = 'round';
  x.beginPath(); x.arc(cx, h * .48, u * .045, .15 * Math.PI, .85 * Math.PI); x.stroke();
  drawSparkle(x, w * .82, h * .2, u * .07, 'rgba(255,255,255,.9)');
  drawSparkle(x, w * .16, h * .3, u * .04, 'rgba(255,255,255,.75)');
  if (label) { x.fillStyle = 'rgba(39,39,45,.55)'; x.font = `700 ${Math.round(u * .05)}px "Space Mono", monospace`; x.fillText(label, u * .05, h - u * .06); }
  return c;
}
let SAMPLES = null;
const samples = () => (SAMPLES ||= Array.from({ length: 8 }, (_, i) => makeSample(i, 640, 480)));

/* ---------- 7. 그래픽 요소 (하트, 별, 픽셀 하트, 구름) ---------- */
function drawHeart(x, cx, cy, s, color) {
  x.save(); x.translate(cx, cy); x.scale(s / 32, s / 32); x.fillStyle = color;
  x.beginPath(); x.moveTo(0, 10);
  x.bezierCurveTo(-2, 6, -16, 0, -16, -8); x.bezierCurveTo(-16, -15, -8, -18, 0, -10);
  x.bezierCurveTo(8, -18, 16, -15, 16, -8); x.bezierCurveTo(16, 0, 2, 6, 0, 10);
  x.closePath(); x.fill(); x.restore();
}
function drawSparkle(x, cx, cy, s, color) {
  const r = s / 2, k = r * 0.22;
  x.save(); x.fillStyle = color; x.beginPath();
  x.moveTo(cx, cy - r); x.quadraticCurveTo(cx + k, cy - k, cx + r, cy); x.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
  x.quadraticCurveTo(cx - k, cy + k, cx - r, cy); x.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
  x.closePath(); x.fill(); x.restore();
}
const PIXEL_HEART = ['.XX.XX.', 'XHXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function drawPixelHeart(x, cx, cy, s, color, hi) {
  const cell = s / 7, ox = cx - s / 2, oy = cy - (cell * 6) / 2;
  PIXEL_HEART.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    x.fillStyle = ch === 'H' ? hi : color;
    x.fillRect(Math.floor(ox + c * cell), Math.floor(oy + r * cell), Math.ceil(cell), Math.ceil(cell));
  }));
}
function drawCloud(x, cx, cy, s, color) {
  x.save(); x.fillStyle = color; x.beginPath();
  x.arc(cx - s * .22, cy + s * .05, s * .2, 0, Math.PI * 2); x.arc(cx, cy - s * .06, s * .26, 0, Math.PI * 2);
  x.arc(cx + s * .24, cy + s * .06, s * .18, 0, Math.PI * 2); x.rect(cx - s * .22, cy + s * .02, s * .46, s * .2);
  x.fill(); x.restore();
}
function roundRectPath(x, rx, ry, w, h, r) {
  r = Math.min(r, w / 2, h / 2); x.beginPath();
  x.moveTo(rx + r, ry); x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
  x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
}
function spacedText(x, text, cx, y, spacing, align = 'center') {
  const chars = [...text]; const widths = chars.map(c => x.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let px = align === 'center' ? cx - total / 2 : align === 'right' ? cx - total : cx;
  const prev = x.textAlign; x.textAlign = 'left';
  chars.forEach((c, i) => { x.fillText(c, px, y); px += widths[i] + spacing; });
  x.textAlign = prev; return total;
}

/* 장식이 들어갈 '여백 좌표' (사진 영역을 절대 침범하지 않도록 계산) */
function decorPoints(L) {
  const P = [];
  if (L.kind === 'strip') {
    const m = L.side / 2, s = 30;
    P.push({ x: L.w * .2, y: 30, s: 32 }, { x: L.w * .8, y: 30, s: 32 });
    L.slots.forEach((sl, i) => {
      P.push({ x: i % 2 ? L.w - m : m, y: sl.y + sl.h * .5, s });
      if (i < L.slots.length - 1) P.push({ x: i % 2 ? m : L.w - m, y: sl.y + sl.h + L.gap / 2, s });
    });
    const c = L.caption;
    P.push({ x: 64, y: c.y + 52, s: 40 }, { x: L.w - 64, y: c.y + c.h - 62, s: 40 });
  } else {
    const m = L.side / 2, s = 40, sl = L.slots;
    P.push({ x: 110, y: 96, s: 62 }, { x: L.w - 110, y: 96, s: 62 });
    P.push({ x: m, y: sl[0].y + sl[0].h * .3, s }, { x: L.w - m, y: sl[1].y + sl[1].h * .75, s });
    P.push({ x: m, y: sl[2].y + sl[2].h * .7, s }, { x: L.w - m, y: sl[3].y + sl[3].h * .25, s });
    P.push({ x: L.w / 2, y: sl[0].y + sl[0].h + L.gap / 2, s: 22 });
    const c = L.caption;
    P.push({ x: 110, y: c.y + c.h * .45, s: 56 }, { x: L.w - 110, y: c.y + c.h * .45, s: 56 });
  }
  return P;
}

/* ---------- 8. 프레임 스타일 6종 ----------
   under(): 사진 아래에 그리는 배경 / over(): 사진 위(여백)에 그리는 장식 */
const STYLES = {
  classic: {
    name: '클래식 화이트', color: '#FFFFFF', radius: 0,
    brand: 'PHOTO BOOTH', brandFont: 'Nanum Myeongjo', brandWeight: 700, tagline: 'ALWAYS LIKE THE FIRST TIME',
    under(x, L, C) { x.fillStyle = C.bg; x.fillRect(0, 0, L.w, L.h); },
    over(x, L, C) {
      const c = L.caption; x.strokeStyle = C.line; x.lineWidth = 2;
      const y = c.y + c.h * .78;
      x.beginPath(); x.moveTo(L.w * .08, y - 6); x.lineTo(L.w * .2, y - 6); x.moveTo(L.w * .8, y - 6); x.lineTo(L.w * .92, y - 6); x.stroke();
      drawHeart(x, L.w * .07, y - 6, 14, C.accent); drawHeart(x, L.w * .93, y - 6, 14, C.accent);
    },
    accent: '#E7A3BC'
  },
  pink: {
    name: '러블리 핑크', color: '#F8D3E0', radius: 22,
    brand: 'LOVELY DAY', brandFont: 'Unbounded', brandWeight: 700, tagline: 'PHOTO BOOTH ♥ SCHOOL DAY',
    under(x, L, C) { x.fillStyle = C.bg; x.fillRect(0, 0, L.w, L.h); },
    over(x, L, C) {
      decorPoints(L).forEach((p, i) => drawHeart(x, p.x, p.y, p.s * (i % 3 === 0 ? 1 : .8), i % 2 ? '#FFFFFF' : C.accent));
    },
    accent: '#EE7FA8'
  },
  sky: {
    name: '스카이블루', color: '#CFE8F8', radius: 22,
    brand: 'BLUE MOMENT', brandFont: 'Unbounded', brandWeight: 700, tagline: 'PHOTO BOOTH ✦ CLEAR SKY',
    under(x, L, C) { x.fillStyle = C.bg; x.fillRect(0, 0, L.w, L.h); },
    over(x, L, C) {
      decorPoints(L).forEach((p, i) => (i % 3 === 1 ? drawCloud(x, p.x, p.y, p.s * .95, '#FFFFFF') : drawSparkle(x, p.x, p.y, p.s, i % 2 ? '#FFFFFF' : C.accent)));
    },
    accent: '#5DB5EA'
  },
  vintage: {
    name: '빈티지 필름', color: '#E9DCC0', radius: 0,
    brand: 'PHOTO BOOTH FILM', brandFont: 'Space Mono', brandWeight: 700, tagline: 'SAFETY FILM 5063',
    under(x, L, C) {
      x.fillStyle = C.bg; x.fillRect(0, 0, L.w, L.h);
      const rnd = mulberry32(5063), n = Math.round(L.w * L.h / 2600);
      for (let i = 0; i < n; i++) { x.fillStyle = `rgba(110,80,40,${.05 + rnd() * .16})`; const r = .6 + rnd() * 1.8; x.beginPath(); x.arc(rnd() * L.w, rnd() * L.h, r, 0, Math.PI * 2); x.fill(); }
      for (let i = 0; i < 6; i++) { const g = x.createRadialGradient(0, 0, 0, 0, 0, 1); x.save(); x.translate(rnd() * L.w, rnd() * L.h); x.scale(60 + rnd() * 120, 60 + rnd() * 120); g.addColorStop(0, 'rgba(160,120,60,.10)'); g.addColorStop(1, 'rgba(160,120,60,0)'); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.fill(); x.restore(); }
      const v = x.createRadialGradient(L.w / 2, L.h / 2, Math.min(L.w, L.h) * .35, L.w / 2, L.h / 2, Math.max(L.w, L.h) * .75);
      v.addColorStop(0, 'rgba(90,60,20,0)'); v.addColorStop(1, 'rgba(90,60,20,.22)'); x.fillStyle = v; x.fillRect(0, 0, L.w, L.h);
      // 사진 뒤 검은 필름 띠
      const s = L.slots, pad = L.side - 16;
      const x0 = Math.min(...s.map(a => a.x)) - pad, x1 = Math.max(...s.map(a => a.x + a.w)) + (L.kind === 'grid' ? pad : 12);
      const y0 = s[0].y - 14, y1 = Math.max(...s.map(a => a.y + a.h)) + 14;
      x.fillStyle = '#17130F'; x.fillRect(x0, y0, x1 - x0, y1 - y0);
    },
    over(x, L, C) {
      const s = L.slots, pad = L.side - 16, bandX = Math.min(...s.map(a => a.x)) - pad;
      x.save(); x.fillStyle = '#E8D7B0'; x.font = `700 15px "Space Mono", monospace`;
      s.forEach((sl, i) => {
        if (L.kind === 'grid' && i % 2 === 1) return;
        x.save(); x.translate(bandX + pad / 2 + 5, sl.y + sl.h / 2); x.rotate(-Math.PI / 2);
        x.textAlign = 'center'; x.fillText(i % 2 === 0 ? 'PHOTO BOOTH SAFETY FILM 5063' : String(i + 1), 0, 0); x.restore();
      });
      x.restore();
      x.save(); x.fillStyle = C.soft; x.font = `700 24px "Space Mono", monospace`;
      const c = L.caption; x.translate(L.w - 30, c.y + c.h * .5); x.rotate(-Math.PI / 2); x.textAlign = 'center';
      const d = new Date(); x.fillText(`${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]} ${d.getFullYear()}`, 0, 0); x.restore();
    },
    accent: '#8A5A2B'
  },
  y2k: {
    name: 'Y2K 실버', color: '#E4E5EA', radius: 30,
    brand: 'PHOTO✦BOOTH', brandFont: 'Unbounded', brandWeight: 700, tagline: 'KEEP SMILING ✦ Y2K EDITION',
    under(x, L, C) {
      const g = x.createLinearGradient(0, 0, L.w, L.h);
      g.addColorStop(0, shade(C.bg, .45)); g.addColorStop(.5, C.bg); g.addColorStop(1, shade(C.bg, -.08));
      x.fillStyle = g; x.fillRect(0, 0, L.w, L.h);
      L.slots.forEach(s => { x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 4; roundRectPath(x, s.x - 5, s.y - 5, s.w + 10, s.h + 10, 34); x.stroke(); });
    },
    over(x, L, C) {
      decorPoints(L).filter(p => !(p.x > L.w - L.side && p.y > L.slots[0].y && p.y < L.caption.y)) // 오른쪽 세로 문구 자리는 비움
        .forEach((p, i) => drawSparkle(x, p.x, p.y, p.s * (i % 2 ? .75 : 1.05), i % 2 ? '#FFFFFF' : C.ink));
      x.save(); x.fillStyle = C.soft; x.font = `700 13px "Space Mono", monospace`;
      const sl = L.slots; x.translate(L.w - L.side / 2 + 5, sl[0].y + (sl[sl.length - 1].y + sl[sl.length - 1].h - sl[0].y) / 2);
      x.rotate(Math.PI / 2); spacedText(x, 'KEEP YOURSELF SMILING  ✦  PHOTO BOOTH', 0, 0, 3); x.restore();
    },
    accent: '#9AA0AE'
  },
  pixel: {
    name: '레트로 픽셀', color: '#F7C9D6', radius: 0,
    brand: 'PHOTO BOOTH', brandFont: 'Press Start 2P', brandWeight: 400, tagline: 'PRESS ♥ TO SMILE',
    under(x, L, C) {
      x.fillStyle = C.bg; x.fillRect(0, 0, L.w, L.h);
      x.fillStyle = 'rgba(255,255,255,.95)';
      L.slots.forEach(s => x.fillRect(s.x - 8, s.y - 8, s.w + 16, s.h + 16)); // 도트 감성 흰 테두리
    },
    over(x, L, C) {
      decorPoints(L).forEach((p, i) => drawPixelHeart(x, p.x, p.y, Math.min(p.s, 36) * (i % 3 === 0 ? 1.15 : .9), '#E8574F', '#FFB3AE'));
    },
    accent: '#E8574F'
  }
};

/* ---------- 9. 사진 보정 처리 (모든 브라우저에서 동일하게 작동하는 픽셀 연산) ---------- */
function drawCover(x, img, w, h) {
  const iw = img.width, ih = img.height, r = Math.max(w / iw, h / ih), sw = w / r, sh = h / r;
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
}
function processPhoto(src, w, h, a) {
  const c = mkCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  w = c.width; h = c.height;
  drawCover(x, src, w, h);
  if (a.soft) { // 뽀샤시: 흐린 사본을 'screen'으로 얹어 빛 번짐(소프트 포커스) 효과
    const s1 = mkCanvas(w / 6, h / 6), s2 = mkCanvas(w / 18, h / 18), up = mkCanvas(w / 6, h / 6);
    s1.getContext('2d').drawImage(c, 0, 0, s1.width, s1.height);
    s2.getContext('2d').drawImage(s1, 0, 0, s2.width, s2.height);
    const ux = up.getContext('2d'); ux.imageSmoothingQuality = 'high'; ux.drawImage(s2, 0, 0, up.width, up.height);
    x.save(); x.globalCompositeOperation = 'screen'; x.globalAlpha = .45; x.drawImage(up, 0, 0, w, h); x.restore();
  }
  const neutral = !a.soft && !a.mono && !a.brightness && !a.saturation && !a.contrast;
  if (neutral) return c;
  const bri = 1 + a.brightness / 100 + (a.soft ? .05 : 0);
  const con = 1 + a.contrast / 100 - (a.soft ? .08 : 0);
  const sat = a.mono ? 0 : 1 + a.saturation / 100 + (a.soft ? -.04 : 0);
  const warm = a.soft && !a.mono ? [9, 3, 7] : [0, 0, 0];  // 화사한 핑크빛 피부톤
  const lut = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let v = 0; v < 256; v++) { const base = (v * bri - 128) * con + 128; for (let k = 0; k < 3; k++) lut[k][v] = clamp255(base + warm[k]); }
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[0][d[i]], g = lut[1][d[i + 1]], b = lut[2][d[i + 2]];
    if (sat !== 1) { const l = .299 * r + .587 * g + .114 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/* ---------- 9-B. 스티커 라이브러리 (직접 그린 벡터 → 인쇄해도 선명) ----------
   모든 스티커는 (0,0)을 중심으로 한 변 s인 정사각형 안에 그립니다. */
function strokeFill(x, fill, stroke, lw) { x.fillStyle = fill; x.fill(); if (stroke) { x.lineWidth = lw; x.strokeStyle = stroke; x.lineJoin = 'round'; x.stroke(); } }
function faceBase(x, s) {
  x.beginPath(); x.arc(0, 0, s * .44, 0, Math.PI * 2); strokeFill(x, '#FFD84A', '#2A2A30', s * .04);
  x.fillStyle = 'rgba(244,120,150,.55)';
  x.beginPath(); x.ellipse(-s * .25, s * .1, s * .07, s * .045, 0, 0, Math.PI * 2); x.ellipse(s * .25, s * .1, s * .07, s * .045, 0, 0, Math.PI * 2); x.fill();
}
function smileMouth(x, s) { x.beginPath(); x.lineWidth = s * .04; x.lineCap = 'round'; x.strokeStyle = '#2A2A30'; x.arc(0, s * .08, s * .16, .15 * Math.PI, .85 * Math.PI); x.stroke(); }
function star5(x, r1, r2) { x.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? r2 : r1, a = -Math.PI / 2 + i * Math.PI / 5; x.lineTo(Math.cos(a) * r, Math.sin(a) * r); } x.closePath(); }
function heartPath(x, s) { // 중심 기준, 폭 s
  const k = s / 32; x.beginPath(); x.moveTo(0, 10 * k);
  x.bezierCurveTo(-2 * k, 6 * k, -16 * k, 0, -16 * k, -8 * k); x.bezierCurveTo(-16 * k, -15 * k, -8 * k, -18 * k, 0, -10 * k);
  x.bezierCurveTo(8 * k, -18 * k, 16 * k, -15 * k, 16 * k, -8 * k); x.bezierCurveTo(16 * k, 0, 2 * k, 6 * k, 0, 10 * k); x.closePath();
}
const STICKERS = [
  { id: 'pxheart', name: '레트로 하트', draw(x, s) { drawPixelHeart(x, 0, 0, s * .86, '#E8574F', '#FFB3AE'); } },
  { id: 'pxheart2', name: '핑크 픽셀', draw(x, s) { drawPixelHeart(x, 0, 0, s * .86, '#F27EAD', '#FFE3EE'); } },
  { id: 'shades', name: '선글라스', draw(x, s) {
    const w = s * .96;
    x.fillStyle = '#1B1B20'; x.fillRect(-w / 2, -s * .14, w, s * .07);
    [-1, 1].forEach(d => { x.beginPath(); roundRectPath(x, d < 0 ? -w / 2 + s * .02 : s * .05, -s * .12, w / 2 - s * .07, s * .27, s * .1); x.fillStyle = '#1B1B20'; x.fill();
      x.fillStyle = 'rgba(255,255,255,.55)'; x.beginPath(); x.ellipse(d < 0 ? -w * .32 : w * .18, -s * .04, s * .06, s * .025, -.5, 0, Math.PI * 2); x.fill(); });
  } },
  { id: 'heartshades', name: '하트 안경', draw(x, s) {
    x.strokeStyle = '#2A2A30'; x.lineWidth = s * .035; x.beginPath(); x.moveTo(-s * .08, -s * .06); x.quadraticCurveTo(0, -s * .12, s * .08, -s * .06); x.stroke();
    [-1, 1].forEach(d => { x.save(); x.translate(d * s * .25, 0); heartPath(x, s * .46); strokeFill(x, '#FF6FA5', '#2A2A30', s * .035);
      x.fillStyle = 'rgba(255,255,255,.6)'; x.beginPath(); x.ellipse(-s * .07, -s * .07, s * .04, s * .02, -.6, 0, Math.PI * 2); x.fill(); x.restore(); });
  } },
  { id: 'smile', name: '스마일', draw(x, s) {
    faceBase(x, s); x.fillStyle = '#2A2A30';
    x.beginPath(); x.ellipse(-s * .14, -s * .08, s * .035, s * .06, 0, 0, Math.PI * 2); x.ellipse(s * .14, -s * .08, s * .035, s * .06, 0, 0, Math.PI * 2); x.fill(); smileMouth(x, s);
  } },
  { id: 'wink', name: '윙크', draw(x, s) {
    faceBase(x, s); x.fillStyle = '#2A2A30';
    x.beginPath(); x.ellipse(-s * .14, -s * .08, s * .035, s * .06, 0, 0, Math.PI * 2); x.fill();
    x.lineWidth = s * .04; x.lineCap = 'round'; x.strokeStyle = '#2A2A30'; x.beginPath(); x.moveTo(s * .08, -s * .1); x.lineTo(s * .2, -s * .06); x.lineTo(s * .08, -s * .02); x.stroke();
    smileMouth(x, s); x.beginPath(); x.arc(s * .04, s * .2, s * .06, 0, Math.PI); x.fillStyle = '#F47896'; x.fill();
  } },
  { id: 'loveeyes', name: '하트 눈', draw(x, s) {
    faceBase(x, s);
    [-1, 1].forEach(d => { x.save(); x.translate(d * s * .15, -s * .07); heartPath(x, s * .2); x.fillStyle = '#E8384F'; x.fill(); x.restore(); });
    x.beginPath(); x.arc(0, s * .1, s * .15, 0, Math.PI); x.closePath(); strokeFill(x, '#7A2A36', '#2A2A30', s * .03);
  } },
  { id: 'rainbow', name: '무지개', draw(x, s) {
    const cols = ['#FF6B6B', '#FFA94D', '#FFD84A', '#69DB7C', '#74C0FC', '#B197FC'], bw = s * .055;
    cols.forEach((c, i) => { x.beginPath(); x.lineWidth = bw; x.strokeStyle = c; x.arc(0, s * .18, s * .42 - i * bw, Math.PI, 0); x.stroke(); });
    [-1, 1].forEach(d => drawCloud(x, d * s * .3, s * .2, s * .34, '#FFFFFF'));
    [-1, 1].forEach(d => { x.save(); x.globalCompositeOperation = 'destination-over'; drawCloud(x, d * s * .3, s * .21, s * .38, '#CFE8F8'); x.restore(); });
  } },
  { id: 'cloud', name: '구름', draw(x, s) {
    drawCloud(x, 0, s * .02, s * .98, '#B9DDF5'); drawCloud(x, 0, 0, s * .9, '#FFFFFF');
    x.fillStyle = '#2A2A30'; x.beginPath(); x.arc(-s * .1, s * .02, s * .025, 0, Math.PI * 2); x.arc(s * .1, s * .02, s * .025, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(244,120,150,.6)'; x.beginPath(); x.ellipse(-s * .18, s * .07, s * .04, s * .025, 0, 0, Math.PI * 2); x.ellipse(s * .18, s * .07, s * .04, s * .025, 0, 0, Math.PI * 2); x.fill();
  } },
  { id: 'sparkle', name: '반짝', draw(x, s) {
    drawSparkle(x, -s * .08, s * .02, s * .74, '#FFD84A'); drawSparkle(x, -s * .08, s * .02, s * .34, '#FFF6C9');
    drawSparkle(x, s * .3, -s * .28, s * .26, '#F4A9C8'); drawSparkle(x, s * .3, s * .3, s * .18, '#A9D9F5');
  } },
  { id: 'star', name: '스타', draw(x, s) {
    star5(x, s * .46, s * .22); strokeFill(x, '#FFD84A', '#2A2A30', s * .035);
    x.fillStyle = '#2A2A30'; x.beginPath(); x.arc(-s * .07, -s * .01, s * .025, 0, Math.PI * 2); x.arc(s * .07, -s * .01, s * .025, 0, Math.PI * 2); x.fill();
    x.lineWidth = s * .025; x.strokeStyle = '#2A2A30'; x.beginPath(); x.arc(0, s * .04, s * .05, .1 * Math.PI, .9 * Math.PI); x.stroke();
  } },
  { id: 'crown', name: '왕관', draw(x, s) {
    x.beginPath(); x.moveTo(-s * .42, s * .25); x.lineTo(-s * .42, -s * .15); x.lineTo(-s * .2, s * .03); x.lineTo(0, -s * .3); x.lineTo(s * .2, s * .03); x.lineTo(s * .42, -s * .15); x.lineTo(s * .42, s * .25); x.closePath();
    strokeFill(x, '#FFCE3A', '#2A2A30', s * .035);
    [['#FF6FA5', -s * .22], ['#74C0FC', 0], ['#69DB7C', s * .22]].forEach(([c, px]) => { x.beginPath(); x.arc(px, s * .14, s * .055, 0, Math.PI * 2); strokeFill(x, c, '#2A2A30', s * .02); });
    [-s * .42, 0, s * .42].forEach((px, i) => { x.beginPath(); x.arc(px, i === 1 ? -s * .33 : -s * .18, s * .04, 0, Math.PI * 2); strokeFill(x, '#FFFFFF', '#2A2A30', s * .02); });
  } },
  { id: 'ribbon', name: '리본', draw(x, s) {
    [-1, 1].forEach(d => { x.beginPath(); x.moveTo(0, 0); x.bezierCurveTo(d * s * .2, -s * .32, d * s * .5, -s * .2, d * s * .44, 0); x.bezierCurveTo(d * s * .5, s * .2, d * s * .2, s * .3, 0, 0); strokeFill(x, '#F784B2', '#2A2A30', s * .035);
      x.beginPath(); x.moveTo(d * s * .04, s * .04); x.lineTo(d * s * .22, s * .42); x.lineTo(d * s * .1, s * .36); x.lineTo(d * s * .02, s * .44); x.closePath(); strokeFill(x, '#F06AA0', '#2A2A30', s * .03); });
    x.beginPath(); roundRectPath(x, -s * .08, -s * .1, s * .16, s * .2, s * .05); strokeFill(x, '#FFB3CF', '#2A2A30', s * .035);
  } },
  { id: 'catears', name: '고양이 귀', draw(x, s) {
    [-1, 1].forEach(d => { x.beginPath(); x.moveTo(d * s * .46, s * .2); x.lineTo(d * s * .36, -s * .32); x.lineTo(d * s * .1, s * .08); x.closePath(); strokeFill(x, '#2A2A30', '#2A2A30', s * .03);
      x.beginPath(); x.moveTo(d * s * .38, s * .12); x.lineTo(d * s * .34, -s * .16); x.lineTo(d * s * .2, s * .05); x.closePath(); x.fillStyle = '#F7A8C6'; x.fill(); });
  } },
  { id: 'blush', name: '볼터치', draw(x, s) {
    [-1, 1].forEach(d => { x.fillStyle = 'rgba(247,120,160,.75)'; x.beginPath(); x.ellipse(d * s * .27, 0, s * .17, s * .1, 0, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(214,70,120,.9)'; x.lineWidth = s * .025; x.lineCap = 'round';
      for (let k = -1; k <= 1; k++) { x.beginPath(); x.moveTo(d * s * .27 + k * s * .07 - s * .02, s * .04); x.lineTo(d * s * .27 + k * s * .07 + s * .02, -s * .04); x.stroke(); } });
  } },
  { id: 'flower', name: '꽃', draw(x, s) {
    for (let i = 0; i < 5; i++) { x.save(); x.rotate(i * Math.PI * 2 / 5); x.beginPath(); x.ellipse(0, -s * .22, s * .14, s * .2, 0, 0, Math.PI * 2); strokeFill(x, '#FFB3CF', '#2A2A30', s * .03); x.restore(); }
    x.beginPath(); x.arc(0, 0, s * .12, 0, Math.PI * 2); strokeFill(x, '#FFD84A', '#2A2A30', s * .03);
  } },
  { id: 'hi', name: '말풍선', draw(x, s) {
    x.beginPath(); roundRectPath(x, -s * .44, -s * .3, s * .88, s * .46, s * .18);
    x.moveTo(-s * .2, s * .14); x.lineTo(-s * .3, s * .38); x.lineTo(-s * .02, s * .16);
    strokeFill(x, '#FFFFFF', '#2A2A30', s * .035);
    x.fillStyle = '#2A2A30'; x.font = `700 ${Math.round(s * .24)}px "Unbounded", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('HI!', 0, -s * .07);
  } },
  { id: 'love', name: 'LOVE', draw(x, s) {
    x.font = `400 ${Math.round(s * .2)}px "Press Start 2P", monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = s * .06; x.strokeStyle = '#FFFFFF'; x.lineJoin = 'round'; x.strokeText('LOVE', 0, s * .02);
    x.fillStyle = '#E8574F'; x.fillText('LOVE', 0, s * .02);
    drawPixelHeart(x, s * .36, -s * .24, s * .2, '#E8574F', '#FFB3AE');
  } }
];
const stickerById = id => STICKERS.find(t => t.id === id) || STICKERS[0];
function drawSticker(x, st) {
  x.save(); x.translate(st.x, st.y); x.rotate(st.rot || 0);
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.setLineDash([]);
  stickerById(st.type).draw(x, st.size);
  x.restore();
}
function stickerCanvas(type, px) {
  const c = mkCanvas(px, px), x = c.getContext('2d');
  drawSticker(x, { type, x: px / 2, y: px / 2, size: px * .94, rot: 0 }); return c;
}

/* ---------- 10. ★ 프레임 렌더러 (미리보기 = 최종 PNG) ---------- */
function frameColors(styleId, bg) {
  const st = STYLES[styleId], light = luminance(bg) > 0.45;
  return { bg, light, ink: light ? '#27272D' : '#F5F5F7', soft: light ? 'rgba(39,39,45,.5)' : 'rgba(255,255,255,.6)',
    line: light ? 'rgba(39,39,45,.28)' : 'rgba(255,255,255,.35)', accent: st.accent };
}
function renderFrame(canvas, { L, scale, photos, adjust, deco, stickers = [], preview = false }) {
  canvas.width = Math.round(L.w * scale); canvas.height = Math.round(L.h * scale);
  const x = canvas.getContext('2d'); const st = STYLES[deco.style] || STYLES.classic;
  const C = frameColors(deco.style, deco.color);
  x.save(); x.scale(scale, scale);
  st.under(x, L, C);
  // 사진 배치
  L.slots.forEach((s, i) => {
    const src = photos[i];
    x.save(); roundRectPath(x, s.x, s.y, s.w, s.h, st.radius); x.clip();
    if (src) {
      const p = processPhoto(src, s.w * scale, s.h * scale, adjust);
      x.drawImage(p, s.x, s.y, s.w, s.h);
    } else if (preview) {
      x.fillStyle = C.light ? 'rgba(39,39,45,.07)' : 'rgba(255,255,255,.12)'; x.fillRect(s.x, s.y, s.w, s.h);
      x.strokeStyle = C.light ? 'rgba(39,39,45,.25)' : 'rgba(255,255,255,.4)'; x.setLineDash([14, 10]); x.lineWidth = 3;
      roundRectPath(x, s.x + 6, s.y + 6, s.w - 12, s.h - 12, Math.max(0, st.radius - 6)); x.stroke(); x.setLineDash([]);
      x.fillStyle = C.light ? 'rgba(39,39,45,.35)' : 'rgba(255,255,255,.55)';
      x.font = `700 ${Math.round(Math.min(s.w, s.h) * .28)}px "Unbounded", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(i + 1), s.x + s.w / 2, s.y + s.h / 2);
    }
    x.restore();
  });
  st.over(x, L, C);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  // 상단 타이틀 (엽서형)
  if (L.header) {
    const h = L.header; x.fillStyle = deco.style === 'classic' ? (C.light ? '#D58BA5' : '#F4A9C8') : C.ink;
    const fs = st.brandFont === 'Press Start 2P' ? 40 : st.brandFont === 'Space Mono' ? 48 : 60;
    x.font = `${st.brandWeight} ${fs}px "${st.brandFont}", sans-serif`;
    spacedText(x, st.brand, L.w / 2, h.h * .44, st.brandFont === 'Unbounded' ? 4 : 8);
    x.font = `400 18px "Space Mono", monospace`; x.fillStyle = C.soft;
    const tw = spacedText(x, st.tagline, L.w / 2, h.h * .78, 3);
    x.strokeStyle = C.line; x.lineWidth = 2; x.beginPath();
    x.moveTo(L.w / 2 - tw / 2 - 150, h.h * .78); x.lineTo(L.w / 2 - tw / 2 - 24, h.h * .78);
    x.moveTo(L.w / 2 + tw / 2 + 24, h.h * .78); x.lineTo(L.w / 2 + tw / 2 + 150, h.h * .78); x.stroke();
  }
  // 하단 문구 + 날짜
  const c = L.caption, f = fontById(deco.font), text = (deco.text || '').trim();
  const maxW = L.w - (L.kind === 'grid' ? 320 : 120);
  if (text) {
    let size = Math.min(c.h * .34, L.kind === 'grid' ? 74 : 58) * f.scale;
    x.font = `${f.weight} ${size}px "${f.id}", sans-serif`;
    while (x.measureText(text).width > maxW && size > 14) { size -= 2; x.font = `${f.weight} ${size}px "${f.id}", sans-serif`; }
    x.fillStyle = C.ink; x.fillText(text, L.w / 2, c.y + c.h * .44);
  } else {
    const fs = (st.brandFont === 'Press Start 2P' ? 22 : st.brandFont === 'Space Mono' ? 28 : 34) * (L.kind === 'grid' ? 1.3 : 1);
    x.font = `${st.brandWeight} ${fs}px "${st.brandFont}", sans-serif`; x.fillStyle = C.ink;
    spacedText(x, st.brand, L.w / 2, c.y + c.h * .44, 4);
  }
  x.font = st.brandFont === 'Press Start 2P' ? `400 12px "Press Start 2P", monospace` : `400 17px "Space Mono", monospace`;
  x.fillStyle = C.soft;
  spacedText(x, `${todayStr()}  ${L.kind === 'grid' ? '✦ ' + st.tagline : '✦ PHOTO BOOTH'}`, L.w / 2, c.y + c.h * .8, 2);
  // 스티커 (맨 위에 — 사진 위에도 붙일 수 있음)
  stickers.forEach(stk => drawSticker(x, stk));
  x.restore();
  return canvas;
}

/* 화면용 미리보기 (해상도를 화면에 맞춰 가볍게) */
function previewScale(L, targetH = 1100) { return Math.min(1, targetH / L.h); }
const slotPhotos = () => layout().slots.map((_, k) => (state.selection[k] != null && state.confirmed ? state.confirmed[state.selection[k]].canvas : null));
const rafJobs = new Map();
function scheduleRender(key, fn) {
  if (rafJobs.has(key)) return;
  rafJobs.set(key, requestAnimationFrame(() => { rafJobs.delete(key); fn(); }));
}

/* ---------- 11. 화면 전환 & 진행 단계 표시 ---------- */
const STEP_OF = { home: 0, code: 0, tlogin: 0, teacher: 0, layout: 1, shoot: 2, review: 3, compare: 3, pick: 4, adjust: 5, decorate: 6, sticker: 7, send: 8 };
const STEP_NAMES = ['', '프레임', '촬영', '확인', '고르기', '보정', '꾸미기', '스티커', '전송'];
function show(name) {
  if (state.screen === 'shoot' && name !== 'shoot') stopCamera();
  if (state.screen === 'teacher' && name !== 'teacher') leaveTeacher();
  state.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  const step = STEP_OF[name];
  document.body.dataset.screen = name;
  $('#stepper').hidden = step === 0;
  $$('#stepper .step').forEach((el, i) => { el.classList.toggle('done', i + 1 < step); el.classList.toggle('current', i + 1 === step); });
  $('#stepLabel').textContent = step ? `STEP ${String(step).padStart(2, '0')} / 08 · ${STEP_NAMES[step]}` : '';
  $('#stepBar').style.width = `${(step / 8) * 100}%`;
  window.scrollTo(0, 0);
  const enter = { home: syncHome, code: enterCode, tlogin: enterTeacherLogin, teacher: enterTeacher, layout: enterLayout, shoot: enterShoot, review: enterReview, compare: enterCompare, pick: enterPick, adjust: enterAdjust, decorate: enterDecorate, sticker: enterSticker, send: enterSend }[name];
  if (enter) enter();
}

/* ---------- HOME ---------- */
async function renderHome() {
  await BASE_FONTS_READY;
  const s = samples();
  renderFrame($('#homeStripL'), { L: LAYOUTS.strip4, scale: .32, photos: [s[0], s[1], s[2], s[3]], adjust: DEFAULT_ADJUST(), deco: { ...DEFAULT_DECO(), style: 'pink', color: '#F8D3E0' } });
  renderFrame($('#homeStripR'), { L: LAYOUTS.strip4, scale: .32, photos: [s[4], s[5], s[6], s[7]], adjust: DEFAULT_ADJUST(), deco: { ...DEFAULT_DECO(), style: 'y2k', color: '#E4E5EA' } });
}

function syncHome() {
  const c = codeStore.get();
  $('#codeChip').hidden = !c;
  if (c) $('#codeChipVal').textContent = c.code;
  $('#homeTestBadge').hidden = MODE !== 'local';
}

/* ---------- 입장 코드 ---------- */
function enterCode() {
  $('#codeInput').value = ''; $('#codeError').textContent = '';
  $('#codeHint').textContent = MODE === 'local' ? '선생님 모드에서 만든 숫자 4자리를 입력하세요.' : '선생님이 알려준 숫자 4자리예요.';
  setTimeout(() => $('#codeInput').focus(), 150);
}
async function submitCode(e) {
  e.preventDefault();
  const code = $('#codeInput').value.replace(/\D/g, '');
  if (code.length !== 4) { $('#codeError').textContent = '숫자 4자리를 입력해 주세요.'; return; }
  const btn = $('#btnCodeEnter'); btn.disabled = true; btn.textContent = '확인 중…'; $('#codeError').textContent = '';
  try {
    const j = await backend.checkCode(code);
    codeStore.set({ code, expiresAt: j.expiresAt });
    show('layout');
  } catch (err) { $('#codeError').textContent = errorText(err); $('#codeInput').select(); }
  finally { btn.disabled = false; btn.textContent = '입장하기 →'; }
}

/* ---------- STEP 1. 프레임(레이아웃) 선택 ---------- */
let layoutCardsBuilt = false;
async function enterLayout() {
  await BASE_FONTS_READY;
  const grid = $('#layoutGrid');
  if (!layoutCardsBuilt) {
    layoutCardsBuilt = true;
    Object.values(LAYOUTS).forEach(L => {
      const b = document.createElement('button');
      b.className = 'layout-card'; b.dataset.id = L.id; b.type = 'button';
      b.innerHTML = `<div class="layout-thumb"><canvas></canvas></div>
        <div class="layout-meta"><span class="chip">${L.cuts}컷</span><strong>${L.name}</strong><small>${L.sub}</small></div>
        <span class="check" aria-hidden="true">✓</span>`;
      renderFrame($('canvas', b), { L, scale: 260 / L.h, photos: samples().slice(0, L.cuts), adjust: DEFAULT_ADJUST(), deco: DEFAULT_DECO() });
      b.addEventListener('click', () => { state.layoutId = L.id; syncLayoutCards(); });
      grid.appendChild(b);
    });
  }
  syncLayoutCards();
}
function syncLayoutCards() {
  $$('.layout-card').forEach(c => c.classList.toggle('selected', c.dataset.id === state.layoutId));
  $('#btnLayoutNext').disabled = !state.layoutId;
}

/* ---------- STEP 2. 카메라 & 8장 연속 촬영 ---------- */
const cam = { stream: null, facing: 'user', mirror: true, demo: false };
let shootToken = 0;      // 촬영 중단(초기화) 감지용
let wakeLock = null;
function stopCamera() {
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = null; const v = $('#video'); if (v) v.srcObject = null;
}
async function startCamera() {
  stopCamera();
  $('#camError').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { facingMode: cam.facing, width: { ideal: 1920 }, height: { ideal: 1080 } }
  });
  cam.stream = stream;
  const v = $('#video'); v.srcObject = stream; await v.play().catch(() => {});
  const st = stream.getVideoTracks()[0].getSettings();
  cam.mirror = st.facingMode ? st.facingMode === 'user' : cam.facing === 'user'; // 노트북 웹캠은 facingMode가 없음 → 미러
  v.classList.toggle('mirror', cam.mirror);
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    $('#btnSwitchCam').hidden = devs.filter(d => d.kind === 'videoinput').length < 2;
  } catch (e) { $('#btnSwitchCam').hidden = true; }
  await new Promise(r => (v.videoWidth ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
  fitViewfinder();
}
function fitViewfinder() {
  // 뷰파인더 비율 = 카메라 비율, 사진에 실제로 들어갈 영역(크롭 가이드)을 표시
  const v = $('#video'), vf = $('#viewfinder');
  const vw = cam.demo ? 4 : (v.videoWidth || 16), vh = cam.demo ? 3 : (v.videoHeight || 9);
  vf.style.aspectRatio = `${vw} / ${vh}`;
  const s = layout().slots[0], slotR = s.w / s.h, camR = vw / vh;
  const g = $('#cropGuide');
  if (slotR > camR) { g.style.width = '100%'; g.style.height = `${(camR / slotR) * 100}%`; }
  else { g.style.height = '100%'; g.style.width = `${(slotR / camR) * 100}%`; }
}
function enterShoot() {
  const again = state.shootingFor === 'B';
  $('#shootTitle').textContent = again ? '다시 찍기 · 마지막 기회!' : '8장 연속 촬영';
  $('#shootSub').textContent = `한 컷마다 ${COUNTDOWN_SEC}초 카운트다운 후 찰칵! 네모 안이 사진에 들어가요.`;
  resetShootUI();
  $('#shootIntro').hidden = false;
  cam.demo = false;
  startCamera().catch(err => {
    console.warn('camera error', err);
    const msg = err && err.name === 'NotAllowedError' ? '카메라 권한이 거부되었어요. 주소창 옆 🔒 아이콘에서 카메라를 "허용"으로 바꿔 주세요.'
      : err && err.name === 'NotFoundError' ? '연결된 카메라를 찾지 못했어요.'
      : '이 브라우저에서 카메라를 열 수 없어요. (https 주소인지 확인해 주세요)';
    $('#camErrorMsg').textContent = msg; $('#camError').hidden = false;
  });
}
function resetShootUI() {
  const segs = $('#progressSegs'), roll = $('#filmRoll');
  segs.innerHTML = ''; roll.innerHTML = '';
  for (let i = 0; i < SHOTS_PER_SET; i++) {
    segs.insertAdjacentHTML('beforeend', '<span></span>');
    roll.insertAdjacentHTML('beforeend', `<div class="roll-cell"><span>${i + 1}</span></div>`);
  }
  $('#shotCounter').textContent = `00 / ${String(SHOTS_PER_SET).padStart(2, '0')}`;
  $('#countdown').textContent = ''; $('#countdown').classList.remove('tick');
  $('#remainLabel').textContent = `남은 촬영 ${SHOTS_PER_SET}장`;
}
function captureFrame(index) {
  if (cam.demo) return makeSample(index + (state.shootingFor === 'B' ? 3 : 0), 1280, 960, `DEMO ${index + 1}`);
  const v = $('#video'); const vw = v.videoWidth, vh = v.videoHeight;
  const r = Math.min(1, MAX_CAPTURE_SIDE / Math.max(vw, vh));
  const c = mkCanvas(vw * r, vh * r);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); // 미러 없이 = 원본 방향으로 저장
  return c;
}
function makeThumb(canvas) {
  const t = mkCanvas(320, 320 * canvas.height / canvas.width);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', .78);
}
async function runShooting() {
  const token = ++shootToken;
  initAudio();
  document.body.classList.add('capturing');
  $('#shootIntro').hidden = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; }
  const shots = [];
  const cd = $('#countdown');
  for (let i = 0; i < SHOTS_PER_SET; i++) {
    $('#shotCounter').textContent = `${String(i + 1).padStart(2, '0')} / ${String(SHOTS_PER_SET).padStart(2, '0')}`;
    $$('#progressSegs span').forEach((s, k) => { s.classList.toggle('done', k < i); s.classList.toggle('now', k === i); });
    for (let t = COUNTDOWN_SEC; t >= 1; t--) {
      if (token !== shootToken) return null;
      cd.textContent = t; cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick');
      cd.classList.toggle('hot', t <= 3);
      if (t <= 3) beep(t === 1 ? 1046 : 784, .09, .12);
      await sleep(1000);
    }
    if (token !== shootToken) return null;
    cd.textContent = ''; cd.classList.remove('hot');
    const canvas = captureFrame(i);
    shutterSound();
    const fl = $('#flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    const thumb = makeThumb(canvas);
    shots.push({ canvas, thumb });
    const cell = $$('#filmRoll .roll-cell')[i];
    cell.innerHTML = `<img src="${thumb}" alt="${i + 1}번째 사진"><span>${i + 1}</span>`; cell.classList.add('filled');
    $$('#progressSegs span')[i].classList.add('done');
    $('#remainLabel').textContent = i + 1 < SHOTS_PER_SET ? `남은 촬영 ${SHOTS_PER_SET - i - 1}장` : '촬영 완료!';
    await sleep(700);
  }
  document.body.classList.remove('capturing');
  try { await wakeLock?.release(); } catch (e) {}
  return shots;
}
async function onShootStart() {
  if (!cam.stream && !cam.demo) { toast('카메라가 아직 준비되지 않았어요'); return; }
  const shots = await runShooting();
  if (!shots) return; // 중간에 초기화됨
  if (state.shootingFor === 'A') { state.setA = shots; show('review'); }
  else { state.setB = shots; state.compareChoice = null; show('compare'); }
}

/* ---------- STEP 3. 재촬영 여부 & A/B 세트 비교 ---------- */
function thumbsHTML(set) { return set.map((s, i) => `<div class="mini-thumb"><img src="${s.thumb}" alt=""><span>${i + 1}</span></div>`).join(''); }
function enterReview() {
  $('#reviewGrid').innerHTML = thumbsHTML(state.setA);
  $('#btnRetake').disabled = state.retakeUsed;
}
function enterCompare() {
  $('#compareGridA').innerHTML = thumbsHTML(state.setA);
  $('#compareGridB').innerHTML = thumbsHTML(state.setB);
  syncCompare();
}
function syncCompare() {
  $$('.compare-card').forEach(c => { const on = c.dataset.set === state.compareChoice; c.classList.toggle('selected', on); c.setAttribute('aria-pressed', on); });
  $('#btnCompareConfirm').disabled = !state.compareChoice;
  $('#btnCompareConfirm').textContent = state.compareChoice ? `${state.compareChoice === 'A' ? '처음 찍은' : '다시 찍은'} 사진으로 결정하기` : '사용할 세트를 골라주세요';
}
/* 세트 영구 폐기: 캔버스 메모리를 0으로 만들고 모든 참조를 null 처리 */
function destroySet(set) {
  if (!set) return;
  for (let i = 0; i < set.length; i++) {
    const s = set[i];
    if (s && s.canvas) { s.canvas.width = 0; s.canvas.height = 0; s.canvas = null; s.thumb = null; }
    set[i] = null;
  }
  set.length = 0;
}
function confirmSet(which) {
  // which: 'A' | 'B'  → 선택된 세트만 confirmed로 이동, 나머지는 즉시 폐기
  const keep = which === 'A' ? state.setA : state.setB;
  const drop = which === 'A' ? state.setB : state.setA;
  if (!keep || keep.length !== SHOTS_PER_SET) { toast('사진 세트를 찾을 수 없어요'); return; }
  destroySet(drop);
  state.setA = null; state.setB = null;   // 원본 참조 끊기 (keep 배열은 confirmed가 단독 보유)
  state.confirmed = keep;
  state.compareChoice = null;
  state.selection = [];
  show('pick');
}

/* ---------- STEP 4. 사진 고르기 (클릭 순서 = 슬롯 순서) ---------- */
function enterPick() {
  const L = layout();
  $('#pickNeed').textContent = L.cuts;
  $('#pickOrderHint').textContent = L.kind === 'grid' ? '왼쪽 위 → 오른쪽 위 → 왼쪽 아래 → 오른쪽 아래' : '위에서 아래 순서';
  const grid = $('#pickGrid'); grid.innerHTML = '';
  state.confirmed.forEach((s, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pick-thumb'; b.dataset.idx = i;
    b.innerHTML = `<img src="${s.thumb}" alt="${i + 1}번 사진"><span class="badge"></span><span class="idx">${i + 1}</span>`;
    b.addEventListener('click', () => togglePick(i));
    grid.appendChild(b);
  });
  syncPick();
}
function togglePick(idx) {
  const need = layout().cuts, pos = state.selection.indexOf(idx);
  if (pos >= 0) state.selection.splice(pos, 1);          // 해제 → 뒤 번호들이 자동으로 한 칸씩 당겨짐
  else if (state.selection.length < need) state.selection.push(idx);
  else { toast(`${need}장까지 고를 수 있어요. 바꾸려면 먼저 하나를 눌러 해제하세요`); const el = $(`.pick-thumb[data-idx="${idx}"]`); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); return; }
  syncPick();
}
function syncPick() {
  const need = layout().cuts;
  $$('.pick-thumb').forEach(el => {
    const order = state.selection.indexOf(+el.dataset.idx);
    el.classList.toggle('selected', order >= 0);
    $('.badge', el).textContent = order >= 0 ? order + 1 : '';
  });
  $('#pickCount').textContent = `${state.selection.length} / ${need}`;
  $('#btnPickNext').disabled = state.selection.length !== need;
  scheduleRender('pick', () => renderFrame($('#pickPreview'), { L: layout(), scale: previewScale(layout()), photos: slotPhotos(), adjust: DEFAULT_ADJUST(), deco: state.deco, preview: true }));
}

/* ---------- STEP 5. 보정 ---------- */
function enterAdjust() { syncAdjustUI(); renderAdjustTiles(); renderAdjust(); }
function syncAdjustUI() {
  const a = state.adjust;
  $('#tglSoft').setAttribute('aria-pressed', a.soft); $('#tglMono').setAttribute('aria-pressed', a.mono);
  $('#tglSoft .tgl-state').textContent = a.soft ? 'ON' : 'OFF'; $('#tglMono .tgl-state').textContent = a.mono ? 'ON' : 'OFF';
  [['rngBright', 'brightness'], ['rngSat', 'saturation'], ['rngCon', 'contrast']].forEach(([id, k]) => {
    const r = $('#' + id); r.value = a[k];
    $(`output[for="${id}"]`).textContent = (a[k] > 0 ? '+' : '') + a[k];
    const pct = (a[k] - r.min) / (r.max - r.min) * 100; r.style.setProperty('--fill', pct + '%');
  });
  $('#rngSat').disabled = a.mono; $('#rngSat').closest('.slider').classList.toggle('disabled', a.mono);
}
function renderAdjust() {
  scheduleRender('adjust', () => renderFrame($('#adjustPreview'), { L: layout(), scale: previewScale(layout()), photos: slotPhotos(), adjust: state.adjust, deco: state.deco }));
}
function renderAdjustTiles() { // 토글 버튼 안의 작은 '필터 미리보기'
  const src = state.confirmed[state.selection[0]].canvas;
  [['#tglSoft canvas', { ...DEFAULT_ADJUST(), soft: true }], ['#tglMono canvas', { ...DEFAULT_ADJUST(), mono: true }]].forEach(([sel, a]) => {
    const c = $(sel), p = processPhoto(src, 120, 120, a); c.width = 120; c.height = 120; c.getContext('2d').drawImage(p, 0, 0);
  });
}

/* ---------- STEP 6. 꾸미기 ---------- */
let decoBuilt = false;
async function enterDecorate() {
  if (!decoBuilt) {
    decoBuilt = true;
    const sg = $('#styleGrid');
    Object.entries(STYLES).forEach(([id, st]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'style-card'; b.dataset.id = id;
      b.innerHTML = `<div class="style-thumb"><canvas></canvas></div><span>${st.name}</span>`;
      b.addEventListener('click', () => { state.deco.style = id; state.deco.color = st.color; syncDeco(); });
      sg.appendChild(b);
    });
    const sw = $('#swatches');
    COLORS.forEach(c => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.dataset.hex = c.hex;
      b.style.setProperty('--sw', c.hex); b.title = c.name; b.setAttribute('aria-label', c.name);
      b.innerHTML = `<i></i><span>${c.name}</span>`;
      b.addEventListener('click', () => { state.deco.color = c.hex; syncDeco(); });
      sw.appendChild(b);
    });
    const fl = $('#fontList');
    FONTS.forEach(f => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'font-chip'; b.dataset.id = f.id;
      b.innerHTML = `<b style="font-family:'${f.id}';font-weight:${f.weight}">가나다 Abc</b><span>${f.label}</span>`;
      b.addEventListener('click', () => { state.deco.font = f.id; syncDeco(); });
      fl.appendChild(b);
    });
  }
  // 스타일 썸네일은 '내가 고른 사진'으로 그려서 보여줌
  await BASE_FONTS_READY;
  const L = layout(), photos = slotPhotos();
  $$('.style-card').forEach(b => {
    const st = STYLES[b.dataset.id];
    renderFrame($('canvas', b), { L, scale: 150 / L.h, photos, adjust: state.adjust, deco: { ...state.deco, style: b.dataset.id, color: st.color, text: '' } });
  });
  $('#captionInput').value = state.deco.text;
  syncDeco();
}
async function syncDeco() {
  const d = state.deco;
  $$('.style-card').forEach(b => b.classList.toggle('selected', b.dataset.id === d.style));
  $$('.swatch').forEach(b => b.classList.toggle('selected', b.dataset.hex.toLowerCase() === d.color.toLowerCase()));
  $$('.font-chip').forEach(b => b.classList.toggle('selected', b.dataset.id === d.font));
  $('#captionCount').textContent = `${[...d.text].length} / 20`;
  const f = fontById(d.font);
  await ensureFont(f.id, f.weight, d.text || '가');
  scheduleRender('deco', () => renderFrame($('#decoPreview'), { L: layout(), scale: previewScale(layout()), photos: slotPhotos(), adjust: state.adjust, deco: state.deco, stickers: state.stickers }));
}

/* ---------- STEP 7. 스티커 붙이기 (끌어서 이동 · 모서리로 크기 · 위 손잡이로 회전 · 휴지통) ---------- */
let stickerGridBuilt = false, selectedStk = null, drag = null, stkSeq = 0;
const stkSize = () => { const s = layout().slots[0]; return Math.round(Math.min(s.w, s.h) * .55); };
const stkLimits = () => { const L = layout(); return { min: Math.round(L.w * .06), max: Math.round(L.w * 1.1) }; };

async function enterSticker() {
  if (!stickerGridBuilt) {
    stickerGridBuilt = true;
    await BASE_FONTS_READY;
    const g = $('#stickerGrid');
    STICKERS.forEach(t => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sticker-btn'; b.title = t.name; b.setAttribute('aria-label', t.name + ' 스티커 추가');
      b.appendChild(stickerCanvas(t.id, 128)); b.insertAdjacentHTML('beforeend', `<span>${t.name}</span>`);
      b.addEventListener('click', () => addSticker(t.id));
      g.appendChild(b);
    });
  }
  await BASE_FONTS_READY;
  renderFrame($('#stkPreview'), { L: layout(), scale: previewScale(layout()), photos: slotPhotos(), adjust: state.adjust, deco: state.deco, stickers: [] });
  selectedStk = null; renderStickerLayer();
}
function addSticker(type) {
  if (state.stickers.length >= MAX_STICKERS) { toast(`스티커는 ${MAX_STICKERS}개까지 붙일 수 있어요`); return; }
  const L = layout(), n = state.stickers.length, slot = L.slots[n % L.slots.length];
  const off = (Math.floor(n / L.slots.length) % 4) * 28;
  const st = { id: 's' + (++stkSeq), type, x: slot.x + slot.w / 2 + off, y: slot.y + slot.h / 2 + off, size: stkSize(), rot: 0 };
  state.stickers.push(st); selectedStk = st.id; renderStickerLayer();
}
function stickerEl(st) {
  const el = document.createElement('div');
  el.className = 'stk' + (st.id === selectedStk ? ' selected' : ''); el.dataset.id = st.id;
  el.appendChild(stickerCanvas(st.type, 300));
  el.insertAdjacentHTML('beforeend', '<span class="stk-h rot" data-mode="rot" aria-hidden="true">↻</span><span class="stk-h size" data-mode="size" aria-hidden="true">⤡</span>');
  positionSticker(el, st);
  el.addEventListener('pointerdown', e => startDrag(e, st, e.target.dataset.mode || 'move'));
  return el;
}
function positionSticker(el, st) {
  const L = layout();
  el.style.left = (st.x / L.w * 100) + '%'; el.style.top = (st.y / L.h * 100) + '%';
  el.style.width = (st.size / L.w * 100) + '%';
  el.style.transform = `translate(-50%, -50%) rotate(${st.rot}rad)`;
}
function renderStickerLayer() {
  const layer = $('#stkLayer'); layer.innerHTML = '';
  state.stickers.forEach(st => layer.appendChild(stickerEl(st)));
  const has = !!selectedStk;
  $$('#stkTools button').forEach(b => { b.disabled = !has; });
  $('#stkCount').textContent = `${state.stickers.length} / ${MAX_STICKERS}`;
  $('#btnStkClear').disabled = !state.stickers.length;
}
const findStk = id => state.stickers.find(s => s.id === id);
function selectSticker(id) {
  selectedStk = id;
  const i = state.stickers.findIndex(s => s.id === id);
  if (i >= 0 && i !== state.stickers.length - 1) state.stickers.push(...state.stickers.splice(i, 1)); // 고른 스티커를 맨 앞으로
  renderStickerLayer();
}
function startDrag(e, st, mode) {
  e.preventDefault(); e.stopPropagation();
  if (selectedStk !== st.id) selectSticker(st.id);
  const r = $('#stkLayer').getBoundingClientRect(), k = layout().w / r.width;
  drag = { id: st.id, mode, k, sx: e.clientX, sy: e.clientY, ox: st.x, oy: st.y,
    cx: r.left + st.x / k, cy: r.top + st.y / k, el: $(`.stk[data-id="${st.id}"]`) };
  if (mode === 'move') $('#stkTrash').classList.add('show');
}
function overTrash(e) { const t = $('#stkTrash').getBoundingClientRect(); return e.clientX >= t.left && e.clientX <= t.right && e.clientY >= t.top && e.clientY <= t.bottom; }
function onDragMove(e) {
  if (!drag) return;
  const st = findStk(drag.id); if (!st) return;
  const { min, max } = stkLimits();
  if (drag.mode === 'move') {
    st.x = drag.ox + (e.clientX - drag.sx) * drag.k; st.y = drag.oy + (e.clientY - drag.sy) * drag.k;
    const hot = overTrash(e); $('#stkTrash').classList.toggle('hot', hot); drag.el.classList.toggle('to-trash', hot);
  } else if (drag.mode === 'size') {
    const d = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy);
    st.size = Math.max(min, Math.min(max, d * Math.SQRT2 * drag.k));
  } else if (drag.mode === 'rot') {
    st.rot = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) + Math.PI / 2;
    const snap = Math.round(st.rot / (Math.PI / 2)) * (Math.PI / 2); if (Math.abs(st.rot - snap) < .08) st.rot = snap; // 똑바른 각도에 살짝 붙음
  }
  positionSticker(drag.el, st);
}
function onDragEnd(e) {
  if (!drag) return;
  const st = findStk(drag.id), L = layout();
  if (drag.mode === 'move' && overTrash(e)) { deleteSticker(drag.id); toast('스티커를 버렸어요 🗑'); }
  else if (st) { st.x = Math.max(0, Math.min(L.w, st.x)); st.y = Math.max(0, Math.min(L.h, st.y)); positionSticker(drag.el, st); }
  $('#stkTrash').classList.remove('show', 'hot');
  drag = null;
}
function deleteSticker(id) { state.stickers = state.stickers.filter(s => s.id !== id); if (selectedStk === id) selectedStk = null; renderStickerLayer(); }
function stkTool(act) {
  const st = findStk(selectedStk); if (!st) return;
  const { min, max } = stkLimits();
  if (act === 'smaller') st.size = Math.max(min, st.size * .85);
  if (act === 'bigger') st.size = Math.min(max, st.size * 1.15);
  if (act === 'rotate') st.rot += Math.PI / 12;
  if (act === 'copy') { if (state.stickers.length >= MAX_STICKERS) { toast(`스티커는 ${MAX_STICKERS}개까지예요`); return; } const c = { ...st, id: 's' + (++stkSeq), x: st.x + 30, y: st.y + 30 }; state.stickers.push(c); selectedStk = c.id; }
  if (act === 'delete') { deleteSticker(st.id); return; }
  renderStickerLayer();
}

/* ---------- STEP 8. 최종 합성 & 전송 ---------- */
async function enterSend() {
  $('#sendReady').hidden = false; $('#sendDone').hidden = true;
  $('#sendStatus').textContent = ''; $('#sendProgress').hidden = true; $('#sendBar').style.width = '0%';
  $('#demoNotice').hidden = MODE !== 'local';
  $('#btnSend').disabled = true; $('#btnSend').textContent = '완성본 만드는 중…';
  const f = fontById(state.deco.font);
  await Promise.all([BASE_FONTS_READY, ensureFont(f.id, f.weight, state.deco.text || '가')]);
  const L = layout(), c = document.createElement('canvas');
  renderFrame(c, { L, scale: EXPORT_SCALE, photos: slotPhotos(), adjust: state.adjust, deco: state.deco, stickers: state.stickers });
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;
  if (state.finalUrl) URL.revokeObjectURL(state.finalUrl);
  state.finalBlob = blob; state.finalUrl = URL.createObjectURL(blob);
  $('#sendImg').src = state.finalUrl; $('#doneImg').src = state.finalUrl;
  $('#btnSend').disabled = false; $('#btnSend').innerHTML = '선생님께 보내기 <span aria-hidden="true">→</span>';
}

async function sendToTeacher() {
  if (state.sending || state.sent || !state.finalBlob) return;
  const code = codeStore.get();
  if (!code) { $('#sendStatus').textContent = '입장 코드 기간이 끝났어요. 처음 화면에서 코드를 다시 입력해 주세요.'; $('#sendStatus').classList.add('error'); return; }
  state.sending = true;
  const btn = $('#btnSend'); btn.disabled = true; btn.textContent = '전송 중…'; $('#btnSendBack').disabled = true;
  $('#sendStatus').textContent = ''; $('#sendStatus').classList.remove('error');
  $('#sendProgress').hidden = false; $('#sendProgress').classList.add('indeterminate');
  try {
    await backend.upload({ code: code.code, blob: state.finalBlob, layout: layout().id, style: state.deco.style });
    state.sent = true;
    $('#sendReady').hidden = true; $('#sendDone').hidden = false;
    $('#doneMsg').innerHTML = '선생님께 전송이 완료되었습니다!<br>프린트될 때까지 잠시 기다려주세요.';
    initAudio(); beep(1318, .12, .1); setTimeout(() => beep(1760, .16, .1), 120);
  } catch (err) {
    console.error(err);
    if (err.code === 'BAD_CODE') codeStore.clear();
    $('#sendStatus').textContent = err.code === 'BAD_CODE' ? '입장 코드가 만료되었거나 바뀌었어요. 선생님께 새 코드를 받아 처음부터 다시 입력해 주세요.' : errorText(err) + ' 다시 눌러주세요.';
    $('#sendStatus').classList.add('error');
    btn.disabled = false; btn.innerHTML = '다시 보내기 <span aria-hidden="true">↻</span>'; $('#btnSendBack').disabled = false;
  } finally { state.sending = false; $('#sendProgress').hidden = true; $('#sendProgress').classList.remove('indeterminate'); }
}

/* ---------- 처음으로: 모든 데이터 초기화 ---------- */
function resetAll() {
  shootToken++;                     // 진행 중 촬영이 있다면 중단
  stopCamera(); document.body.classList.remove('capturing');
  destroySet(state.setA); destroySet(state.setB); destroySet(state.confirmed);
  if (state.finalUrl) URL.revokeObjectURL(state.finalUrl);
  Object.assign(state, {
    layoutId: null, setA: null, setB: null, retakeUsed: false, shootingFor: 'A', compareChoice: null,
    confirmed: null, selection: [], adjust: DEFAULT_ADJUST(), deco: DEFAULT_DECO(), stickers: [],
    finalBlob: null, finalUrl: null, sending: false, sent: false
  });
  ['#sendImg', '#doneImg'].forEach(s => $(s).removeAttribute('src'));
  $('#captionInput').value = '';
  $('#pickGrid').innerHTML = ''; $('#reviewGrid').innerHTML = ''; $('#compareGridA').innerHTML = ''; $('#compareGridB').innerHTML = '';
  $('#btnSendBack').disabled = false;
  show('home');
}

/* ---------- 12. 이벤트 연결 ---------- */
function bind() {
  $('#btnStudent').addEventListener('click', () => { initAudio(); show(codeStore.get() ? 'layout' : 'code'); });
  $('#btnTeacher').addEventListener('click', () => show('tlogin'));
  $('#btnCodeChange').addEventListener('click', () => { codeStore.clear(); show('code'); });
  $('#codeForm').addEventListener('submit', submitCode);
  $('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('#btnCodeBack').addEventListener('click', () => show('home'));
  $('#btnLayoutBack').addEventListener('click', () => show('home'));
  $('#btnLayoutNext').addEventListener('click', () => { state.shootingFor = 'A'; show('shoot'); });

  $('#btnShootStart').addEventListener('click', onShootStart);
  $('#btnSwitchCam').addEventListener('click', async () => { cam.facing = cam.facing === 'user' ? 'environment' : 'user'; try { await startCamera(); } catch (e) { toast('카메라를 바꿀 수 없어요'); } });
  $('#btnCamRetry').addEventListener('click', () => enterShoot());
  $('#btnCamDemo').addEventListener('click', () => { cam.demo = true; stopCamera(); $('#camError').hidden = true; $('#video').classList.remove('mirror'); fitViewfinder(); toast('샘플 사진으로 체험합니다'); });
  window.addEventListener('resize', () => { if (state.screen === 'shoot') fitViewfinder(); if (state.screen === 'pick') syncPick(); });

  $('#btnProceed').addEventListener('click', () => confirmSet('A'));
  $('#btnRetake').addEventListener('click', () => {
    if (state.retakeUsed) return;
    state.retakeUsed = true; state.shootingFor = 'B'; show('shoot');
  });
  $$('.compare-card').forEach(c => c.addEventListener('click', () => { state.compareChoice = c.dataset.set; syncCompare(); }));
  $('#btnCompareConfirm').addEventListener('click', () => state.compareChoice && confirmSet(state.compareChoice));

  $('#btnPickReset').addEventListener('click', () => { state.selection = []; syncPick(); });
  $('#btnPickNext').addEventListener('click', () => show('adjust'));

  $('#tglSoft').addEventListener('click', () => { state.adjust.soft = !state.adjust.soft; syncAdjustUI(); renderAdjust(); });
  $('#tglMono').addEventListener('click', () => { state.adjust.mono = !state.adjust.mono; syncAdjustUI(); renderAdjust(); });
  [['rngBright', 'brightness'], ['rngSat', 'saturation'], ['rngCon', 'contrast']].forEach(([id, k]) => {
    $('#' + id).addEventListener('input', e => { state.adjust[k] = +e.target.value; syncAdjustUI(); renderAdjust(); });
  });
  $('#btnAdjustReset').addEventListener('click', () => { state.adjust = DEFAULT_ADJUST(); syncAdjustUI(); renderAdjust(); });
  $('#btnAdjustBack').addEventListener('click', () => show('pick'));
  $('#btnAdjustNext').addEventListener('click', () => show('decorate'));

  $('#captionInput').addEventListener('input', e => {
    const chars = [...e.target.value]; if (chars.length > 20) e.target.value = chars.slice(0, 20).join('');
    state.deco.text = e.target.value; syncDeco();
  });
  $('#btnDecoBack').addEventListener('click', () => show('adjust'));
  $('#btnDecoNext').addEventListener('click', () => show('sticker'));

  // 스티커
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  $('#stkLayer').addEventListener('pointerdown', e => { if (e.target === e.currentTarget && selectedStk) { selectedStk = null; renderStickerLayer(); } });
  $$('#stkTools button').forEach(b => b.addEventListener('click', () => stkTool(b.dataset.act)));
  $('#btnStkClear').addEventListener('click', () => {
    const b = $('#btnStkClear');
    if (b.dataset.armed) { state.stickers = []; selectedStk = null; delete b.dataset.armed; b.textContent = '모두 지우기'; renderStickerLayer(); }
    else { b.dataset.armed = '1'; b.textContent = '정말 모두 지울까요? 한 번 더'; setTimeout(() => { delete b.dataset.armed; b.textContent = '모두 지우기'; }, 3000); }
  });
  window.addEventListener('keydown', e => { if (state.screen === 'sticker' && selectedStk && (e.key === 'Delete' || e.key === 'Backspace') && e.target.tagName !== 'INPUT') { e.preventDefault(); deleteSticker(selectedStk); } });
  $('#btnStkBack').addEventListener('click', () => show('decorate'));
  $('#btnStkNext').addEventListener('click', () => { selectedStk = null; show('send'); });

  $('#btnSend').addEventListener('click', sendToTeacher);
  $('#btnSendBack').addEventListener('click', () => { if (!state.sending && !state.sent) show('sticker'); });
  $('#btnHome').addEventListener('click', resetAll);

  window.addEventListener('beforeunload', e => { if ((state.confirmed || state.setA) && !state.sent) { e.preventDefault(); e.returnValue = ''; } });
}

bind();
initTeacher({ show, toast });
renderHome();
show('home');
