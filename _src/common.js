/* =====================================================================
   受入・検査品管理(タグ版)— 現場アプリと管理アプリの共通部分
   - データは共有のGoogleスプレッドシートに「出来事(イベント)」として追記していく
     (行を書き換えないので、何台の端末が同時に書いても競合しない)
   - 読み書きはログインしたGoogleアカウントの権限で行う。シートを共有された人しか使えない
   ===================================================================== */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 2) => String(n).padStart(w, '0');
function now(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const hms = s => String(s || '').slice(11, 19);
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
function toast(msg, bad) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 3200);
}
function dialog(html, buttons) {
  return new Promise(ok => {
    const d = document.createElement('div'); d.className = 'dlg-back';
    d.innerHTML = `<div class="dlg" role="dialog">${html}<div class="row end">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    document.body.appendChild(d);
    const inp = d.querySelector('input'); if (inp) { inp.focus(); inp.select(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(buttons.findIndex(b => b.ok)); }); }
    const done = i => { const v = inp ? inp.value : null; d.remove(); ok({ i, v }); };
    d.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => done(+b.dataset.i));
  });
}
async function ask(msg, okLabel = 'はい', danger = false) { return (await dialog(`<div class="dlg-msg">${esc(msg)}</div>`, [{ label: 'やめる' }, { label: okLabel, cls: danger ? 'danger' : 'primary', ok: true }])).i === 1; }
async function askText(msg, value = '') {
  const r = await dialog(`<div class="dlg-msg">${esc(msg)}</div><input type="text" id="dlg-in" value="${esc(value)}">`, [{ label: 'やめる' }, { label: 'OK', cls: 'primary', ok: true }]);
  return r.i === 1 ? r.v : null;
}
let AUDIO = null;
function beep(kind = 'ok') {   // ok: 短い高音 / pri: 2回 / ng: 低音
  try {
    AUDIO = AUDIO || new AudioContext();
    const tones = kind === 'ok' ? [[1046, .07]] : kind === 'link' ? [[880, .06], [1318, .09]] : kind === 'pri' ? [[1568, .1], [0, .05], [1568, .1], [0, .05], [1568, .14]] : [[220, .3]];
    let t = AUDIO.currentTime;
    for (const [f, d] of tones) { if (f) { const o = AUDIO.createOscillator(), g = AUDIO.createGain(); o.frequency.value = f; g.gain.value = .18; o.connect(g); g.connect(AUDIO.destination); o.start(t); o.stop(t + d); } t += d; }
  } catch (e) { }
  try { navigator.vibrate && navigator.vibrate(kind === 'pri' ? [120, 60, 120, 60, 200] : kind === 'ng' ? 300 : 40); } catch (e) { }
}

/* ---------------- 設定(スプレッドシートとログイン用ID) ----------------
   リポジトリには何も書かず、管理画面で入力した値を端末に保存する。
   スマホへは管理画面の「端末を追加」QR(URLに含める)で渡す。これらの値は秘密ではない(権限はGoogle側で管理)。 */
const CONF = (() => {
  const c = { ...(window.BI_CONFIG || {}) };
  const u = new URLSearchParams(location.search);
  let changed = false;
  for (const [k, q] of [['clientId', 'c'], ['sheetId', 's']]) { const v = u.get(q); if (v) { lsSet('bi_' + k, v); changed = true; } c[k] = c[k] || lsGet('bi_' + k) || ''; }
  if (changed) history.replaceState(null, '', location.pathname + location.hash);
  return c;
})();
function saveConf(clientId, sheetId) { lsSet('bi_clientId', clientId); lsSet('bi_sheetId', sheetId); CONF.clientId = clientId; CONF.sheetId = sheetId; }
const sheetIdFrom = s => { const m = String(s).match(/\/d\/([A-Za-z0-9_-]{20,})/); return m ? m[1] : String(s).trim(); };
const API = () => (CONF.apiBase ?? 'https://sheets.googleapis.com') + '/v4/spreadsheets/' + encodeURIComponent(CONF.sheetId);

/* ---------------- Googleログイン ---------------- */
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets openid email profile';
let TOKEN = null, ACCOUNT = { email: '', name: '' }, TOKEN_CLIENT = null, ON_LOGIN = null;
const tokenValid = () => !!(TOKEN && Date.now() < TOKEN.exp);
function restoreLogin() {
  try { const t = JSON.parse(sessionStorage.getItem('bi_tok') || 'null'); if (t && Date.now() < t.exp) TOKEN = t; } catch (e) { }
  try { ACCOUNT = JSON.parse(lsGet('bi_account') || '{"email":"","name":""}'); } catch (e) { }
}
function login() {
  if (!CONF.clientId || !CONF.sheetId) return LOGIN_UI.msg('設定が未完了です。');
  if (!window.google || !google.accounts || !google.accounts.oauth2) return LOGIN_UI.msg('Googleのログイン部品を読み込めませんでした。通信を確認して、もう一度開いてください。');
  if (!TOKEN_CLIENT) TOKEN_CLIENT = google.accounts.oauth2.initTokenClient({ client_id: CONF.clientId, scope: SCOPES, callback: onToken,
    error_callback: e => LOGIN_UI.msg(e && e.type === 'popup_failed_to_open' ? 'Googleのログイン画面を開けませんでした。ブラウザでこのサイトのポップアップを許可してください。' : 'ログインを中止しました') });
  // 前回スプレッドシートの許可が足りなかったときは、許可画面を必ず出す
  const again = lsGet('bi_need_consent') === '1';
  TOKEN_CLIENT.requestAccessToken({ prompt: again ? 'consent' : (ACCOUNT.email ? '' : 'select_account'), hint: ACCOUNT.email || undefined });
}
async function onToken(resp) {
  if (!resp || resp.error || !resp.access_token) return LOGIN_UI.msg('ログインできませんでした' + (resp && resp.error ? `(${resp.error})` : ''));
  // 許可画面でスプレッドシートのチェックが外れていた場合
  if (resp.scope && !String(resp.scope).includes('auth/spreadsheets')) {
    lsSet('bi_need_consent', '1');
    return LOGIN_UI.msg('Googleの許可画面で「スプレッドシート」の項目にチェックが入っていませんでした。もう一度「Googleでログイン」を押し、許可画面で「すべて選択」してから「続行」を押してください。');
  }
  lsSet('bi_need_consent', '');
  TOKEN = { t: resp.access_token, exp: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
  try { sessionStorage.setItem('bi_tok', JSON.stringify(TOKEN)); } catch (e) { }
  try {
    const u = await (await fetch(CONF.userinfoUrl || 'https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + TOKEN.t } })).json();
    ACCOUNT = { email: u.email || '', name: u.name || (u.email || '').split('@')[0] }; lsSet('bi_account', JSON.stringify(ACCOUNT));
  } catch (e) { }
  try { await ensureTabs(); }
  catch (e) {
    TOKEN = null; try { sessionStorage.removeItem('bi_tok'); } catch (x) { } lsSet('bi_authorized', '');
    const why = e.detail ? `\n(Googleからの理由: ${e.detail})` : '';
    if (e instanceof NoAccess && /insufficient|scope/i.test(e.detail || '')) { lsSet('bi_need_consent', '1'); return LOGIN_UI.msg('スプレッドシートへのアクセスが許可されていません。もう一度「Googleでログイン」を押し、許可画面で「すべて選択」してから「続行」を押してください。' + why); }
    if (e instanceof NoAccess && /has not been used|disabled/i.test(e.detail || '')) return LOGIN_UI.msg('Google Cloud で Google Sheets API が有効になっていません。' + why);
    if (e instanceof NoAccess && e.status === 404) return LOGIN_UI.msg('スプレッドシートが見つかりません。設定したスプレッドシートのURLを確認してください。' + why);
    return LOGIN_UI.msg(e instanceof NoAccess ? `${ACCOUNT.email} には、このアプリのデータを使う権限がありません。管理者にスプレッドシートの共有を依頼してください。${why}` : 'Googleにつながりませんでした: ' + e.message);
  }
  lsSet('bi_authorized', ACCOUNT.email);
  ON_LOGIN && ON_LOGIN();
}
function logout() {
  try { TOKEN && google.accounts.oauth2.revoke(TOKEN.t, () => { }); } catch (e) { }
  TOKEN = null; try { sessionStorage.removeItem('bi_tok'); } catch (e) { }
  ['bi_authorized', 'bi_account', 'bi_outbox', 'bi_cache'].forEach(k => lsSet(k, ''));
  location.reload();
}
// 許可されたアカウントでログインするまでは、この画面しか出さない
const LOGIN_UI = {
  show(title, sub) {
    document.body.className = 'login-page';
    $('app').innerHTML = `<div class="login"><div class="lcard">
      <div class="lbrand">${esc(title)}</div><div class="lsub">${esc(sub)}</div>
      ${CONF.clientId && CONF.sheetId ? `<p>利用を許可されたGoogleアカウントでログインしてください。</p>
      <button class="btn primary big" onclick="login()">Googleでログイン</button>` : setupForm()}
      <div class="loginmsg" id="loginmsg"></div></div></div>`;
  },
  msg(m) { const el = $('loginmsg'); if (el) el.textContent = m; },
};
function setupForm() {   // 初回だけ: 管理者が自分のPCで入力する
  return `<p>最初の設定です(管理者のPCで一度だけ)。手順書で作った2つの値を入れてください。</p>
    <label class="fl">ログイン用クライアントID<input type="text" id="cf_c" placeholder="xxxxxxxx.apps.googleusercontent.com"></label>
    <label class="fl">スプレッドシートのURL<input type="text" id="cf_s" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
    <button class="btn primary big" onclick="saveConf($('cf_c').value.trim(), sheetIdFrom($('cf_s').value)); location.reload()">保存して次へ</button>`;
}
function installMockGIS() {   // 動作確認用(実際のGoogleの代わり)
  window.google = { accounts: { oauth2: {
    initTokenClient: o => ({ requestAccessToken: async () => { const em = await askText('(動作確認用)ログインするメールアドレス', ACCOUNT.email || 'taiyo@example.com'); if (em) o.callback({ access_token: 'mock:' + em, expires_in: 3600 }); } }),
    revoke: () => { } } } };
}

/* ---------------- スプレッドシート ---------------- */
class NoAccess extends Error { }
class NeedLogin extends Error { }
const NET = { online: true, lastOk: 0, backoff: 0, calls: 0 };
async function gapi(path, opt = {}) {
  if (!tokenValid()) throw new NeedLogin('ログインが必要です');
  if (Date.now() < NET.backoff) throw new Error('混雑のため少し待っています');
  let r;
  try { r = await fetch(API() + path, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + TOKEN.t, 'Content-Type': 'application/json' } }); }
  catch (e) { NET.online = false; throw e; }
  NET.calls++;
  if (r.status === 429) { NET.backoff = Date.now() + 15000; throw new Error('Googleの利用回数の上限に近いため、少し待ちます'); }
  if (r.status === 401) { TOKEN = null; try { sessionStorage.removeItem('bi_tok'); } catch (e) { } throw new NeedLogin('ログインし直してください'); }
  if (r.status === 403 || r.status === 404) {
    let detail = ''; try { const j = await r.json(); detail = (j.error && (j.error.message || j.error.status)) || ''; } catch (e) { }
    const err = new NoAccess('権限がありません'); err.status = r.status; err.detail = detail; throw err;
  }
  if (!r.ok) { NET.online = false; throw new Error(`Googleの応答エラー(${r.status})`); }
  NET.online = true; NET.lastOk = Date.now();
  return r.json();
}
const TABS = {
  events: { title: 'イベント', cols: ['ID', '日時', '端末', 'アカウント', '種類', 'タグ', '品番', 'ロット', '場所', '内容', '台車'] },
  tags: { title: 'タグ', cols: ['タグ', '品番', '品名', 'ロット', '数量', '優先', '発行日時'] },
  locs: { title: '置き場所', cols: ['コード', '種別', '名称', '優先置き場'] },
  carts: { title: '台車', cols: ['台車番号', '名称', '優先台車'] },
  plans: { title: '計画', cols: ['品番', '台車', '置き場所', 'メモ'] },
};
const colLetter = n => String.fromCharCode(65 + n - 1);
const rng = (tab, from = 2, to = '') => `'${TABS[tab].title}'!A${from}:${colLetter(TABS[tab].cols.length)}${to}`;
async function ensureTabs() {
  const meta = await gapi('?fields=sheets.properties.title');
  const have = new Set((meta.sheets || []).map(s => s.properties.title));
  const missing = Object.values(TABS).filter(t => !have.has(t.title));
  if (have.has(TABS.events.title))   // 列を追加したときのために、イベントの見出し行をそろえる
    await gapi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: [{ range: `'${TABS.events.title}'!A1`, values: [TABS.events.cols] }] }) });
  if (!missing.length) return;
  await gapi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map(t => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })) }) });
  await gapi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: missing.map(t => ({ range: `'${t.title}'!A1`, values: [t.cols] })) }) });
}
async function appendRows(tab, rows) {
  const r = await gapi(`/values/${encodeURIComponent(rng(tab, 1))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: rows }) });
  const m = ((r.updates || {}).updatedRange || '').match(/![A-Z]+(\d+)/);
  return m ? +m[1] : 0;
}
async function readRows(tab, from = 2) {
  const r = await gapi(`/values/${encodeURIComponent(rng(tab, from))}?valueRenderOption=FORMATTED_VALUE`);
  return (r.values || []);
}
async function readMasters(retry = true) {
  const qs = ['tags', 'locs', 'carts', 'plans'].map(t => 'ranges=' + encodeURIComponent(rng(t))).join('&');
  let r;
  try { r = await gapi(`/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`); }
  catch (e) {   // 以前の版で作ったスプレッドシートには「台車」の表がないので、作ってから読み直す
    if (!retry || e instanceof NeedLogin || e instanceof NoAccess) throw e;
    await ensureTabs(); NET.online = true; return readMasters(false);
  }
  const [tv, lv, cv, pv] = (r.valueRanges || []).map(v => v.values || []);
  const plans = {};   // 品番ごと。同じ品番が何行かあれば、下の行(あとで入れたもの)を使う
  (pv || []).filter(r => r[0]).forEach(r => { plans[r[0]] = { part: r[0], carts: splitList(r[1]), locs: splitList(r[2]), memo: r[3] || '' }; });
  const locs = {}, carts = {};
  (lv || []).filter(r => r[0]).forEach(r => {
    // 以前の版で「置き場所(種別=台車)」として登録したものは、台車として扱う
    if (r[1] === '台車') carts[r[0]] = { code: r[0], name: r[2] || '', pz: r[3] === '○' };
    else locs[r[0]] = { code: r[0], type: r[1] || '', name: r[2] || '', pz: r[3] === '○' };
  });
  (cv || []).filter(r => r[0]).forEach(r => { carts[r[0]] = { code: r[0], name: r[1] || '', pz: r[2] === '○' }; });
  return {
    tags: Object.fromEntries((tv || []).filter(r => r[0]).map(r => [r[0], { tag: r[0], part: r[1] || '', name: r[2] || '', lot: r[3] || '', qty: r[4] || '', pri: r[5] === '優先', issued: r[6] || '' }])),
    locs, carts, plans,
  };
}

/* ---------------- 計画(どの品番を、どの台車・置き場所に置くか) ----------------
   台車・置き場所は「T-01/K-N」のように複数書ける。空欄はどこでもよい */
const splitList = v => String(v || '').split(/[\/・,、\s]+/).filter(Boolean);
function planNG(m, part, cart, loc) {
  const p = ((m && m.plans) || {})[part]; if (!p) return [];
  const r = [];
  if (cart && p.carts.length && !p.carts.includes(cart)) r.push({ k: '台車', want: p.carts, got: cart });
  if (loc && p.locs.length && !p.locs.includes(loc)) r.push({ k: '置き場所', want: p.locs, got: loc });
  return r;
}
function cartPlanLocs(m, cart) {   // その台車に載せる計画の部品の置き場所 = 台車を置いてよい場所
  const s = new Set(); Object.values((m && m.plans) || {}).forEach(p => { if (p.carts.includes(cart)) p.locs.forEach(l => s.add(l)); });
  return [...s];
}
function cartMoveNG(m, cart, loc) { const ls = cartPlanLocs(m, cart); return ls.length && !ls.includes(loc) ? [{ k: '置き場所', want: ls, got: loc }] : []; }
const ngText = ng => ng.map(x => `${x.k}: 読んだのは ${x.got} / 計画は ${x.want.join('・')}`);

/* ---------------- タグの形式(QRの中身) ----------------
   部品タグ: BI-T;ID=T0001;PN=IHF-30112-A;LOT=L2610-03;Q=12;P=1   (P=1 なら発行時点で優先)
   台車タグ: BI-C;ID=CP-01;PZ=1                                     (PZ=1 なら優先台車)
   場所タグ: BI-L;ID=K-P;K=INSP;PZ=1                                (PZ=1 なら優先置き場)
   タグだけで品番・優先・種類が分かるので、通信できない場所でも判定できる */
const LOC_KIND = { TEMP: '仮置き', INSP: '検査エリア', AREA: '置き場' };
const KIND_OF = Object.fromEntries(Object.entries(LOC_KIND).map(([k, v]) => [v, k]));
function parseTag(text) {
  const s = String(text || '').trim();
  const m = s.match(/^BI-([TLC]);(.*)$/); if (!m) return null;
  const f = Object.fromEntries(m[2].split(';').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (m[1] === 'T') return f.ID ? { kind: 'part', tag: f.ID, part: f.PN || '', lot: f.LOT || '', qty: f.Q || '', pri: f.P === '1' } : null;
  if (m[1] === 'C' || f.K === 'CART') return f.ID ? { kind: 'cart', code: f.ID, pz: f.PZ === '1' } : null;   // 以前の台車タグ(BI-L;K=CART)も台車として読む
  return f.ID ? { kind: 'loc', code: f.ID, type: LOC_KIND[f.K] || f.K || '', pz: f.PZ === '1' } : null;
}
const partQR = t => `BI-T;ID=${t.tag};PN=${t.part};LOT=${t.lot};Q=${t.qty};P=${t.pri ? 1 : 0}`;
const locQR = l => `BI-L;ID=${l.code};K=${KIND_OF[l.type] || 'AREA'};PZ=${l.pz ? 1 : 0}`;
const cartQR = c => `BI-C;ID=${c.code};PZ=${c.pz ? 1 : 0}`;
function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 1, scalable: true }); }

/* ---------------- イベント(出来事)と、いまの状態の組み立て ----------------
   種類: place(部品を台車に載せ、その台車が置き場所にある) / cart(台車ごと置き場所を移動) / status(検査済・保留・解除)
         alert(管理からの優先アラート) / ack(現場の受信確認) / hello(端末の起動・生存) */
const STATUSES = ['未受入', '未検査', '検査済', '保留'];
const HOLD_REASONS = ['数量違い', '不良疑い', '書類不備', 'その他'];
function eventRow(e) { return [e.id, e.at, e.device, e.account, e.type, e.tag || '', e.part || '', e.lot || '', e.loc || '', JSON.stringify(e.data || {}), e.cart || '']; }
function rowEvent(r, rowNo) {
  let data = {}; try { data = JSON.parse(r[9] || '{}'); } catch (e) { }
  return { id: r[0], at: r[1], device: r[2], account: r[3], type: r[4], tag: r[5], part: r[6], lot: r[7], loc: r[8], data, cart: r[10] || data.cart || '', row: rowNo, bytes: (r.join('').length + 20) };
}
function newEvent(type, f = {}) {
  return { id: 'E' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), at: now(), device: DEVICE.name, account: ACCOUNT.email, type, ...f, data: { t: Date.now(), ...(f.data || {}) } };
}
function buildState(masters, events) {
  const items = {}, carts = {};
  const item = (tag, e) => items[tag] || (items[tag] = { tag, part: (e && e.part) || '', name: '', lot: (e && e.lot) || '', qty: '', pri: false, priSrc: '', status: '未受入', prev: '', hold: '', cart: '', direct: '', loc: '', since: '', by: '', hist: [], offPlan: '' });
  const cart = code => carts[code] || (carts[code] = { code, name: ((masters.carts || {})[code] || {}).name || '', pz: !!((masters.carts || {})[code] || {}).pz, loc: '', since: '', by: '' });
  for (const t of Object.values(masters.tags)) Object.assign(item(t.tag), { part: t.part, name: t.name, lot: t.lot, qty: t.qty, pri: t.pri, priSrc: t.pri ? 'タグ' : '' });
  for (const c of Object.keys(masters.carts || {})) cart(c);
  const alerts = [], devices = {};
  for (const e of events) {
    const d = devices[e.device] || (devices[e.device] = { name: e.device, account: e.account, last: '', lastT: 0, n: 0 });
    d.last = e.at; d.lastT = e.data.t || 0; d.n++; if (e.type === 'hello') d.info = e.data;
    if (e.type === 'place') {
      const it = item(e.tag, e);
      if (it.status === '未受入') it.status = '未検査';
      // 以前の版の記録(台車を置き場所として読んだもの)は、台車に載せたことにする
      const cc = e.cart || ((masters.carts || {})[e.loc] ? e.loc : '');
      if (cc) { it.cart = cc; it.direct = ''; if (e.cart) Object.assign(cart(cc), { loc: e.loc, since: e.at, by: e.device }); }
      else { it.cart = ''; it.direct = e.loc; }
      it.since = e.at; it.by = e.device; it.offPlan = e.data.offPlan || '';
      if (e.data.pri && !it.pri) { it.pri = true; it.priSrc = 'タグ'; }
      it.hist.push(e);
    } else if (e.type === 'cart') {
      Object.assign(cart(e.cart), { loc: e.loc, since: e.at, by: e.device });
      for (const it of Object.values(items)) if (it.cart === e.cart) it.hist.push(e);
    } else if (e.type === 'status') {
      const it = item(e.tag, e), to = e.data.to;
      if (to === '保留') { it.prev = it.status === '保留' ? it.prev : it.status; it.status = '保留'; it.hold = e.data.reason || ''; }
      else if (to === '解除') { it.status = it.prev || '未検査'; it.hold = ''; }
      else it.status = to;
      if (it.status === '未受入') it.status = '未検査';
      it.hist.push(e);
    } else if (e.type === 'ng') {   // 計画と違う置き方を現場が検知(登録はしていない)
      if (e.tag) item(e.tag, e).hist.push(e);
    } else if (e.type === 'alert') {
      alerts.push({ ...e, acks: [] });
      for (const it of Object.values(items)) if (it.part === e.part || it.tag === e.tag) { it.pri = true; it.priSrc = 'アラート'; it.hist.push(e); }
    } else if (e.type === 'ack') {
      const a = alerts.find(x => x.id === e.data.alert); if (a) a.acks.push(e);
    }
  }
  // 部品のいまの場所 = 載っている台車の置き場所(台車がなければ直接置いた場所)
  for (const it of Object.values(items)) it.loc = it.cart ? (carts[it.cart] || {}).loc || '' : it.direct;
  return { items, carts, alerts, devices };
}

/* ---------------- 端末の名前 ---------------- */
const DEVICE = { name: lsGet('bi_dev_name') || '' };
async function ensureDeviceName(def) {
  if (DEVICE.name) return;
  const n = await askText('この端末の名前(管理画面の一覧に出ます)', def);
  DEVICE.name = (n || '').trim() || def; lsSet('bi_dev_name', DEVICE.name);
}
