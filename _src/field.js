/* =====================================================================
   現場アプリ(スマホ)— タグを連続でスキャンして、部品・台車・置き場所を紐づける
   - カメラは開いたまま。① 部品タグ → ② 台車タグ → ③ 置き場所タグ をかざすだけで記録される
   - 台車と置き場所は読むと固定される。同じ台車に載せる部品は、続けて部品タグをかざすだけ
   - 部品がない状態で台車 → 置き場所を読むと「台車ごとの移動」として記録される
   - タグの読み取りはこの端末の中で行い、結果だけをスプレッドシートに送る
   ===================================================================== */
// 画面の名前と内部の名前: 受入(台車に載せる・置く) / 検査(検査机で検査済・保留) / 入庫(入庫前→入庫済)
const MODES = [['置く', '受入'], ['検査', '検査'], ['入庫', '入庫']];
const F = { desk: null, result: '検査済', holdPending: null, inspWait: null, mode: '置く', part: null, cart: null, loc: null, moveCand: false, auto: lsGet('bi_reg') !== 'manual', voice: lsGet('bi_voice') !== '0', big: lsGet('bi_big') === '1', reason: HOLD_REASONS[0], started: false };
let MAST = { tags: {}, locs: {}, carts: {} };
let OUTBOX = [];            // 送信待ちのイベント
let RECENT = [];            // 画面に出す最近の操作 { ev, state: sending|sent|queued, ms }
let LASTROW = 1;            // どこまでイベントを読んだか
const ALERT_PRI = {};       // 管理からのアラートで優先になった品番
let ACKED = new Set();
const START_T = Date.now();
/* 二重登録を防ぐため、全端末の登録結果をこの端末でも把握しておく(3秒ごとに受信) */
const PLACED = {};          // タグ → { cart, loc, at, by }  最後に登録された台車・置き場所
const CARTLOC = {};         // 台車 → 置き場所
const STAT = {};            // タグ → ステータス(検査済・保留・入庫済)
const HOLDR = {};           // タグ → 保留の理由
const ORDERS = {};          // 管理からの移動の指示 id → { e, done, mine }
const APPLIED = new Set();
function applyEv(e) {
  if (APPLIED.has(e.id)) return; APPLIED.add(e.id);
  if (e.type === 'place') { PLACED[e.tag] = { cart: e.cart || '', loc: e.loc, at: e.at, by: e.device }; if (e.cart) CARTLOC[e.cart] = e.loc; if (!STAT[e.tag]) STAT[e.tag] = '未検査'; }
  else if (e.type === 'cart') { CARTLOC[e.cart] = e.loc; for (const o of Object.values(ORDERS)) if (!o.done && o.e.cart === e.cart && o.e.loc === e.loc) { o.done = e; orderDone(o); } }
  else if (e.type === 'status') {
    STAT[e.tag] = e.data.to === '解除' ? '未検査' : e.data.to;
    if (e.data.to === '保留') HOLDR[e.tag] = e.data.reason || '';
    if (e.loc) {   // 検査机で検査した = 部品はその場所にある
      const p = PLACED[e.tag], cl = p && p.cart ? CARTLOC[p.cart] : '';
      if (cl !== e.loc) PLACED[e.tag] = { cart: '', loc: e.loc, at: e.at, by: e.device };
    }
  }
  else if (e.type === 'order') ORDERS[e.id] = ORDERS[e.id] || { e, done: null, mine: false };
  else if (e.type === 'ack' && e.data.order && ORDERS[e.data.order]) ORDERS[e.data.order].acked = e;
}
const locOf = tag => { const p = PLACED[tag]; return p ? (p.cart ? (CARTLOC[p.cart] || p.loc) : p.loc) : ''; };
function statusOf(tag) {   // この端末から見た、いまのステータス
  let s = STAT[tag] || (PLACED[tag] ? '未検査' : '未受入');
  if (s === '検査済' && (MAST.locs[locOf(tag)] || {}).type === '入庫前') s = '未入庫';
  return s;
}
const locsOfType = t => Object.values(MAST.locs).filter(l => l.type === t).map(l => l.code);
const whereNow = p => p ? (p.cart ? `${p.cart}(${CARTLOC[p.cart] || p.loc})` : p.loc) : '';
const onCartCount = c => Object.values(PLACED).filter(p => p.cart === c).length;

/* ---------------- 起動 ---------------- */
async function boot() {
  restoreLogin();
  try { MAST = JSON.parse(lsGet('bi_cache') || 'null') || MAST; MAST.carts = MAST.carts || {}; } catch (e) { }
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
  setInterval(() => refreshMasters(), 15000);   // 計画・台車・置き場所の変更は15秒以内に届く
  setInterval(() => send(newEvent('hello', { data: { pending: OUTBOX.length } })), 90000);
  window.addEventListener('online', () => flush());
  poll(true);
}
let PREV_HOLD = null;   // 前に読んだ計画の保留(品番 → 理由)
async function refreshMasters() {
  try { MAST = await readMasters(); MAST_OK = Date.now(); lsSet('bi_cache', JSON.stringify(MAST)); if ($('pair')) renderPair(); holdNotice(); } catch (e) { if (e instanceof NeedLogin) renderNet(); }
  renderNet();
}
// 計画で新しく保留になった部品が、もう受入済みなら「検査しないで保留棚へ」と知らせる
function holdNotice() {
  const now = Object.fromEntries(Object.values(MAST.plans || {}).filter(p => p.hold).map(p => [p.part, p.hold]));
  const before = PREV_HOLD; PREV_HOLD = now;
  if (!before) return;
  const fresh = Object.keys(now).filter(p => !before[p]);
  const tags = Object.values(MAST.tags).filter(t => fresh.includes(t.part) && ['未検査'].includes(statusOf(t.tag)));
  if (!tags.length) return;
  const t = tags[0];
  beep('pri');
  sheet('hold', '!', '計画の変更: 検査しないで保留棚へ', [['部品', `<span class="mono">${esc(t.part)}</span> ${esc(t.name)}`], ['いまの場所', esc(whereNow(PLACED[t.tag]) || '-')], ['理由', esc(now[t.part]), 'warn'], ['置く場所', esc(locsOfType('保留場所').join('・') || '保留棚'), 'ok']],
    `この部品のタグを読むと保留になります。${tags.length > 1 ? `(ほかに ${tags.length - 1} 点)` : ''}`, '', 15000);
  say(`計画の変更です。${t.name || t.part} は、検査しないで、保留棚に入れてください`);
}
let MAST_OK = 0;

/* ---------------- 画面 ---------------- */
function renderShell() {
  $('app').innerHTML = `
  <header class="fb"><div class="fb-t">現場スキャン</div><div class="fb-s" id="net"></div></header>
  <div class="opts"><button id="regsw" onclick="toggleReg()"></button><button id="voicesw" onclick="toggleVoice()"></button><button id="sizesw" onclick="toggleSize()"></button></div>
  <div class="alertbar" id="alertbar" hidden></div>
  <section class="cam" id="cam">
    <video id="video" playsinline muted></video><canvas id="cv" hidden></canvas>
    <div class="frame"></div><div class="flash" id="flash"></div>
    <div class="camstart" id="camstart"><button class="btn primary big" onclick="startCamera()">スキャンを開始</button><div class="small">カメラを使ってタグを読み取ります</div></div>
    <div class="camhint" id="camhint"></div>
    <div class="candwrap" id="candwrap"></div>
  </section>
  <div class="orderbar" id="orderbar" hidden></div>
  <nav class="modes">${MODES.map(([m, label]) => `<button data-m="${m}" onclick="setMode('${m}')">${label}</button>`).join('')}</nav>
  <div class="results" id="results" hidden><span>検査の結果</span>${['検査済', '保留'].map(r => `<button data-res="${r}" onclick="setResult('${r}')">${r === '検査済' ? '✓ 検査済' : '保留'}</button>`).join('')}</div>
  <div class="reasons" id="reasons" hidden>${HOLD_REASONS.map(r => `<button data-r="${r}" onclick="setReason('${r}')">${r}</button>`).join('')}</div>
  <section class="pair" id="pair">
    <div class="slot wide" id="slotP"></div>
    <div class="pair2" id="pair2"><div class="slot cart" id="slotC"></div><div class="arrow" id="arrow">→</div><div class="slot loc" id="slotL"></div></div>
    <div class="slot loc desk" id="slotD" hidden></div>
  </section>
  <div class="act" id="act" hidden></div>
  <div class="msg" id="msg"></div>
  <section class="hist"><div class="hist-h"><b>この端末の操作</b><span id="sendinfo"></span></div><div id="recent"></div></section>
  <div class="sheet-back" id="sheet" hidden></div>
  <div class="manual"><input type="text" id="manual" placeholder="手入力(タグの文字)"><button class="btn" onclick="manualIn()">読む</button><button class="btn" onclick="photoScan()">写真で読む</button></div>`;
  $('manual').addEventListener('keydown', e => { if (e.key === 'Enter') manualIn(); });
  setMode(F.mode); renderReg(); renderPair(); renderRecent(); renderNet();
}
/* 登録のしかた: 自動 = 3つそろった瞬間に登録 / 手動 = そろったら「登録する」ボタンで登録 */
function renderReg() {
  const set = (id, on, html) => { const b = $(id); if (b) { b.className = on ? 'on' : ''; b.innerHTML = html; } };
  set('regsw', !F.auto, `登録 <b>${F.auto ? '自動' : '手動'}</b>`);
  set('voicesw', F.voice, `${F.voice ? '🔊' : '🔈'} 音声 <b>${F.voice ? 'あり' : 'なし'}</b>`);
  set('sizesw', F.big, `文字 <b>${F.big ? '特大' : '大'}</b>`);
  document.body.classList.toggle('xl', F.big);
}
function toggleVoice() { F.voice = !F.voice; lsSet('bi_voice', F.voice ? '1' : '0'); renderReg(); if (F.voice) say('音声でお知らせします'); else if (window.speechSynthesis) speechSynthesis.cancel(); }
function toggleSize() { F.big = !F.big; lsSet('bi_big', F.big ? '1' : '0'); renderReg(); }

/* ---------------- 音声(女性の声を優先) ---------------- */
let VOICE = null;
function pickVoice() {
  if (!window.speechSynthesis) return;
  const vs = speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang));
  const male = /Otoya|Ichiro|Keita|Hattori|Daichi|Male|男性/i, fem = /Kyoko|O-ren|Nanami|Haruka|Ayumi|Sayaka|Mizuki|Female|女性|Google/i;
  VOICE = vs.find(v => fem.test(v.name) && !male.test(v.name)) || vs.find(v => !male.test(v.name)) || vs[0] || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
const spell = c => String(c || '').replace(/[-_]/g, ' ').replace(/(\d)/g, ' $1 ').replace(/\s+/g, ' ').trim();   // C-01 → 「C 0 1」と1文字ずつ読む
function say(t) {
  if (!F.voice || !window.speechSynthesis) return;
  t = t.replace(/二重/g, 'にじゅう');   // 「ふたえ」と読まれないように
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = 'ja-JP'; if (VOICE) u.voice = VOICE; u.rate = 1.0; u.pitch = 1.15; speechSynthesis.speak(u); } catch (e) { }
}

/* ---------------- 大きなお知らせ画面(エラー・登録済み・優先など) ----------------
   画面の下半分に大きな文字で出す。タッチするか、次のタグを確定するか、時間がたつと閉じる(閉じるボタンは押さなくてよい) */
let SHEET_T = 0;
function sheet(kind, icon, title, rows, note, extra = '', ms = 0) {
  const el = $('sheet'); if (!el) return;
  clearTimeout(SHEET_T);
  el.className = 'sheet-back ' + kind; el.hidden = false;
  el.innerHTML = `<div class="sheet" onclick="if(!event.target.closest('button'))closeSheet()">
    <div class="sh-top"><div class="sh-ic">${icon}</div><div class="sh-t">${title}</div></div>
    ${rows.length ? `<div class="sh-rows">${rows.map(([l, v, c]) => `<div class="sh-r"><span class="sh-l">${l}</span><span class="sh-v ${c || ''}">${v}</span></div>`).join('')}</div>` : ''}
    ${note ? `<div class="sh-n">${note}</div>` : ''}${extra}
    <div class="sh-close">画面をタッチすると閉じます${ms ? `(${Math.round(ms / 1000)}秒で自動で閉じます)<i class="bar" style="animation-duration:${ms}ms"></i>` : ''}</div></div>`;
  if (ms) SHEET_T = setTimeout(closeSheet, ms);
}
function closeSheet() { clearTimeout(SHEET_T); const el = $('sheet'); if (el) { el.hidden = true; el.innerHTML = ''; } }
function toggleReg() { F.auto = !F.auto; lsSet('bi_reg', F.auto ? 'auto' : 'manual'); renderReg(); toast(F.auto ? '自動登録: 3つそろうと、すぐに登録します' : '手動登録: 3つそろったら「登録する」を押します'); step(); }
function setMode(m) {
  const changed = F.mode !== m;
  F.mode = m; document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('pair2').hidden = m !== '置く'; $('slotD').hidden = $('results').hidden = m !== '検査';
  $('reasons').hidden = !(m === '検査' && F.result === '保留');
  if (changed) { F.part = null; F.moveCand = false; F.inspWait = null; }
  hint(); renderPair();
  if (changed && $('msg')) msg(m === '検査' ? (F.desk ? `検査: <b>${esc(F.desk.code)}</b> で検査した部品のタグを読んでください` : '検査: まず <b>自分の机の場所タグ</b> を読んでください')
    : m === '入庫' ? '入庫: 入庫前の置き場所にある部品のタグを読むと <b>入庫済</b> になります' : '受入: 部品・台車・置き場所のタグを読んでください');
}
function setResult(r) {
  F.result = r; document.querySelectorAll('.results button').forEach(b => b.classList.toggle('on', b.dataset.res === r));
  $('reasons').hidden = !(F.mode === '検査' && r === '保留'); hint();
}
function clearDesk() { if (!F.desk) return; F.desk = null; renderPair(); msg('自分の机の固定を解除しました'); }
function setReason(r) { F.reason = r; hint(); document.querySelectorAll('.reasons button').forEach(b => b.classList.toggle('on', b.dataset.r === r)); }
// 台車と置き場所は、それぞれ別々に解除できる
function clearCart() { if (!F.cart) return; F.cart = null; F.moveCand = false; renderPair(); msg('台車の固定を解除しました'); }
function clearLoc() { if (!F.loc) return; F.loc = null; F.moveCand = false; renderPair(); msg('置き場所の固定を解除しました'); }
const pending = () => F.part && !F.part.done;
const ctx = () => [F.mode, F.cart && F.cart.code, F.loc && F.loc.code].join('|');   // 読んだときの台車・置き場所
function nextStep() {   // いま何をかざせばよいか
  if (pending()) return !F.cart ? '② 台車のタグをかざしてください' : !F.loc ? '③ 置き場所のタグをかざしてください' : F.auto ? '' : '内容を確かめて「登録する」を押してください';
  if (F.moveCand && !F.auto) return '台車ごとの移動なら「登録する」を押してください';
  if (F.cart && F.loc) return `${F.cart.code}(${F.loc.code})に載せる部品のタグをかざしてください`;
  if (F.cart) return `① 部品のタグ、または ③ ${F.cart.code} を置く場所のタグをかざしてください`;
  return '① 部品のタグをかざしてください';
}
function hint() {
  const t = F.mode === '置く' ? nextStep()
    : F.mode === '検査' ? (F.holdPending ? `保留品を保留場所に置いて、保留場所のタグを読んでください` : !F.desk ? '自分の机の場所タグを読んでください'
      : `${F.desk.code} で検査した部品のタグを読んでください(結果: ${F.result}${F.result === '保留' ? '・' + F.reason : ''})`)
    : '入庫前の置き場所にある部品のタグを読んでください';
  const h = $('camhint'); if (h) h.textContent = t;
}
function partName(p) { return (MAST.tags[p.tag] || {}).name || ''; }
function isPriPart(p) { return !!(p.pri || (MAST.tags[p.tag] || {}).pri || ALERT_PRI[p.part]); }
// いまそろっている登録の候補(なければ null)
function readyAction() {
  if (F.mode !== '置く' || !F.cart || !F.loc) return null;
  if (pending()) {
    if (F.part.moveAsk && !F.part.moveOk) return null;   // 二重読み取りで、移し替えを選ぶ前
    const prev = PLACED[F.part.tag];
    const same = prev && prev.cart === F.cart.code && (CARTLOC[F.cart.code] || prev.loc) === F.loc.code;
    return { kind: 'place', ng: planNG(MAST, F.part.part, F.cart.code, F.loc.code), dup: same ? prev : null, move: prev && !same ? prev : null };
  }
  if (F.moveCand) return { kind: 'cart', ng: cartMoveNG(MAST, F.cart.code, F.loc.code) };
  return null;
}
function renderPair() {
  const P = F.part, C = F.cart, L = F.loc, put = F.mode === '置く';
  const want = put ? (pending() ? (!C ? 'C' : !L ? 'L' : '') : (C && !L ? 'L' : 'P')) : 'P';
  // 計画と違うところは赤くして、計画の台車・置き場所を出す
  const ng = put && pending() ? planNG(MAST, P.part, C && C.code, L && L.code) : put && F.moveCand && C && L ? cartMoveNG(MAST, C.code, L.code) : [];
  const bad = k => ng.find(x => x.k === k);
  const plan = put && pending() ? (MAST.plans || {})[P.part] : null;
  const planLine = k => { const b = bad(k); return b ? `<div class="sl-ng">計画: ${esc(b.want.join('・'))}</div>` : ''; };
  $('slotP').className = 'slot wide' + (P ? ' set' : '') + (P && isPriPart(P) ? ' isPri' : '') + (P && P.done ? ' done' : '') + (want === 'P' && (!P || P.done) ? ' want' : '');
  const hold = P ? ((MAST.plans || {})[P.part] || {}).hold : '';
  const stNow = P && !put ? `<span class="st st-${statusOf(P.tag)}">${statusOf(P.tag)}</span>` : '';
  $('slotP').innerHTML = P ? `${hold ? `<div class="sl-band hold">計画で保留 ・ 理由: ${esc(hold)}</div>` : ''}${put && PLACED[P.tag] && (pending() || P.dup) ? `<div class="sl-band">二重読み取り ・ 登録済み ・ いまの場所 ${esc(whereNow(PLACED[P.tag]))}</div>` : ''}<div class="sl-k">${put ? '① ' : ''}部品${P.done && !P.dup ? ' ✓ いま登録' : ''}</div><div class="sl-row"><span class="sl-v mono">${esc(P.part)}</span>${stNow}${isPriPart(P) ? `<span class="pri ${ALERT_PRI[P.part] && !P.pri ? 'alert' : ''}">優先${ALERT_PRI[P.part] && !P.pri ? '(管理から)' : ''}</span>` : ''}</div><div class="sl-s">${esc(partName(P))} ${P.lot ? '・' + esc(P.lot) : ''}${put && pending() && !plan && Object.keys(MAST.plans || {}).length ? ' <span class="sl-plan">計画なし</span>' : ''}${plan ? ` <span class="sl-plan">計画: ${esc(plan.carts.join('・') || '台車指定なし')} @ ${esc(plan.locs.join('・') || '場所指定なし')}</span>` : ''}</div>`
    : `<div class="sl-k">${put ? '① ' : ''}部品</div><div class="sl-e">部品タグ</div>`;
  $('slotC').className = 'slot cart' + (C ? ' set' : '') + (C && C.pz ? ' pz' : '') + (put && want === 'C' ? ' want' : '') + (bad('台車') ? ' bad' : '');
  $('slotC').innerHTML = C ? `<div class="sl-k">② 台車</div><div class="sl-v mono">${esc(C.code)}</div><div class="sl-s">${esc(C.name || '')} ・ ${onCartCount(C.code)}点</div>${C.pz ? '<span class="pri">優先台車</span>' : ''}${planLine('台車')}<button class="unfix" onclick="clearCart()">✕ 台車を解除</button>`
    : `<div class="sl-k">② 台車</div><div class="sl-e">台車タグ</div>`;
  $('slotL').className = 'slot loc' + (L ? ' set' : '') + (L && L.pz ? ' pz' : '') + (put && want === 'L' ? ' want' : '') + (bad('置き場所') ? ' bad' : '');
  $('slotL').innerHTML = L ? `<div class="sl-k">③ 置き場所</div><div class="sl-v mono">${esc(L.code)}</div><div class="sl-s">${esc(L.type)} ${esc(L.name || '')}</div>${L.pz ? '<span class="pri">優先置き場</span>' : ''}${planLine('置き場所')}<button class="unfix" onclick="clearLoc()">✕ 置き場所を解除</button>`
    : `<div class="sl-k">③ 置き場所</div><div class="sl-e">場所タグ</div>`;
  const D = F.desk;
  $('slotD').className = 'slot loc desk' + (D ? ' set' : ' want');
  $('slotD').innerHTML = D ? `<div class="sl-k">自分の机(検査する場所)</div><div class="sl-row"><span class="sl-v mono">${esc(D.code)}</span><span class="sl-s">${esc(D.type)} ${esc(D.name || '')}</span></div><button class="unfix" onclick="clearDesk()">✕ 机を解除</button>`
    : `<div class="sl-k">自分の机(検査する場所)</div><div class="sl-e">机の場所タグを読んでください</div>`;
  document.querySelectorAll('.results button').forEach(b => b.classList.toggle('on', b.dataset.res === F.result));
  renderAct(); hint();
}
function renderAct() {   // 手動登録のときの「登録する」ボタン
  const el = $('act'); if (!el) return;
  const r = F.auto ? null : readyAction();
  if (!r) { el.hidden = true; el.innerHTML = ''; return; }
  const C = F.cart.code, L = F.loc.code;
  el.hidden = false;
  el.innerHTML = `<button class="btn regbtn ${r.dup ? 'dupb' : r.move ? 'mvb' : r.ng.length ? 'ngb' : ''}" onclick="register()">${r.kind === 'place' ? (r.dup ? '登録済み(押しても送りません)' : r.move ? '移し替えを登録' : '登録する') : '台車ごと移動を登録'}<small>${r.kind === 'place' ? `${esc(F.part.part)}${r.move ? ` : ${esc(whereNow(r.move))} から` : ''} → ${esc(C)} @ ${esc(L)}` : `${esc(C)} → ${esc(L)}(載っている部品も移動)`}</small></button>`;
}
function cancelReady() { const r = readyAction(); if (!r) return; if (r.kind === 'place') F.part = null; F.moveCand = false; renderPair(); msg('取り消しました(登録していません)'); }
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
  if (t.kind === 'cart') {
    const m = MAST.carts[t.code] || {};
    if (F.mode !== '置く') setMode('置く');
    F.cart = { code: t.code, name: m.name || '', pz: m.code ? m.pz : t.pz }; F.moveCand = false;
    beep('ok'); flash('ok');
    msg(`台車を <b>${esc(F.cart.code)}</b> に固定しました`); say('台車 ' + spell(F.cart.code));
    return step();
  }
  if (t.kind === 'loc' && F.holdPending && ((MAST.locs[t.code] || {}).type || t.type) === '保留場所') {
    const m = MAST.locs[t.code] || {}; return placeHold({ code: t.code, type: '保留場所', name: m.name || '' });
  }
  if (t.kind === 'loc' && F.mode === '検査') return inspLoc(t);
  if (t.kind === 'loc') {
    const m = MAST.locs[t.code] || {};
    if (F.mode !== '置く') setMode('置く');
    const changed = !F.loc || F.loc.code !== t.code;
    F.loc = { code: t.code, type: m.type || t.type, name: m.name || '', pz: m.code ? m.pz : t.pz };
    // 部品なしで 台車 → 置き場所 = 台車ごとの移動。ただし部品が載っていて、前の置き場所と違うときだけ
    // (空の台車や、まだ場所の記録がない台車なら、置き場所を固定するだけ)
    F.moveCand = !pending() && !!F.cart && changed && !!CARTLOC[F.cart.code] && CARTLOC[F.cart.code] !== t.code && onCartCount(F.cart.code) > 0;
    beep('ok'); flash('ok');
    msg(`置き場所を <b>${esc(F.loc.code)}</b> に固定しました`); say('置き場所 ' + spell(F.loc.code));
    return step();
  }
  // 部品タグ
  const P = { ...t };
  // カメラに同じ部品タグが映り続けているだけ(台車・置き場所も変わっていない)なら、もう一度は処理しない
  if (src === 'cam' && F.part && F.part.done && F.part.tag === P.tag && F.part.ctx === ctx()) return;
  const pri = isPriPart(P);
  if (F.mode === '検査') return inspect(P);
  if (F.mode === '入庫') return stockIn(P);
  F.part = P; F.moveCand = false;
  // 二重読み取り(登録済みの部品)がいちばん優先。優先品・計画のチェックより先に知らせる
  // 計画で保留の部品: 検査しないで保留棚へ(台車には載せない)
  const planHold = ((MAST.plans || {})[P.part] || {}).hold;
  if (planHold && statusOf(P.tag) !== '保留') return holdOrder(P, planHold);
  if (planHold && statusOf(P.tag) === '保留' && (MAST.locs[locOf(P.tag)] || {}).type === '保留場所') return dupSheet(P, 'すでに保留棚にあります', `検査しない部品です(理由: ${esc(planHold)})。今回は記録していません。`);
  if (PLACED[P.tag]) return dupStop(PLACED[P.tag]);
  if (pri) {   // 優先品: すぐに知らせる
    beep('pri'); flash('pri');
    const pcs = Object.values(MAST.carts).filter(c => c.pz).map(c => c.code), pzs = Object.values(MAST.locs).filter(l => l.pz).map(l => l.code);
    msg(`<b>優先品です</b>${ALERT_PRI[P.part] && !P.pri ? '(管理からのアラート)' : '(タグで指定)'}。優先台車${pcs.length ? `(${pcs.map(esc).join('・')})` : ''}か優先置き場${pzs.length ? `(${pzs.map(esc).join('・')})` : ''}へ`, 'pri');
  } else { beep('ok'); flash('ok'); msg(`<b class="mono">${esc(P.part)}</b> を読みました`); }
  step(true);
  if (pri && pending() && $('sheet').hidden) {   // まだ登録されていない優先品は、大きく知らせる
    const pcs = Object.values(MAST.carts).filter(c => c.pz).map(c => c.code), pzs = Object.values(MAST.locs).filter(l => l.pz).map(l => l.code);
    sheet('pri', '!', '優先品です', [['優先の台車', esc(pcs.join('・') || '-'), 'ok'], ['優先の置き場所', esc(pzs.join('・') || '-'), 'ok']], `<b class="mono">${esc(P.part)}</b> ${esc(partName(P))}`, '', 5000);
    say('優先品です。優先の台車に載せてください');
  }
}
/* ---------------- 検査(検査机で: 検査済 / 保留) ---------------- */
function inspLoc(t) {
  const m = MAST.locs[t.code] || {};
  const L = { code: t.code, type: m.type || t.type, name: m.name || '' };
  if (F.holdPending && L.type === '保留場所') return placeHold(L);
  F.desk = L; beep('ok'); flash('ok'); renderPair();
  say('検査の場所 ' + spell(L.code));
  if (F.inspWait) { const P = F.inspWait; F.inspWait = null; return inspect(P); }   // 机より先に読んだ部品を、いま検査する
  msg(`自分の机を <b>${esc(L.code)}</b> ${esc(L.name || '')} に固定しました。検査した部品のタグを読んでください${L.type !== '検査机' ? `<br><span class="small">(この場所の種別は「${esc(L.type)}」です)</span>` : ''}`, 'ok');
}
function dupSheet(P, title, note) {
  F.part = { ...P, done: true, ctx: ctx(), dup: true }; renderPair(); beep('dup'); flash('dup');
  RECENT.unshift({ ev: { type: 'dup', at: now(), part: P.part, tag: P.tag, data: { to: title } }, state: 'skip' }); renderRecent();
  sheet('dup', '✓', title, [['部品', `<span class="mono">${esc(P.part)}</span>`]], note || '今回は記録していません。<b>数は増えていません。</b>', '', 5000);
  say(title.replace(/[「」]/g, '') + '。数は増えていません');
  msg(`✓ <b class="mono">${esc(P.part)}</b>: ${esc(title)}(記録していません)`, 'dup');
}
function stopSheet(P, title, rows, note, speech) {   // 進めない理由を大きく知らせる(記録しない)
  F.part = { ...P, done: true, ctx: ctx() }; renderPair(); beep('ng'); flash('ng');
  sheet('ng', '✕', title, [['部品', `<span class="mono">${esc(P.part)}</span>`], ...rows], note);
  say(speech || title); msg(`✕ <b>${esc(title)}</b>(記録していません)`, 'ng');
}
function inspect(P) {
  const st = statusOf(P.tag), planHold = ((MAST.plans || {})[P.part] || {}).hold;
  if (planHold) {   // 計画で保留 = 検査しない部品
    if (st !== '保留') return holdOrder(P, planHold);
    return stopSheet(P, 'この部品は検査しません', [['保留の理由', esc(planHold), 'warn'], ['いまの場所', esc(whereNow(PLACED[P.tag]) || '-')]], '計画で保留になっている部品です。保留棚に置いたままにしてください。', 'この部品は検査しません。保留品です');
  }
  const to = F.result, reason = to === '保留' ? F.reason : '';
  if (st === '未受入') return stopSheet(P, 'まだ受入されていません', [['いまの状態', '未受入', 'bad']], '先に「受入」で台車に載せてください。', 'まだ受入されていません。先に受入をしてください');
  if (st === to) return dupSheet(P, `すでに「${to}」です`);
  if (to === '検査済' && (st === '未入庫' || st === '入庫済')) return dupSheet(P, `すでに検査済です(${st})`);
  if (!F.desk) {   // 机が決まっていない: 部品は覚えておき、机のタグを読んだら続ける
    F.inspWait = P; F.part = P; renderPair(); beep('dup');
    sheet('dup', '?', '自分の机のタグを読んでください', [['部品', `<span class="mono">${esc(P.part)}</span>`]], '机(検査する場所)の場所タグを読むと、この部品の検査を記録します。', '', 6000);
    say('先に、自分の机の場所タグを読んでください'); return msg('先に <b>自分の机の場所タグ</b> を読んでください', 'warn');
  }
  const pri = isPriPart(P);
  send(newEvent('status', { tag: P.tag, part: P.part, lot: P.lot, loc: F.desk.code, data: { to, reason, planned: !!planHold, pri, from: st } }));
  F.part = { ...P, done: true, ctx: ctx() }; renderPair(); linkedFx();
  if (to === '保留') {
    F.holdPending = P; hint();
    const hl = locsOfType('保留場所');
    beep('pri'); flash('pri');
    sheet('hold', '!', '保留品です', [['理由', esc(reason), 'warn'], ['置く場所', esc(hl.join('・') || '保留場所'), 'ok']],
      '保留場所に置いて、<b>保留場所のタグ</b>を読んでください。', '', 12000);
    say(`保留品です。理由は、${reason}。保留場所に置いて、場所のタグを読んでください`);
    return msg(`! <b class="mono">${esc(P.part)}</b> を <b>保留</b> にしました(${esc(reason)})。保留場所のタグを読んでください`, 'warn');
  }
  beep('link'); flash('ok'); say('検査済にしました');
  msg(`✓ <b class="mono">${esc(P.part)}</b> を <b>検査済</b> にしました(${esc(F.desk.code)})`, 'ok');
}
// 計画で保留の部品を読んだ: 「検査しないで、保留棚へ」。保留にして、保留場所のタグを待つ
function holdOrder(P, reason) {
  const st = statusOf(P.tag);
  send(newEvent('status', { tag: P.tag, part: P.part, lot: P.lot, data: { to: '保留', reason, planned: true, from: st, pri: isPriPart(P) } }));
  F.part = { ...P, done: true, ctx: ctx() }; F.holdPending = P; renderPair(); linkedFx();
  const hl = locsOfType('保留場所');
  beep('pri'); flash('pri');
  sheet('hold', '!', '検査しないで、保留棚へ', [['部品', `<span class="mono">${esc(P.part)}</span>`], ['理由', esc(reason), 'warn'], ['置く場所', esc(hl.join('・') || '保留棚'), 'ok']],
    `計画で<b>保留</b>になっている部品です。<b>台車には載せず</b>、保留棚に置いて<b>保留棚のタグ</b>を読んでください。`, '', 15000);
  say(`この部品は、検査しないで、保留棚に入れてください。理由は、${reason}`);
  msg(`! <b class="mono">${esc(P.part)}</b>: <b>検査しないで保留棚へ</b>(${esc(reason)})。保留棚のタグを読んでください`, 'warn');
}
function placeHold(L) {   // 保留品を保留場所に置いた
  const P = F.holdPending; F.holdPending = null;
  send(newEvent('place', { tag: P.tag, part: P.part, lot: P.lot, loc: L.code, cart: '', data: { hold: true } }));
  beep('link'); flash('ok'); closeSheet(); renderPair(); linkedFx();
  say('保留場所に置きました');
  msg(`✓ 保留品 <b class="mono">${esc(P.part)}</b> を保留場所 <b>${esc(L.code)}</b> に置きました`, 'ok');
}
/* ---------------- 入庫(入庫前の場所にある部品を1つずつ) ---------------- */
function stockIn(P) {
  const st = statusOf(P.tag);
  if (st === '入庫済') return dupSheet(P, 'すでに入庫済です');
  if (st === '保留') return stopSheet(P, '保留品は入庫できません', [['保留の理由', esc(HOLDR[P.tag] || ((MAST.plans || {})[P.part] || {}).hold || '-'), 'warn']], '保留が解除されてから入庫してください。', '保留品は入庫できません');
  if (st === '未受入' || st === '未検査') return stopSheet(P, 'まだ検査されていません', [['いまの状態', st, 'bad']], '検査済になってから入庫してください。', 'まだ検査されていません');
  if (st === '検査済') return stopSheet(P, '入庫前の置き場所にありません', [['いまの場所', esc(whereNow(PLACED[P.tag]) || '-'), 'bad'], ['入庫前の場所', esc(locsOfType('入庫前').join('・') || '-'), 'ok']],
    '先に、台車ごと入庫前の場所へ移してください(受入で 台車 → 入庫前の場所タグ)。', '入庫前の置き場所にありません');
  send(newEvent('status', { tag: P.tag, part: P.part, lot: P.lot, data: { to: '入庫済', from: st, at: locOf(P.tag) } }));
  F.part = { ...P, done: true, ctx: ctx() }; renderPair(); linkedFx();
  beep('link'); flash('ok'); say('入庫しました');
  msg(`✓ <b class="mono">${esc(P.part)}</b> を <b>入庫済</b> にしました`, 'ok');
}
/* ---------------- 管理からの移動の指示 ---------------- */
function openOrders() { return Object.values(ORDERS).filter(o => !o.done && Date.now() - (o.e.data.t || 0) < 12 * 3600e3).sort((a, b) => (a.e.data.t || 0) - (b.e.data.t || 0)); }
function renderOrders() {
  const el = $('orderbar'); if (!el) return;
  const os = openOrders();
  if (!os.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = os.slice(0, 2).map(o => { const e = o.e, d = e.data || {};
    return `<div class="ord ${o.mine ? 'mine' : ''}"><div class="od-t">📋 管理からの指示${os.length > 1 ? `(${os.length}件)` : ''}</div>
      <div class="od-b">台車 <b>${esc(e.cart)}</b> を <b>${esc(d.toName || e.loc)}</b>(${esc(e.loc)})へ移動${d.note ? `<div class="od-n">${esc(d.note)}</div>` : ''}</div>
      ${o.mine ? `<div class="od-s">実行中: 台車を運び、<b>${esc(e.loc)}</b> の場所タグを読んでください</div>` : `<button class="btn od-go" onclick="startOrder('${e.id}')">はじめる</button>`}</div>`; }).join('');
}
function startOrder(id) {
  const o = ORDERS[id]; if (!o) return;
  o.mine = true;
  send(newEvent('ack', { cart: o.e.cart, loc: o.e.loc, data: { order: id } }));
  setMode('置く'); closeSheet();
  const m = MAST.carts[o.e.cart] || {};
  F.cart = { code: o.e.cart, name: m.name || '', pz: !!m.pz }; F.loc = null; F.part = null; F.moveCand = false;
  renderPair(); renderOrders();
  msg(`台車 <b>${esc(o.e.cart)}</b> を固定しました。運んだら <b>${esc(o.e.loc)}</b> の場所タグを読んでください`, 'ok');
  say(`台車 ${spell(o.e.cart)} を、${(o.e.data || {}).toName || spell(o.e.loc)} へ運んで、場所のタグを読んでください`);
}
function orderDone(o) {
  renderOrders();
  if (o.mine) { toast('指示の移動が完了しました'); say('指示の移動が完了しました'); }
}
function newOrder(o) {
  if (o.e.device === DEVICE.name || Date.now() - (o.e.data.t || 0) > 30 * 60e3) return;
  beep('pri'); say(`管理から移動の指示です。台車 ${spell(o.e.cart)} を、${(o.e.data || {}).toName || spell(o.e.loc)} へ`);
}

// タグを1枚読むたびに呼ぶ: そろっていれば、自動なら登録・手動ならボタンを出す
function step(keepMsg) {
  const r = readyAction();
  if (r && r.dup) return dupStop(r.dup);
  if (r && F.auto) return register();
  renderPair();
  if (F.mode !== '置く') return;
  const keep = keepMsg && $('msg').classList.contains('pri');
  if (r && r.move) {
    beep('dup');
    msg(`<b>この部品はすでに ${esc(whereNow(r.move))} に登録されています</b>(${hms(r.move.at)} ${esc(r.move.by)})。<br>移し替えるなら「移し替えを登録」を押してください${r.ng.length ? '(計画と違うためエラーになります)' : ''}`, 'dup');
  } else if (r && !keep) {
    if (r.ng.length) msg(`<b>計画と違います</b>(赤いところ)。このまま「登録する」を押すとエラーになります。<br><span class="small">${ngText(r.ng).map(esc).join('<br>')}</span>`, 'warn');
    else msg(r.kind === 'place' ? `<b>3つそろいました。</b>計画どおりです。「登録する」を押してください` : `台車 <b>${esc(F.cart.code)}</b> を <b>${esc(F.loc.code)}</b> へ移動します。よければ「登録する」を押してください`, 'ok');
  } else if (!r && !keep) {
    const n = nextStep(); if (n) $('msg').innerHTML += `。${esc(n)}`;
  }
}
let LAST_NG = '';
function register(force, confirmMove) {
  const r = readyAction(); if (!r) return;
  if (r.dup) return dupStop(r.dup);
  if (r.ng.length && !force) return planError(r);
  if (r.move && F.auto && !confirmMove && !F.part.moveOk) return askMove(r, force);   // 自動でも、移し替えは確認してから
  return r.kind === 'place' ? link(r.ng) : moveCart(r.ng);
}
function planError(r) {   // 計画と違う: 登録せずにエラー。管理にも知らせる
  beep('ng'); flash('ng');
  const key = [r.kind, F.part && F.part.tag, F.cart.code, F.loc.code].join('|');
  if (key !== LAST_NG) {
    LAST_NG = key;
    const P = r.kind === 'place' ? F.part : {};
    send(newEvent('ng', { tag: P.tag || '', part: P.part || '', lot: P.lot || '', cart: F.cart.code, loc: F.loc.code, data: { kind: r.kind, reasons: ngText(r.ng), cart: F.cart.code } }));
  }
  const bc = r.ng.find(x => x.k === '台車'), bl = r.ng.find(x => x.k === '置き場所');
  const what = bc && bl ? '台車と置き場所' : bc ? '台車' : '置き場所';
  // エラーのもとになった台車・置き場所の固定を解除する(部品は残す)。正しいタグを読めばそのまま続けられる
  BADSET = { cart: F.cart, loc: F.loc, kind: r.kind };
  if (bc) F.cart = null;
  if (bl) F.loc = null;
  F.moveCand = false; LAST_NG = '';
  renderPair();
  const freed = [bc && `台車 ${esc(bc.got)}`, bl && `置き場所 ${esc(bl.got)}`].filter(Boolean).join(' と ');
  const rows = [];
  if (bc) rows.push(['正しい台車', '○ ' + esc(bc.want.join('・')), 'ok'], ['読んだ台車', '✕ ' + esc(bc.got), 'bad']);
  if (bl) rows.push(['正しい置き場所', '○ ' + esc(bl.want.join('・')), 'ok'], ['読んだ置き場所', '✕ ' + esc(bl.got), 'bad']);
  sheet('ng', '✕', r.kind === 'cart' ? 'この台車は、ここに置けません' : `${what}がちがいます`, rows,
    `<b>登録していません。</b>まちがえた${freed}の固定を<b>解除しました</b>。正しい${what}のタグを読んでください${r.kind === 'place' ? `<div class="sh-sub">部品: <b class="mono">${esc(F.part.part)}</b> ${esc(partName(F.part))}${isPriPart(F.part) ? ' <span class="pri">優先品</span>' : ''}</div>` : ''}`,
    `<div class="sh-btns"><button class="btn sh-alt" onclick="closeSheet();forceOff()">計画外として、このまま登録する</button></div>`);
  say(`エラーです。${what}がちがいます。固定を解除しました。` + (bc ? `台車は ${spell(bc.want[0])}。` : '') + (bl ? `置き場所は ${spell(bl.want[0])} です。` : ''));
  msg(`✕ <b>エラー: ${what}がちがいます</b>(登録していません)。${freed}の固定を解除しました`, 'ng');
}
let BADSET = null;
function forceOff() {   // 計画外として登録: 解除した台車・置き場所を戻してから登録する
  if (!BADSET) return;
  F.cart = BADSET.cart; F.loc = BADSET.loc; if (BADSET.kind === 'cart') F.moveCand = true;
  BADSET = null; register(true, true);
}
// 同じ部品を、同じ台車・置き場所にもう一度読んだ: 送らない
function dupStop(prev) {
  const P = F.part, pri = isPriPart(P);
  const C = F.cart, L = F.loc;
  const canMove = C && L && !(prev.cart === C.code && (CARTLOC[C.code] || prev.loc) === L.code);   // 固定中の台車・置き場所が今の場所と違う
  RECENT.unshift({ ev: { type: 'dup', at: now(), part: P.part, tag: P.tag, cart: prev.cart, loc: CARTLOC[prev.cart] || prev.loc, data: {} }, state: 'skip' }); renderRecent();
  beep('dup'); flash('dup');
  const rows = [['部品', `<span class="mono">${esc(P.part)}</span>${pri ? ' <span class="pri">優先</span>' : ''}`], ['いまの場所', esc(whereNow(prev)), 'ok']];
  const note = 'この部品は<b>登録済み</b>です。今回は記録していません。<b>数は増えていません。</b>';
  clearTimeout(MOVE_T);
  if (canMove) {   // 移し替えの可能性: 部品は保留しておき、ボタンを押したときだけ移す(押さなければ8秒で取りやめ)
    const hold = F.part = { ...P, moveAsk: true };
    rows.push(['移す先', `${esc(C.code)}(${esc(L.code)})`]);
    sheet('dup', '✓', '二重読み取りです', rows, note + '<br>本当に移すときだけ、下のボタンを押してください。',
      `<div class="sh-btns"><button class="btn sh-main" onclick="closeSheet();moveIt()">${esc(C.code)}(${esc(L.code)})へ移し替える</button></div>`, 8000);
    MOVE_T = setTimeout(() => { if (F.part === hold) { F.part = { ...P, done: true, ctx: ctx(), dup: true }; renderPair(); } }, 8000);
  } else {
    F.part = { ...P, done: true, ctx: ctx(), dup: true };
    sheet('dup', '✓', '二重読み取りです', rows, note, '', 6000);
  }
  renderPair();
  say('二重読み取りです。登録済みなので、数は増えていません');
  msg(`✓ <b>二重読み取り</b>: <b class="mono">${esc(P.part)}</b> は登録済み(${esc(whereNow(prev))})。数は増えていません`, 'dup');
}
function moveIt() { if (!pending()) return; clearTimeout(MOVE_T); F.part.moveOk = true; register(false, true); }
// 別の台車・置き場所にすでに登録されている部品: 移し替えでよいか確認(数を二重に数えない)
function askMove(r, force) {
  beep('dup'); flash('dup'); renderPair();
  const P = F.part;
  sheet('dup', '?', '移し替えますか?', [['部品', `<span class="mono">${esc(P.part)}</span>`], ['いまの場所', esc(whereNow(r.move))], ['移す先', `${esc(F.cart.code)}(${esc(F.loc.code)})`, 'ok']],
    'この部品はすでに登録されています。押さなければ、移し替えはしません。', `<div class="sh-btns"><button class="btn sh-main" onclick="closeSheet();register(${force ? 'true' : 'false'}, true)">移し替える</button></div>`, 8000);
  say('この部品は登録済みです。移し替える場合は、ボタンを押してください');
  msg(`<b>この部品はすでに登録されています</b><br><b class="mono">${esc(P.part)}</b>(${esc(P.tag)})は <b>${esc(whereNow(r.move))}</b> に登録済み(${hms(r.move.at)} ${esc(r.move.by)})。<br>
    <b>${esc(F.cart.code)}(${esc(F.loc.code)})</b> へ移し替えますか?<div class="ngact"><button class="btn mv" onclick="register(${force ? 'true' : 'false'}, true)">移し替える</button><span class="small autoclose">押さなければ8秒で取りやめ<i class="bar" style="animation-duration:8s"></i></span></div>`, 'dup');
  clearTimeout(MOVE_T);
  MOVE_T = setTimeout(() => { if (F.part === P && pending()) { F.part = null; renderPair(); msg('移し替えはしませんでした(登録していません)'); } }, 8000);
}
let MOVE_T = 0;
function linkedFx() { const el = $('pair'); el.classList.remove('linked'); void el.offsetWidth; el.classList.add('linked'); }
function link(ng = []) {
  const P = F.part, C = F.cart, L = F.loc, pri = isPriPart(P);
  const offPlan = ngText(ng).join(' / ');
  const prev = PLACED[P.tag], from = prev ? whereNow(prev) : '';
  const ev = newEvent('place', { tag: P.tag, part: P.part, lot: P.lot, loc: L.code, cart: C.code, data: { pri, cart: C.code, cartPz: C.pz, locType: L.type, pz: L.pz, offPlan, from } });
  send(ev); LAST_NG = '';
  F.part = { ...P, done: true, ctx: ctx() }; renderPair(); linkedFx();
  const where = `<b>${esc(C.code)}</b>(${esc(L.code)})`;
  if (offPlan) { beep('pri'); flash('ng'); say('計画外として登録しました'); return msg(`<b class="mono">${esc(P.part)}</b> → ${where} を<b>計画外として</b>登録しました`, 'warn'); }
  if (pri && !C.pz && !L.pz) { beep('pri'); flash('pri'); say('登録しました。優先品です。優先の台車へ移してください'); return msg(`<b>${esc(P.part)}</b> を ${where} に載せました。<b>優先品です。優先台車か優先置き場へ移してください</b>`, 'pri'); }
  beep('link'); flash('ok');
  say(from ? '移し替えました' : '登録しました');
  msg(`<b class="mono">${esc(P.part)}</b> → ${where} に${from ? `移し替えました(${esc(from)} から)` : '登録しました'}${!pri && (C.pz || L.pz) ? '(通常品を優先の台車・置き場に置いています)' : ''}`, 'ok');
}
function moveCart(ng = []) {   // 部品なしで 台車 → 置き場所: 台車ごと移動
  const C = F.cart, L = F.loc, offPlan = ngText(ng).join(' / ');
  send(newEvent('cart', { loc: L.code, cart: C.code, data: { cart: C.code, cartPz: C.pz, locType: L.type, pz: L.pz, offPlan } }));
  F.moveCand = false; LAST_NG = '';
  if (F.part) F.part = null;
  renderPair(); linkedFx(); beep('link'); flash('ok'); say('台車ごと移動しました');
  msg(`台車 <b>${esc(C.code)}</b> を <b>${esc(L.code)}</b> に${offPlan ? '<b>計画外として</b>' : ''}移動しました(載っている部品もいっしょに移動)`, offPlan ? 'warn' : 'ok');
}
function manualIn() { const v = $('manual').value.trim(); $('manual').value = ''; if (v) onCode(v, 'manual'); }

/* ---------------- 送信(結果だけをスプレッドシートへ) ---------------- */
function send(ev) {
  applyEv(ev);
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
    const what = e.type === 'place' && !e.cart ? `<b class="mono">${esc(e.part)}</b> を <b>${esc(e.loc)}</b> に置いた` : e.type === 'place' ? `<b class="mono">${esc(e.part)}</b> → <b>${esc(e.cart || '')}</b> <span class="mute">@</span> <b>${esc(e.loc)}</b>` : e.type === 'cart' ? `台車 <b>${esc(e.cart)}</b> を <b>${esc(e.loc)}</b> へ` : e.type === 'dup' ? `<span class="dupt">登録済みのため記録せず</span> <b class="mono">${esc(e.part)}</b>${e.cart ? ` (${esc(e.cart)} @ ${esc(e.loc)})` : d.to ? ` (${esc(d.to)})` : ''}` : e.type === 'ng' ? `<span class="ngt">計画外を検知(未登録)</span> ${esc(e.part || '台車 ' + e.cart)} → ${esc(e.cart)} @ ${esc(e.loc)}` : e.type === 'status' ? `<b class="mono">${esc(e.part)}</b> を <span class="st st-${esc(d.to)}">${esc(d.to)}</span>${d.reason ? `(${esc(d.reason)})` : ''}${e.loc ? ` @ ${esc(e.loc)}` : ''}` : e.type === 'ack' && d.order ? `指示を開始: 台車 ${esc(e.cart)} → ${esc(e.loc)}` : e.type === 'ack' ? 'アラートを確認' : esc(e.type);
    const st = r.state === 'skip' ? '<span class="skip">数は増えていません</span>' : r.state === 'sent' ? `<span class="sent">✓ 共有 ${(r.ms / 1000).toFixed(1)}秒 ・ ${r.bytes || ''}B</span>` : r.state === 'sending' ? '<span class="sending">送信中…</span>' : '<span class="queued">送信待ち(端末に保存)</span>';
    return `<div class="rc ${d.pri ? 'p' : ''} ${e.type === 'ng' || d.offPlan ? 'n' : ''}"><span class="t">${hms(e.at)}</span><span class="w">${what}${d.pri ? ' <span class="pri">優先</span>' : ''}${d.offPlan ? ' <span class="pri">計画外</span>' : ''}</span>${st}</div>`;
  }).join('') || '<div class="mute small">まだ操作はありません</div>';
}
function renderNet() {
  const el = $('net'); if (!el) return;
  const q = OUTBOX.length;
  const st = !tokenValid() ? ['warn', 'ログインが必要'] : !NET.online ? ['bad', 'オフライン'] : q ? ['warn', `送信待ち ${q}`] : ['on', '接続中'];
  el.innerHTML = `${esc(DEVICE.name)} ・ <i class="dot ${st[0]}"></i>${st[1]}${!tokenValid() ? ' <button class="btn" onclick="login()">ログイン</button>' : ''}`;
  const np = Object.keys(MAST.plans || {}).length;
  const si = $('sendinfo'); if (si) si.innerHTML = `${np ? `計画 ${np}件` : '<b style="color:var(--warn)">計画 未設定(チェックしません)</b>'}${NET.lastSendMs ? ` ・ 直近の送信 ${(NET.lastSendMs / 1000).toFixed(1)}秒` : ''}`;
}

/* ---------------- 管理(PC)からのアラートを受け取る ---------------- */
async function poll(first) {
  if (!tokenValid()) return renderNet();
  try {
    const { first, rows } = await readEventsSince(LASTROW + 1);
    if (FIRSTID && first !== FIRSTID) { FIRSTID = first; return demoReset(); }   // 管理画面でデモがリセットされた
    FIRSTID = first;
    rows.forEach((r, i) => {
      if (!r[0]) return;
      const e = rowEvent(r, LASTROW + 1 + i);
      const isNewOrder = e.type === 'order' && !ORDERS[e.id] && !first;
      applyEv(e);
      if (isNewOrder) newOrder(ORDERS[e.id]);
      if (e.type === 'alert') {
        ALERT_PRI[e.part] = true;
        const fresh = !ACKED.has(e.id) && e.device !== DEVICE.name && (Date.now() - (e.data.t || 0) < 30 * 60 * 1000);
        if (fresh) showAlert(e, first);
      }
      if (e.type === 'ack' && e.device === DEVICE.name) ACKED.add(e.data.alert);
    });
    LASTROW += rows.length; renderPair(); renderOrders();
  } catch (e) { }
  renderNet();
}
let FIRSTID = '';
// 管理画面で「デモをリセット」されたら、この端末の記録・固定もはじめからにする
function demoReset() {
  const t0 = Date.now();
  for (const o of [PLACED, CARTLOC, STAT, ALERT_PRI, HOLDR, ORDERS]) for (const k of Object.keys(o)) delete o[k];
  F.desk = null; F.holdPending = null; F.inspWait = null; renderOrders(); PREV_HOLD = null;
  APPLIED.clear(); LASTROW = 1; RECENT = []; ALERTQ.length = 0; renderAlert();
  OUTBOX = OUTBOX.filter(e => e.type === 'hello' ? false : (e.data.t || 0) > t0); lsSet('bi_outbox', JSON.stringify(OUTBOX));
  Object.assign(F, { part: null, cart: null, loc: null, moveCand: false }); CAND = null; renderCand();
  renderPair(); renderRecent(); refreshMasters();
  beep('link'); closeSheet(); say('デモがリセットされました'); msg('<b>管理画面でデモがリセットされました。</b>はじめから登録できます', 'ok');
  setTimeout(() => poll(), 300);
}
const ALERTQ = [];
function showAlert(e) {
  if (ALERTQ.find(a => a.id === e.id)) return;
  ALERTQ.push(e); beep('pri'); renderAlert(); say('管理から、優先のお知らせです。' + ((e.data || {}).name || ''));
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
  pickVoice(); say('スキャンを始めます');
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
/* カメラが読んだQRはすぐには使わない:
   ① 枠の中で2回続けて読めたら「候補カード」を出す
   ② カードをタップしたときに初めて確定(台車・置き場所の固定や、登録はそのあと)
   ③ タップしなければ4秒で自動的に消える(取消ボタンは押さなくてよい) */
async function decodeFrame(src, w, h) {
  if (DETECTOR) {
    try { const r = await DETECTOR.detect(src); if (r.length) { const b = r[0].boundingBox; return { text: r[0].rawValue, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; } } catch (e) { }
  }
  const c = $('cv'); const sc = Math.min(1, 720 / Math.max(w, h)); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, c.width, c.height);
  const q = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
  if (!q) return null;
  const L = q.location, cx = (L.topLeftCorner.x + L.bottomRightCorner.x) / 2 / sc, cy = (L.topLeftCorner.y + L.bottomRightCorner.y) / 2 / sc;
  return { text: q.data, cx, cy };
}
function inFrame(v, d) {   // 画面の白い枠の中に写っているか(となりのタグを拾わない)
  const box = $('cam'), w = box.clientWidth, h = box.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
  const scale = Math.max(w / vw, h / vh), half = Math.min(.58 * w, .84 * h) / scale * .6;
  return Math.abs(d.cx - vw / 2) < half && Math.abs(d.cy - vh / 2) < half;
}
let LASTDET = { text: '', n: 0 }, CAND = null, CAND_T = 0;
const QUIET = {};   // タップしなかった・確定したタグを、しばらく出し直さない
function worthIt(t) {   // 読んでも何も変わらないタグは候補にしない
  if (!t) return false;
  if (F.mode === '置く') {
    if (t.kind === 'cart' && F.cart && F.cart.code === t.code) return false;
    if (t.kind === 'loc' && F.loc && F.loc.code === t.code) return false;
    if (t.kind === 'part' && F.part && F.part.tag === t.tag && (pending() || F.part.ctx === ctx())) return false;
  } else if (t.kind === 'part' && F.part && F.part.tag === t.tag && F.part.ctx === ctx()) return false;
  if (F.mode === '検査' && t.kind === 'loc' && F.desk && F.desk.code === t.code && !F.holdPending) return false;
  return true;
}
function detected(text) {
  const nowT = Date.now();
  if (QUIET[text] && nowT < QUIET[text]) return;
  if (CAND && CAND.text === text) return;
  if (CAND && nowT - CAND.at < 1200) return;   // 出したばかりのカードはすぐには入れ替えない
  const t = parseTag(text); if (!worthIt(t)) return;
  CAND = { text, t, at: nowT }; beep('tick'); closeSheet(); renderCand();   // 次のタグに向けたら、お知らせ画面は閉じる
  clearTimeout(CAND_T); CAND_T = setTimeout(() => { if (CAND && CAND.text === text) { QUIET[text] = Date.now() + 3000; CAND = null; renderCand(); } }, 4000);
}
function renderCand() {
  const el = $('candwrap'); if (!el) return;
  if (!CAND) { el.innerHTML = ''; return; }
  const t = CAND.t;
  const lab = t.kind === 'part' ? '① 部品タグ' : t.kind === 'cart' ? '② 台車タグ' : '③ 置き場所タグ';
  const v = t.kind === 'part' ? t.part : t.code;
  const sub = t.kind === 'part' ? `${(MAST.tags[t.tag] || {}).name || ''} ・ ${t.tag}` : t.kind === 'cart' ? ((MAST.carts[t.code] || {}).name || '台車') : `${t.type} ${(MAST.locs[t.code] || {}).name || ''}`;
  const pri = t.kind === 'part' ? isPriPart(t) : t.pz;
  const reg = t.kind === 'part' && PLACED[t.tag];
  el.innerHTML = `<button class="cand k-${t.kind} ${pri ? 'pri' : ''}" onclick="confirmCand()">
    <span class="cd-k">${lab}${pri ? ' <b>優先</b>' : ''}${reg ? ` <span class="cd-reg">二重読み取り(登録済み: ${esc(whereNow(reg))})</span>` : ''}</span><span class="cd-v mono">${esc(v)}</span><span class="cd-s">${esc(sub)}</span>
    <span class="cd-tap">タップで確定</span><i class="bar"></i></button>`;
}
function confirmCand() {
  const c = CAND; if (!c) return;
  CAND = null; clearTimeout(CAND_T); renderCand(); closeSheet();
  QUIET[c.text] = Date.now() + 2500;
  onCode(c.text, 'tap');
}
async function scanLoop() {
  const v = $('video');
  if (v && v.readyState >= 2 && !ALERTQ.length) {
    try {
      const d = await decodeFrame(v, v.videoWidth, v.videoHeight);
      if (d && d.text && inFrame(v, d)) {
        LASTDET = LASTDET.text === d.text ? { text: d.text, n: LASTDET.n + 1 } : { text: d.text, n: 1 };
        if (LASTDET.n >= 2) detected(d.text);   // 2回続けて同じものが読めたときだけ
      } else LASTDET = { text: '', n: 0 };
    } catch (e) { }
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
