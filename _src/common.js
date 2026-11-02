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
function beep(kind = 'ok') {   // 驚かせない、やわらかいチャイムの音(立ち上がり・消え方をなめらかに)
  // [音の高さ(Hz), 鳴らし始め(秒), 長さ(秒)]。0.1 秒くらいずつ、ずらして重ねる
  const S = {
    tick: [[1175, 0, .08]],                                   // 候補が出た: ごく小さく「ぽ」
    ok: [[880, 0, .25]],                                      // 読んだ: 「ぽん」
    link: [[659, 0, .3], [988, .1, .4]],                      // 登録できた: 「ぽろん」(上がる)
    dup: [[784, 0, .3], [659, .14, .4]],                      // 登録済み: 「ぽろん」(下がる)
    pri: [[784, 0, .45], [988, .16, .45], [1175, .32, .6]],   // 優先・お知らせ: 駅のチャイムのような3音
    ng: [[523, 0, .4], [440, .18, .55]],                      // 止まる: 低めの2音(ブザーにしない)
  }[kind] || [[523, 0, .4], [440, .18, .55]];
  const vol = kind === 'tick' ? .035 : kind === 'ok' ? .07 : .09;
  try {
    AUDIO = AUDIO || new AudioContext();
    if (AUDIO.state === 'suspended') AUDIO.resume();
    const t0 = AUDIO.currentTime + .01;
    for (const [f, at, d] of S) {
      for (const [mul, g0] of [[1, 1], [2, .18]]) {   // 少しだけ倍音を足して、鐘のようにやわらかく
        const o = AUDIO.createOscillator(), g = AUDIO.createGain();
        o.type = 'sine'; o.frequency.value = f * mul;
        const s0 = t0 + at;
        g.gain.setValueAtTime(0.0001, s0);
        g.gain.exponentialRampToValueAtTime(vol * g0, s0 + .015);       // ふわっと立ち上がる
        g.gain.exponentialRampToValueAtTime(0.0001, s0 + d);             // すっと消える
        o.connect(g); g.connect(AUDIO.destination); o.start(s0); o.stop(s0 + d + .02);
      }
    }
  } catch (e) { }
  try { navigator.vibrate && navigator.vibrate(kind === 'pri' ? [80, 70, 80] : kind === 'ng' ? [70, 60, 70] : kind === 'dup' ? [40, 50, 40] : kind === 'tick' ? 10 : 30); } catch (e) { }
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
  tags: { title: 'タグ', cols: ['タグ', '品番', '品名', 'ロット', '数量', '優先', '発行日時', '保留', '備考'] },
  locs: { title: '置き場所', cols: ['コード', '種別', '名称', '優先置き場'] },
  carts: { title: '台車', cols: ['台車番号', '名称', '優先台車', '種類'] },   // 種類: 台車 / パレット
  ship: { title: '出庫予定', cols: ['タグ', '品番', '品名', 'ロット', '数量', '出庫予定日', '優先', '保留', '備考', '出庫数', 'まとめ'] },   // 出庫数: 空欄=全部 / まとめ: 同じ記号の行を1つにまとめて出庫   // 計画から来る「今日の出庫予定」
  lt: { title: 'リードタイム', cols: ['タグ', '品番', 'いまの状態', '入荷(受入)', '入庫待ち(検査済)', '入荷→入庫(秒)', '棚出し', '入庫待ち(包装済)', '出庫→出荷(秒)', '書き出し日時'] },
  staff: { title: '社員', cols: ['社員番号', '氏名', '担当'] },   // 社員証(BI-W)で、だれが作業したかを記録
  plans: { title: '計画', cols: ['品番', '台車', '置き場所', 'メモ', '保留理由'] },
};
const colLetter = n => String.fromCharCode(65 + n - 1);
const rng = (tab, from = 2, to = '') => `'${TABS[tab].title}'!A${from}:${colLetter(TABS[tab].cols.length)}${to}`;
async function ensureTabs() {
  const meta = await gapi('?fields=sheets.properties.title');
  const have = new Set((meta.sheets || []).map(s => s.properties.title));
  const missing = Object.values(TABS).filter(t => !have.has(t.title));
  const exist = Object.values(TABS).filter(t => have.has(t.title));   // 列を追加したときのために、見出し行をそろえる
  if (exist.length) await gapi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: exist.map(t => ({ range: `'${t.title}'!A1`, values: [t.cols] })) }) });
  if (!missing.length) return;
  await gapi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map(t => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })) }) });
  await gapi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: missing.map(t => ({ range: `'${t.title}'!A1`, values: [t.cols] })) }) });
}
async function appendRows(tab, rows) {
  const r = await gapi(`/values/${encodeURIComponent(rng(tab, 1))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: rows }) });
  const m = ((r.updates || {}).updatedRange || '').match(/![A-Z]+(\d+)/);
  return m ? +m[1] : 0;
}
// 新しいイベントと、先頭のイベントID(デモのリセットを見分けるため)を1回の通信で読む
async function readEventsSince(from) {
  const qs = [`'${TABS.events.title}'!A2:A2`, rng('events', from)].map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const r = await gapi(`/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`);
  const [a, b] = (r.valueRanges || []).map(v => v.values || []);
  return { first: ((a || [])[0] || [])[0] || '', rows: b || [] };
}
async function clearRows(tab) { await gapi(`/values/${encodeURIComponent(rng(tab, 2))}:clear`, { method: 'POST', body: '{}' }); }
async function readRows(tab, from = 2) {
  const r = await gapi(`/values/${encodeURIComponent(rng(tab, from))}?valueRenderOption=FORMATTED_VALUE`);
  return (r.values || []);
}
async function readMasters(retry = true) {
  const qs = ['tags', 'locs', 'carts', 'plans', 'ship', 'staff'].map(t => 'ranges=' + encodeURIComponent(rng(t))).join('&');
  let r;
  try { r = await gapi(`/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`); }
  catch (e) {   // 以前の版で作ったスプレッドシートには「台車」の表がないので、作ってから読み直す
    if (!retry || e instanceof NeedLogin || e instanceof NoAccess) throw e;
    await ensureTabs(); NET.online = true; return readMasters(false);
  }
  const [tv, lv, cv, pv, sv, wv] = (r.valueRanges || []).map(v => v.values || []);
  const plans = {};   // 品番ごと。同じ品番が何行かあれば、下の行(あとで入れたもの)を使う
  (pv || []).filter(r => r[0]).forEach(r => { plans[r[0]] = { part: r[0], carts: splitList(r[1]), locs: splitList(r[2]), memo: r[3] || '', hold: (r[4] || '').trim() }; });
  const locs = {}, carts = {};
  (lv || []).filter(r => r[0]).forEach(r => {
    // 以前の版で「置き場所(種別=台車)」として登録したものは、台車として扱う
    if (r[1] === '台車') carts[r[0]] = { code: r[0], name: r[2] || '', pz: r[3] === '○' };
    else locs[r[0]] = { code: r[0], type: r[1] || '', name: r[2] || '', pz: r[3] === '○' };
  });
  (cv || []).filter(r => r[0]).forEach(r => { carts[r[0]] = { code: r[0], name: r[1] || '', pz: r[2] === '○', kind: r[3] || (/^P/i.test(r[0]) ? 'パレット' : '台車') }; });
  // ② 出庫→出荷 の部品は「出庫予定」リストから(① とは別の部品)
  const ship = {};
  (sv || []).filter(r => r[0]).forEach(r => { ship[r[0]] = { tag: r[0], part: r[1] || '', name: r[2] || '', lot: r[3] || '', qty: r[4] || '', due: r[5] || '', pri: r[6] === '優先', hold: r[7] === '保留', note: r[8] || '', outQty: r[9] ? +r[9] || 0 : 0, group: (r[10] || '').trim(), ship: true }; });
  return {
    tags: Object.fromEntries((tv || []).filter(r => r[0]).map(r => [r[0], { tag: r[0], part: r[1] || '', name: r[2] || '', lot: r[3] || '', qty: r[4] || '', pri: r[5] === '優先', issued: r[6] || '', hold: r[7] === '保留', note: r[8] || '' }])),   // 同じタグの行が複数あれば、下の行(あとで直したもの)を使う
    locs, carts, plans, ship,
    staff: Object.fromEntries((wv || []).filter(r => r[0]).map(r => [r[0], { id: r[0], name: r[1] || '', role: r[2] || '' }])),
  };
}

/* ---------------- 計画(どの品番を、どの台車・置き場所に置くか) ----------------
   台車・置き場所は「T-01/K-N」のように複数書ける。空欄はどこでもよい */
const splitList = v => String(v || '').split(/[\/・,、\s]+/).filter(Boolean);
function planNG(m, part, cart, loc, typeHint) {
  const p = ((m && m.plans) || {})[part]; if (!p) return [];
  const r = [];
  if (cart && p.carts.length && !p.carts.includes(cart)) r.push({ k: '台車', want: p.carts, got: cart });
  if (loc && p.locs.length && !p.locs.includes(loc) && !isProcessLoc(m, loc, typeHint)) r.push({ k: '置き場所', want: p.locs, got: loc });
  return r;
}
function cartPlanLocs(m, cart) {   // その台車に載せる計画の部品の置き場所 = 台車を置いてよい場所
  const s = new Set(); Object.values((m && m.plans) || {}).forEach(p => { if (p.carts.includes(cart)) p.locs.forEach(l => s.add(l)); });
  return [...s];
}
function cartMoveNG(m, cart, loc, typeHint) { if (isProcessLoc(m, loc, typeHint)) return []; const ls = cartPlanLocs(m, cart); return ls.length && !ls.includes(loc) ? [{ k: '置き場所', want: ls, got: loc }] : []; }
const ngText = ng => ng.map(x => `${x.k}: 読んだのは ${x.got} / 計画は ${x.want.join('・')}`);

/* ---------------- タグの形式(QRの中身) ----------------
   部品タグ: BI-T;ID=T0001;PN=IHF-30112-A;LOT=L2610-03;Q=12;P=1   (P=1 なら発行時点で優先)
   台車タグ: BI-C;ID=CP-01;PZ=1                                     (PZ=1 なら優先台車)
   場所タグ: BI-L;ID=K-P;K=INSP;PZ=1                                (PZ=1 なら優先置き場)
   タグだけで品番・優先・種類が分かるので、通信できない場所でも判定できる */
const LOC_KIND = { TEMP: '仮置き', INSP: '検査エリア', DESK: '検査机', HOLD: '保留場所', PRE: '入庫前',
  OTP: '出庫仮置き', SPT: '補用仮置き', SPD: '補用検査机', PKT: '包装仮置き', PKW: '包装作業場', SHP: '出荷前', AREA: '置き場' };
// 工程の場所は、受入の計画チェックの対象外
const PROCESS_LOC = new Set(['検査机', '保留場所', '入庫前', '出庫仮置き', '補用仮置き', '補用検査机', '包装仮置き', '包装作業場', '出荷前']);
// 場所の種別は、マスタになければ読んだタグ(K=…)の種別を使う
const isProcessLoc = (m, code, typeHint) => PROCESS_LOC.has((((m && m.locs) || {})[code] || {}).type || typeHint || '');
const KIND_OF = Object.fromEntries(Object.entries(LOC_KIND).map(([k, v]) => [v, k]));
function parseTag(text) {
  const s = String(text || '').trim();
  const m = s.match(/^BI-([TLCHPW]);(.*)$/); if (!m) return null;
  const f = Object.fromEntries(m[2].split(';').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (m[1] === 'W') { let n = f.N || f.ID; try { n = decodeURIComponent(n); } catch (e) { } return f.ID ? { kind: 'worker', id: f.ID, name: n } : null; }   // 社員証
  if (m[1] === 'T') return f.ID ? { kind: 'part', tag: f.ID, part: f.PN || '', lot: f.LOT || '', qty: f.Q || '', pri: f.P === '1', hold: f.H === '1' } : null;
  // 保留棚タグ: 台車とは関係なく、決まった場所にある棚(以前の場所タグ K=HOLD も保留棚として読む)
  if (m[1] === 'H' || f.K === 'HOLD') return f.ID ? { kind: 'shelf', code: f.ID, type: '保留場所' } : null;
  if (m[1] === 'P') return f.ID ? { kind: 'cart', code: f.ID, pz: f.PZ === '1', carrier: 'パレット' } : null;   // パレット(台車と同じ役割)
  if (m[1] === 'C' || f.K === 'CART') return f.ID ? { kind: 'cart', code: f.ID, pz: f.PZ === '1' } : null;   // 以前の台車タグ(BI-L;K=CART)も台車として読む
  return f.ID ? { kind: 'loc', code: f.ID, type: LOC_KIND[f.K] || f.K || '', pz: f.PZ === '1' } : null;
}
// H=1 は「保留」(優先の逆)。タグだけで保留と分かるので、電波がなくても判定できる
const workerQR = w => `BI-W;ID=${w.id};N=${encodeURIComponent(w.name)}`;   // 名前は英数字に変えて入れる(どのQR読み取りでも同じに読める)
const partQR = t => `BI-T;ID=${t.tag};PN=${t.part};LOT=${t.lot};Q=${t.qty};P=${t.pri ? 1 : 0}${t.hold ? ';H=1' : ''}`;
const tagRow = t => [t.tag, t.part, t.name || '', t.lot || '', String(t.qty ?? ''), t.pri ? '優先' : '', t.issued || now(), t.hold ? '保留' : '', t.note || ''];
const locQR = l => `BI-L;ID=${l.code};K=${KIND_OF[l.type] || 'AREA'};PZ=${l.pz ? 1 : 0}`;
const cartQR = c => `BI-${c.kind === 'パレット' ? 'P' : 'C'};ID=${c.code};PZ=${c.pz ? 1 : 0}`;
const carrierKind = (m, code) => (((m && m.carts) || {})[code] || {}).kind || (/^P/i.test(code || '') ? 'パレット' : '台車');
const shelfQR = l => `BI-H;ID=${l.code}`;
const tagQR = l => l.type === '保留場所' ? shelfQR(l) : locQR(l);
function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 1, scalable: true }); }

/* ---------------- イベント(出来事)と、いまの状態の組み立て ----------------
   種類: place(部品を台車に載せ、その台車が置き場所にある) / cart(台車ごと置き場所を移動) / status(検査済・保留・解除)
         alert(管理からの優先アラート) / ack(現場の受信確認) / hello(端末の起動・生存) */
/* ステータスの流れ(2つに分ける。運ぶのは、検査机までは台車、そのあとはパレット。どちらも「運ぶもの」として同じ扱い)
   ① 入荷→入庫: 未受入 →(台車に載せる)→ 未検査 →(台車ごと検査机へ・机で読む → パレットへ)→ 検査済
                 →(パレットごと入庫前へ)→ 入庫待ち(検査済)【①の終わり。「保管」はシステム上は持たない】  ※計画で保留の部品は 保留(保留棚)
   ② 出庫→出荷(計画の「出庫予定」リストから): 出庫予定 →(棚出し: 部品→パレット→出庫仮置き)→ 仮置き →(出庫で読む)→ 出庫済
                 ※分けた残りは新しいタグで 未入庫(計画側へ戻す)
                 →(補用仮置き・補用検査机へ)→ 補用未検査 →(読む)→ 補用検査済 →(包装仮置きへ)→ 包装待ち
                 →(包装作業場へ)→ 包装前 →(読む)→ 包装済 →(入庫前へ)→ 入庫待ち(包装済)【②の終わり】 */
const STATUSES_1 = ['未受入', '未検査', '検査済', '入庫待ち(検査済)', '保留'];
const STATUSES_2 = ['出庫予定', '出庫仮置き', '出庫済', '補用未検査', '補用検査済', '包装待ち', '包装前', '包装済', '入庫待ち(包装済)', '未入庫'];
const STATUSES = [...STATUSES_1, ...STATUSES_2];
// 置かれている場所の種別で決まるステータス(場所のステータス)
function deriveStatus(s, t) {
  if (s === '検査済' && t === '入庫前') return '入庫待ち(検査済)';
  if (s === '出庫予定' && t === '出庫仮置き') return '出庫仮置き';
  if (s === '出庫済' && (t === '補用仮置き' || t === '補用検査机')) return '補用未検査';
  if (s === '補用検査済' && t === '包装仮置き') return '包装待ち';
  if (s === '補用検査済' && t === '包装作業場') return '包装前';
  if (s === '包装済' && t === '入庫前') return '入庫待ち(包装済)';
  return s;
}
// 運んでよい行き先(いまのステータスごと)= 計画はステータスに合わせて進む
const MOVE_OK = {
  '未検査': ['検査机'], '検査済': ['検査机', '入庫前'], '入庫待ち(検査済)': ['入庫前'],
  '出庫予定': ['出庫仮置き'], '出庫仮置き': ['出庫仮置き'],
  '出庫済': ['出庫仮置き', '補用仮置き', '補用検査机'], '補用未検査': ['補用仮置き', '補用検査机'],
  '補用検査済': ['補用検査机', '包装仮置き', '包装作業場'], '包装待ち': ['包装仮置き', '包装作業場'], '包装前': ['包装作業場'],
  '包装済': ['包装作業場', '入庫前'], '入庫待ち(包装済)': ['入庫前'], '未入庫': ['入庫前', '出庫仮置き'],
};
// いまの予定(ステータスが進むと、予定も進む)
function nextPlan(s, p, hold) {
  if (s === '保留') return '保留棚に置いておく(検査しない)';
  if (hold && (s === '未受入' || s === '未検査')) return '検査しないで保留棚へ';
  return {
    '未受入': p ? `受入: 台車 ${p.carts.join('・') || '指定なし'} @ ${p.locs.join('・') || '指定なし'}` : '受入: 台車に載せる',
    '未検査': '台車ごと検査机へ → 検査', '検査済': 'パレットごと入庫前へ', '入庫待ち(検査済)': '① 完了(入庫待ち)', '未入庫': '計画側で扱う(入庫前へ)',
    '出庫予定': '棚出し: パレットに載せて出庫仮置きへ', '出庫仮置き': '出庫する', '出庫済': 'パレットごと補用検査の仮置きへ', '補用未検査': '補用検査机で検査',
    '補用検査済': 'パレットごと包装の仮置きへ', '包装待ち': 'パレットごと包装作業場へ', '包装前': '包装する', '包装済': 'パレットごと入庫前へ', '入庫待ち(包装済)': '② 完了(入庫待ち)',
  }[s] || '';
}
// 段階ごとの完了%: 各段階を通った部品の割合
const RANK_1 = { '未受入': 0, '未検査': 1, '検査済': 3, '入庫待ち(検査済)': 4 };
const STAGES_1 = [['受入(台車へ)', 1], ['検査机へ', 2], ['検査', 3], ['入庫前へ', 4]];
const RANK_2 = { '出庫予定': 0, '出庫仮置き': 1, '出庫済': 2, '補用未検査': 3, '補用検査済': 5, '包装待ち': 6, '包装前': 7, '包装済': 8, '入庫待ち(包装済)': 9 };
const STAGES_2 = [['棚出し', 1], ['出庫', 2], ['補用検査の仮置きへ', 3], ['補用検査机へ', 4], ['補用検査', 5], ['包装の仮置きへ', 6], ['包装作業場へ', 7], ['包装', 8], ['入庫前へ', 9]];
// items: [{ status, locType }] → [[段階, 完了数, 全体]]
function progress(items, sec) {
  const R = sec === 1 ? RANK_1 : RANK_2, S = sec === 1 ? STAGES_1 : STAGES_2;
  const its = items.filter(i => i.status in R);
  const rank = i => R[i.status] + ((sec === 1 && i.status === '未検査' && i.locType === '検査机') || (sec === 2 && i.status === '補用未検査' && i.locType === '補用検査机') ? 1 : 0);
  return S.map(([name, r]) => [name, its.filter(i => rank(i) >= r).length, its.length]);
}
const STATUS_COLOR = { '未受入': '#6b7480', '未検査': '#1d5fc4', '検査済': '#15803d', '入庫待ち(検査済)': '#7c3aed', '保留': '#b45309', '未入庫': '#64748b', '出庫予定': '#0f766e',
  '出庫仮置き': '#ca8a04', '出庫済': '#475569', '補用未検査': '#2563eb', '補用検査済': '#16a34a', '包装待ち': '#a16207', '包装前': '#c2410c', '包装済': '#0e7490', '入庫待ち(包装済)': '#be185d', 'まとめ済': '#9ca3af' };
const stColor = s => STATUS_COLOR[s] || '#6b7480';
const stChip = s => `<span class="st" style="background:${stColor(s)}">${esc(s)}</span>`;
const SECTION_OF = s => STATUSES_2.includes(s) ? '出庫→出荷' : '入荷→入庫';
// 以前の版のステータス名を読み替える(保管はシステム上なくした)
const legacyStatus = s => (s === '入庫済' || s === '保管') ? '検査済' : s;
// 出庫で分けた・まとめたときの新しいタグの番号(だれが発行しても同じ番号になるように決める)
//   分ける: T0003 → T0003-2, T0003-3 …   まとめる: T0002 ほか → T0002-M1, T0002-M2 …
function nextTagId(base, kind, existing) {
  const pre = kind === 'merge' ? `${base}-M` : `${base}-`;
  let n = kind === 'merge' ? 1 : 2;
  while (existing.has(pre + n)) n++;
  return pre + n;
}
const HOLD_REASONS = ['数量違い', '不良疑い', '書類不備', 'その他'];
function eventRow(e) { return [e.id, e.at, e.device, e.account, e.type, e.tag || '', e.part || '', e.lot || '', e.loc || '', JSON.stringify(e.data || {}), e.cart || '']; }
function rowEvent(r, rowNo) {
  let data = {}; try { data = JSON.parse(r[9] || '{}'); } catch (e) { }
  return { id: r[0], at: r[1], device: r[2], account: r[3], type: r[4], tag: r[5], part: r[6], lot: r[7], loc: r[8], data, cart: r[10] || data.cart || '', row: rowNo, bytes: (r.join('').length + 20) };
}
function newEvent(type, f = {}) {
  return { id: 'E' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), at: now(), device: DEVICE.name, account: ACCOUNT.email, type, ...f, data: { t: Date.now(), ...(window.BI_WORKER ? { worker: window.BI_WORKER.name, wid: window.BI_WORKER.id } : {}), ...(f.data || {}) } };
}
// だれが: 社員証を読んでいれば その人(端末)、なければ端末名
const who = e => (e.data || {}).worker ? `${e.data.worker}(${e.device})` : e.device;
function buildState(masters, events) {
  const items = {}, carts = {};
  const item = (tag, e) => items[tag] || (items[tag] = { tag, part: (e && e.part) || '', name: '', lot: (e && e.lot) || '', qty: '', pri: false, priSrc: '', status: '未受入', prev: '', hold: '', cart: '', direct: '', loc: '', since: '', by: '', hist: [], offPlan: '', origin: '', reissue: '', attached: false, mergedTo: '', lt: {}, sec: 1 });
  const cart = code => carts[code] || (carts[code] = { code, name: ((masters.carts || {})[code] || {}).name || '', pz: !!((masters.carts || {})[code] || {}).pz, kind: carrierKind(masters, code), loc: '', since: '', by: '' });
  const T = e => e.data.t || Date.parse(String(e.at).replace(' ', 'T')) || 0;
  const typeOf = c => ((masters.locs || {})[c] || {}).type || '';
  // リードタイム: ① 入荷(最初の受入)→ 入庫待ち(検査済)  ② 棚出し(出庫仮置きへ)→ 入庫待ち(包装済)
  const ltCheck = (it, t) => {
    const ty = typeOf(it.cart ? (carts[it.cart] || {}).loc : it.direct);
    if (it.sec === 1 && it.status === '検査済' && ty === '入庫前' && !it.lt.store) it.lt.store = t;
    if (it.sec === 2 && it.status === '出庫予定' && ty === '出庫仮置き' && !it.lt.out) it.lt.out = t;
    if (it.sec === 2 && it.status === '包装済' && ty === '入庫前' && !it.lt.back) it.lt.back = t;
  };
  for (const t of Object.values(masters.tags)) Object.assign(item(t.tag), { part: t.part, name: t.name, lot: t.lot, qty: t.qty, pri: t.pri, priSrc: t.pri ? 'タグ' : '', tagHold: !!t.hold, note: t.note || '' });
  for (const t of Object.values(masters.ship || {})) Object.assign(item(t.tag), { part: t.part, name: t.name, lot: t.lot, qty: t.qty, pri: t.pri, priSrc: t.pri ? '計画' : '', tagHold: !!t.hold, note: t.note || '', due: t.due, sec: 2, status: '出庫予定' });
  for (const c of Object.keys(masters.carts || {})) cart(c);
  const alerts = [], orders = [], devices = {};
  for (const e of events) {
    const d = devices[e.device] || (devices[e.device] = { name: e.device, account: e.account, last: '', lastT: 0, n: 0 });
    d.last = e.at; d.lastT = e.data.t || 0; d.n++; if (e.type === 'hello') d.info = e.data;
    if (e.type === 'worker') { d.worker = e.data.off ? '' : e.data.worker; d.wid = e.data.off ? '' : e.data.wid; d.wSince = e.at; } else if (e.data.worker && d.worker !== e.data.worker) { d.worker = e.data.worker; d.wid = e.data.wid; }
    if (e.type === 'place') {
      const it = item(e.tag, e);
      if (it.status === '未受入') it.status = '未検査';
      // 以前の版の記録(台車を置き場所として読んだもの)は、台車に載せたことにする
      const cc = e.cart || ((masters.carts || {})[e.loc] ? e.loc : '');
      if (cc) { it.cart = cc; it.direct = ''; if (e.cart) Object.assign(cart(cc), { loc: e.loc, since: e.at, by: who(e) }); }
      else { it.cart = ''; it.direct = e.loc; }
      it.since = e.at; it.by = who(e); it.offPlan = e.data.offPlan || '';
      if (e.data.pri && !it.pri) { it.pri = true; it.priSrc = 'タグ'; }
      if (it.sec === 1 && !it.lt.recv) it.lt.recv = T(e);
      ltCheck(it, T(e)); it.hist.push(e);
    } else if (e.type === 'cart') {   // 台車・パレットごと移動
      Object.assign(cart(e.cart), { loc: e.loc, since: e.at, by: who(e) });
      for (const o of orders) if (!o.done && o.cart === e.cart && o.to === e.loc) o.done = e;
      for (const it of Object.values(items)) if (it.cart === e.cart) { it.hist.push(e); ltCheck(it, T(e)); }
    } else if (e.type === 'status') {
      const it = item(e.tag, e), to = legacyStatus(e.data.to);
      if (to === '保留') { it.prev = it.status === '保留' ? it.prev : it.status; it.status = '保留'; it.hold = e.data.reason || ''; }
      else if (to === '解除') { it.status = it.prev || '未検査'; it.hold = ''; }
      else it.status = to;
      if (it.status === '未受入') it.status = '未検査';
      // 検査机で検査した = 台車からパレットへ(パレットはその机に)
      if (e.cart) { it.cart = e.cart; it.direct = ''; if (e.loc) Object.assign(cart(e.cart), { loc: e.loc, since: e.at, by: who(e) }); }
      else if (e.loc) { it.cart = ''; it.direct = e.loc; }
      it.since = e.at; it.by = who(e);
      ltCheck(it, T(e)); it.hist.push(e);
    } else if (e.type === 'ng') {
      if (e.tag) item(e.tag, e).hist.push(e);
    } else if (e.type === 'alert') {
      alerts.push({ ...e, acks: [] });
      for (const it of Object.values(items)) if (it.part === e.part || it.tag === e.tag) { it.pri = true; it.priSrc = 'アラート'; it.hist.push(e); }
    } else if (e.type === 'split') {   // 出庫で分けた: 元のタグは出庫分、パレットから離れる残りは新しいタグで「未入庫」へ
      const o = item(e.tag, e), d = e.data, nw = item(d.newTag, e);
      o.qty = String(d.qtyOut); o.status = '出庫済'; o.since = e.at; o.by = who(e); o.hist.push(e);
      Object.assign(nw, { pri: o.pri || !!d.pri, priSrc: o.priSrc || (d.pri ? '計画' : ''), name: o.name || d.name || '', qty: String(d.qtyRest), status: '未入庫', cart: '', direct: e.loc, origin: e.tag, reissue: '分割', since: e.at, by: who(e), sec: 2, lt: {} });
      nw.hist.push(e);
    } else if (e.type === 'merge') {   // 出庫でまとめた: 元のタグは使えなくなり、新しいタグ1枚に(元のパレットに載る)
      const d = e.data, nw = item(e.tag, e), f0 = item((d.from || [])[0] || e.tag);
      for (const f of d.from || []) { const it = item(f); Object.assign(it, { status: 'まとめ済', mergedTo: e.tag, cart: '', direct: '' }); it.hist.push(e); }
      const fp = (d.from || []).map(f => item(f)).find(x => x.pri);
      Object.assign(nw, { pri: !!fp || !!d.pri, priSrc: fp ? fp.priSrc : d.pri ? '計画' : '', name: d.name || '', qty: String(d.qty), status: '出庫済', cart: e.cart || '', direct: e.cart ? '' : e.loc, origin: (d.from || []).join('+'), reissue: 'まとめ', since: e.at, by: who(e), sec: 2, lt: { out: f0.lt.out } });
      nw.hist.push(e);
    } else if (e.type === 'attach') {
      const it = item(e.tag, e); it.attached = true; it.hist.push(e);
    } else if (e.type === 'order') {
      orders.push({ ...e, acks: [], done: null, to: e.loc, cart: e.cart });
    } else if (e.type === 'ack') {
      const a = alerts.find(x => x.id === e.data.alert); if (a) a.acks.push(e);
      const o = orders.find(x => x.id === e.data.order); if (o) o.acks.push(e);
    }
  }
  for (const it of Object.values(items)) {
    it.loc = it.cart ? (carts[it.cart] || {}).loc || '' : it.direct;
    it.locType = typeOf(it.loc);
    it.status = deriveStatus(it.status, it.locType);   // 場所で決まるステータス
    const p = (masters.plans || {})[it.part]; it.planHold = p && it.sec === 1 ? p.hold : '';
    const tagReason = it.tagHold ? (it.note || '保留') : '';
    it.holdReason = it.status === '保留' ? (it.hold || tagReason || it.planHold || '理由なし') : tagReason || it.planHold || '';
    it.next = nextPlan(it.status, it.sec === 1 ? p : null, !!it.holdReason);
    it.lt.inbound = it.lt.recv && it.lt.store ? it.lt.store - it.lt.recv : null;
    it.lt.outbound = it.lt.out && it.lt.back ? it.lt.back - it.lt.out : null;
  }
  return { items, carts, alerts, orders, devices };
}

/* ---------------- 端末の名前 ---------------- */
const DEVICE = { name: lsGet('bi_dev_name') || '' };
async function ensureDeviceName(def) {
  if (DEVICE.name) return;
  const n = await askText('この端末の名前(管理画面の一覧に出ます)', def);
  DEVICE.name = (n || '').trim() || def; lsSet('bi_dev_name', DEVICE.name);
}
