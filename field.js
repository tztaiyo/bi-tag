/* =====================================================================
   現場アプリ(スマホ)— タグを連続でスキャンして、部品と置き場所を紐づける
   - カメラは開いたまま。部品タグ → 場所タグ(どちらが先でもよい)をかざすだけで紐づく
   - 場所タグは読むと固定される。同じ場所に置く部品は、続けて部品タグをかざすだけ
   - タグの読み取りはこの端末の中で行い、結果だけをスプレッドシートに送る
   ===================================================================== */
const MODES = ['置く', '検査済', '保留'];
const F = { mode: '置く', part: null, loc: null, reason: HOLD_REASONS[0], started: false };
let MAST = { tags: {}, locs: {} };
let OUTBOX = [];            // 送信待ちのイベント
let RECENT = [];            // 画面に出す最近の操作 { ev, state: sending|sent|queued, ms }
let LASTROW = 1;            // どこまでイベントを読んだか
const ALERT_PRI = {};       // 管理からのアラートで優先になった品番
let ACKED = new Set();
const START_T = Date.now();

/* ---------------- 起動 ---------------- */
async function boot() {
  restoreLogin();
  try { MAST = JSON.parse(lsGet('bi_cache') || 'null') || MAST; } catch (e) { }
  try { OUTBOX = JSON.parse(lsGet('bi_outbox') || '[]'); } catch (e) { }
  try { ACKED = new Set(JSON.parse(lsGet('bi_acked') || '[]')); } catch (e) { }
  if (CONF.mock) installMockGIS();
  ON_LOGIN = () => main();
  if (!lsGet('bi_authorized')) return LOGIN_UI.show('受入・検査 現場アプリ', 'BLUE IMPULSE');
  main();
}
async function main() {
  document.body.className = 'field';
  await ensureDeviceName(/iPhone|Android/i.test(navigator.userAgent) ? '受入スマホ1' : '現場端末1');
  renderShell();
  refreshMasters(); flush();
  send(newEvent('hello', { data: { ua: navigator.userAgent.slice(0, 80), app: '現場' } }));
  setInterval(() => { poll(); flush(); }, 3000);   // 管理からのアラートを3秒ごとに確認
  setInterval(() => refreshMasters(), 60000);
  setInterval(() => send(newEvent('hello', { data: { pending: OUTBOX.length } })), 90000);
  window.addEventListener('online', () => flush());
  poll(true);
}
async function refreshMasters() {
  try { MAST = await readMasters(); lsSet('bi_cache', JSON.stringify(MAST)); } catch (e) { if (e instanceof NeedLogin) renderNet(); }
}

/* ---------------- 画面 ---------------- */
function renderShell() {
  $('app').innerHTML = `
  <header class="fb"><div class="fb-t">現場スキャン</div><div class="fb-s" id="net"></div></header>
  <div class="alertbar" id="alertbar" hidden></div>
  <section class="cam" id="cam">
    <video id="video" playsinline muted></video><canvas id="cv" hidden></canvas>
    <div class="frame"></div><div class="flash" id="flash"></div>
    <div class="camstart" id="camstart"><button class="btn primary big" onclick="startCamera()">スキャンを開始</button><div class="small">カメラを使ってタグを読み取ります</div></div>
    <div class="camhint" id="camhint"></div>
  </section>
  <nav class="modes">${MODES.map(m => `<button data-m="${m}" onclick="setMode('${m}')">${m}</button>`).join('')}</nav>
  <div class="reasons" id="reasons" hidden>${HOLD_REASONS.map(r => `<button data-r="${r}" onclick="setReason('${r}')">${r}</button>`).join('')}</div>
  <section class="pair" id="pair">
    <div class="slot" id="slotP"></div><div class="arrow" id="arrow">→</div><div class="slot loc" id="slotL" onclick="clearLoc()"></div>
  </section>
  <div class="msg" id="msg"></div>
  <section class="hist"><div class="hist-h"><b>この端末の操作</b><span id="sendinfo"></span></div><div id="recent"></div></section>
  <div class="manual"><input type="text" id="manual" placeholder="手入力(タグの文字)"><button class="btn" onclick="manualIn()">読む</button><button class="btn" onclick="photoScan()">写真で読む</button></div>`;
  $('manual').addEventListener('keydown', e => { if (e.key === 'Enter') manualIn(); });
  setMode(F.mode); renderPair(); renderRecent(); renderNet();
}
function setMode(m) {
  F.mode = m; document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('reasons').hidden = m !== '保留'; $('slotL').hidden = $('arrow').hidden = m !== '置く';
  if (m !== '置く') F.part = null;
  hint(); renderPair();
}
function setReason(r) { F.reason = r; document.querySelectorAll('.reasons button').forEach(b => b.classList.toggle('on', b.dataset.r === r)); }
function clearLoc() { if (!F.loc) return; F.loc = null; renderPair(); hint(); }
function hint() {
  const t = F.mode === '置く'
    ? (F.part && !F.part.done ? '次に置き場所のタグをかざしてください' : F.loc ? `${F.loc.code} に置く部品のタグを続けてかざしてください` : '部品のタグか、置き場所のタグをかざしてください')
    : F.mode === '検査済' ? '検査が終わった部品のタグをかざしてください' : `保留にする部品のタグをかざしてください(理由: ${F.reason})`;
  const h = $('camhint'); if (h) h.textContent = t;
}
function partName(p) { return (MAST.tags[p.tag] || {}).name || ''; }
function isPriPart(p) { return !!(p.pri || (MAST.tags[p.tag] || {}).pri || ALERT_PRI[p.part]); }
function renderPair() {
  const P = F.part, L = F.loc;
  $('slotP').className = 'slot' + (P ? ' set' : '') + (P && isPriPart(P) ? ' isPri' : '') + (P && P.done ? ' done' : '');
  $('slotP').innerHTML = P ? `<div class="sl-k">部品${P.done ? ' ✓' : ''}</div><div class="sl-v mono">${esc(P.part)}</div><div class="sl-s">${esc(partName(P))} ${P.lot ? '・' + esc(P.lot) : ''}</div>${isPriPart(P) ? `<span class="pri ${ALERT_PRI[P.part] && !P.pri ? 'alert' : ''}">優先${ALERT_PRI[P.part] && !P.pri ? '(管理から)' : ''}</span>` : ''}`
    : `<div class="sl-k">部品</div><div class="sl-e">部品タグ</div>`;
  $('slotL').className = 'slot loc' + (L ? ' set' : '') + (L && L.pz ? ' pz' : '');
  $('slotL').innerHTML = L ? `<div class="sl-k">置き場所 <span class="pin">固定中 ×</span></div><div class="sl-v mono">${esc(L.code)}</div><div class="sl-s">${esc(L.type)} ${esc(L.name || '')}</div>${L.pz ? '<span class="pri">優先置き場</span>' : ''}`
    : `<div class="sl-k">置き場所</div><div class="sl-e">場所タグ</div>`;
  hint();
}
function msg(html, cls = '') { $('msg').className = 'msg ' + cls; $('msg').innerHTML = html; }
function flash(cls) { const f = $('flash'); f.className = 'flash ' + cls; void f.offsetWidth; f.className = 'flash on ' + cls; }

/* ---------------- 読み取ったタグの処理 ---------------- */
const SEEN = {};
function onCode(text, src = 'cam') {
  const nowT = Date.now();
  if (src === 'cam' && SEEN[text] && nowT - SEEN[text] < 2500) return;   // 同じタグの読み直しは無視
  SEEN[text] = nowT;
  const t = parseTag(text);
  if (!t) { beep('ng'); flash('ng'); return msg(`このアプリのタグではありません <span class="mono small">${esc(text.slice(0, 40))}</span>`, 'ng'); }
  if (t.kind === 'loc') {
    const m = MAST.locs[t.code] || {};
    F.loc = { code: t.code, type: m.type || t.type, name: m.name || '', pz: m.code ? m.pz : t.pz };
    if (F.mode !== '置く') setMode('置く');
    if (F.part && !F.part.done) return link();
    beep('ok'); flash('ok'); renderPair();
    return msg(`置き場所を <b>${esc(F.loc.code)}</b> に固定しました。部品のタグを続けてかざしてください`);
  }
  // 部品タグ
  const P = { ...t };
  const pri = isPriPart(P);
  if (F.mode !== '置く') {
    F.part = { ...P, done: true }; renderPair();
    const ev = newEvent('status', { tag: P.tag, part: P.part, lot: P.lot, data: { to: F.mode, reason: F.mode === '保留' ? F.reason : '', pri } });
    send(ev); beep(pri ? 'pri' : 'ok'); flash(pri ? 'pri' : 'ok');
    return msg(`<b class="mono">${esc(P.part)}</b> を <b>${esc(F.mode)}</b> にしました${F.mode === '保留' ? `(${esc(F.reason)})` : ''}`, 'ok');
  }
  F.part = P;
  if (pri) {   // 優先品: すぐに知らせる
    beep('pri'); flash('pri');
    const pzs = Object.values(MAST.locs).filter(l => l.pz).map(l => l.code);
    msg(`<b>優先品です</b>${ALERT_PRI[P.part] && !P.pri ? '(管理からのアラート)' : '(タグで指定)'}。優先置き場${pzs.length ? `(${pzs.map(esc).join('・')})` : ''}へ置いてください`, 'pri');
  }
  if (F.loc) return link();
  if (!pri) { beep('ok'); flash('ok'); msg(`<b class="mono">${esc(P.part)}</b> を読みました。次に置き場所のタグをかざしてください`); }
  renderPair();
}
function link() {
  const P = F.part, L = F.loc, pri = isPriPart(P);
  const ev = newEvent('place', { tag: P.tag, part: P.part, lot: P.lot, loc: L.code, data: { pri, locType: L.type, pz: L.pz } });
  send(ev);
  F.part = { ...P, done: true }; renderPair();
  const pairEl = $('pair'); pairEl.classList.remove('linked'); void pairEl.offsetWidth; pairEl.classList.add('linked');
  if (pri && !L.pz) { beep('pri'); flash('pri'); return msg(`<b>${esc(P.part)}</b> を ${esc(L.code)} に置きました。<b>優先品です。優先置き場へ移してください</b>`, 'pri'); }
  beep('link'); flash('ok');
  msg(`<b class="mono">${esc(P.part)}</b> → <b>${esc(L.code)}</b> に置きました${!pri && L.pz ? '(通常品を優先置き場に置いています)' : ''}`, 'ok');
}
function manualIn() { const v = $('manual').value.trim(); $('manual').value = ''; if (v) onCode(v, 'manual'); }

/* ---------------- 送信(結果だけをスプレッドシートへ) ---------------- */
function send(ev) {
  OUTBOX.push(ev); lsSet('bi_outbox', JSON.stringify(OUTBOX));
  if (ev.type !== 'hello') { RECENT.unshift({ ev, state: 'sending', ms: 0 }); RECENT = RECENT.slice(0, 30); renderRecent(); }
  flush();
}
let FLUSHING = false;
async function flush() {
  if (FLUSHING || !OUTBOX.length) return renderNet(); FLUSHING = true;
  const batch = OUTBOX.slice(0, 20); const t0 = performance.now();
  try {
    await appendRows('events', batch.map(eventRow));
    const ms = Math.round(performance.now() - t0);
    const ids = new Set(batch.map(e => e.id));
    OUTBOX = OUTBOX.filter(e => !ids.has(e.id)); lsSet('bi_outbox', JSON.stringify(OUTBOX));
    RECENT.forEach(r => { if (ids.has(r.ev.id)) { r.state = 'sent'; r.ms = ms; r.bytes = eventRow(r.ev).join('').length; } });
    NET.lastSendMs = ms;
  } catch (e) {
    RECENT.forEach(r => { if (r.state === 'sending') r.state = 'queued'; });
  } finally { FLUSHING = false; renderRecent(); renderNet(); }
  if (OUTBOX.length && NET.online && tokenValid()) setTimeout(flush, 300);
}
function renderRecent() {
  const el = $('recent'); if (!el) return;
  el.innerHTML = RECENT.slice(0, 12).map(r => {
    const e = r.ev, d = e.data || {};
    const what = e.type === 'place' ? `<b class="mono">${esc(e.part)}</b> → <b>${esc(e.loc)}</b>` : e.type === 'status' ? `<b class="mono">${esc(e.part)}</b> を ${esc(d.to)}` : e.type === 'ack' ? 'アラートを確認' : esc(e.type);
    const st = r.state === 'sent' ? `<span class="sent">✓ 共有 ${(r.ms / 1000).toFixed(1)}秒 ・ ${r.bytes || ''}B</span>` : r.state === 'sending' ? '<span class="sending">送信中…</span>' : '<span class="queued">送信待ち(端末に保存)</span>';
    return `<div class="rc ${d.pri ? 'p' : ''}"><span class="t">${hms(e.at)}</span><span class="w">${what}${d.pri ? ' <span class="pri">優先</span>' : ''}</span>${st}</div>`;
  }).join('') || '<div class="mute small">まだ操作はありません</div>';
}
function renderNet() {
  const el = $('net'); if (!el) return;
  const q = OUTBOX.length;
  const st = !tokenValid() ? ['warn', 'ログインが必要'] : !NET.online ? ['bad', 'オフライン'] : q ? ['warn', `送信待ち ${q}`] : ['on', '接続中'];
  el.innerHTML = `${esc(DEVICE.name)} ・ <i class="dot ${st[0]}"></i>${st[1]}${!tokenValid() ? ' <button class="btn" onclick="login()">ログイン</button>' : ''}`;
  const si = $('sendinfo'); if (si) si.textContent = NET.lastSendMs ? `直近の送信 ${(NET.lastSendMs / 1000).toFixed(1)}秒` : '';
}

/* ---------------- 管理(PC)からのアラートを受け取る ---------------- */
async function poll(first) {
  if (!tokenValid()) return renderNet();
  try {
    const rows = await readRows('events', LASTROW + 1);
    rows.forEach((r, i) => {
      if (!r[0]) return;
      const e = rowEvent(r, LASTROW + 1 + i);
      if (e.type === 'alert') {
        ALERT_PRI[e.part] = true;
        const fresh = !ACKED.has(e.id) && e.device !== DEVICE.name && (Date.now() - (e.data.t || 0) < 30 * 60 * 1000);
        if (fresh) showAlert(e, first);
      }
      if (e.type === 'ack' && e.device === DEVICE.name) ACKED.add(e.data.alert);
    });
    LASTROW += rows.length; renderPair();
  } catch (e) { }
  renderNet();
}
const ALERTQ = [];
function showAlert(e) {
  if (ALERTQ.find(a => a.id === e.id)) return;
  ALERTQ.push(e); beep('pri'); renderAlert();
}
function renderAlert() {
  const bar = $('alertbar'); const e = ALERTQ[0];
  if (!e) { bar.hidden = true; return; }
  const d = e.data || {};
  bar.hidden = false;
  bar.innerHTML = `<div class="al-h">管理(PC)から 優先アラート <span>${hms(e.at)}</span></div>
    <div class="al-b"><b class="mono">${esc(e.part)}</b> ${esc(d.name || '')} が優先になりました。<br>${d.where ? `いまの場所: <b>${esc(d.where)}</b>。` : 'まだ置き場所の記録がありません。'}優先置き場へ移してください。</div>
    <button class="btn big" onclick="ackAlert()">了解(管理に返信)</button>`;
}
function ackAlert() {
  const e = ALERTQ.shift(); if (!e) return;
  ACKED.add(e.id); lsSet('bi_acked', JSON.stringify([...ACKED]));
  send(newEvent('ack', { part: e.part, data: { alert: e.id } }));
  renderAlert(); toast('管理に「了解」を返しました');
}

/* ---------------- カメラ(開いたまま連続で読む) ---------------- */
let DETECTOR = null;
async function startCamera() {
  beep('ok');   // 音を鳴らせるようにする(スマホはボタン操作のあとでないと鳴らない)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const v = $('video'); v.srcObject = stream; await v.play();
    $('camstart').hidden = true; F.started = true;
    if ('BarcodeDetector' in window) { try { const fm = await BarcodeDetector.getSupportedFormats(); if (fm.includes('qr_code')) DETECTOR = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { } }
    scanLoop();
  } catch (e) {
    $('camstart').innerHTML = `<div class="small">カメラを使えませんでした(${esc(e.name || e.message)})。<br>「写真で読む」か手入力で続けられます。</div><button class="btn" onclick="photoScan()">写真で読む</button>`;
  }
}
async function decodeFrame(src, w, h) {
  if (DETECTOR) { try { const r = await DETECTOR.detect(src); if (r.length) return r[0].rawValue; } catch (e) { } }
  const c = $('cv'); const sc = Math.min(1, 720 / Math.max(w, h)); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, c.width, c.height);
  const q = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
  return q && q.data;
}
async function scanLoop() {
  const v = $('video');
  if (v && v.readyState >= 2 && !ALERTQ.length) {
    try { const code = await decodeFrame(v, v.videoWidth, v.videoHeight); if (code) onCode(code); } catch (e) { }
  }
  setTimeout(scanLoop, DETECTOR ? 120 : 160);
}
function photoScan() {   // カメラ映像が使えないときの予備: 撮った写真から読む
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment');
  i.onchange = async () => {
    const f = i.files[0]; if (!f) return; const b = await createImageBitmap(f);
    let code = null; for (const max of [720, 1200, 1800]) { const sc = Math.min(1, max / Math.max(b.width, b.height)); const c = document.createElement('canvas'); c.width = b.width * sc; c.height = b.height * sc; c.getContext('2d').drawImage(b, 0, 0, c.width, c.height); const q = jsQR(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, c.height); if (q) { code = q.data; break; } }
    code ? onCode(code, 'photo') : msg('写真からタグが見つかりませんでした', 'ng');
  };
  i.click();
}
boot();
