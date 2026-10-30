/* =====================================================================
   管理アプリ(PC)— 現場から届く結果を見て、優先アラートを現場に知らせる
   - 現場のスマホとは別のアプリ。共有のスプレッドシートを数秒ごとに読み、届いた分だけ反映する
   - 「通信の流れ」で、スマホ → Google → この画面 のやりとりを目で見えるようにする
   ===================================================================== */
let MAST = { tags: {}, locs: {}, carts: {}, plans: {} }, EVENTS = [], ST = { items: {}, carts: {}, alerts: [], devices: {} };
let LASTROW = 1, LOADED = false;
const RECV = {};          // イベントID → この画面が受け取った時刻
const FRESH = {};         // 最近変わったタグ(置き場マップで光らせる)
let FEED = [];            // 通信モニターの行
let VIEW = 'dash', ARG = '';
const PC_NAME = () => DEVICE.name || '管理PC';

/* ---------------- 起動 ---------------- */
async function boot() {
  restoreLogin();
  if (CONF.mock) installMockGIS();
  ON_LOGIN = () => main();
  if (!lsGet('bi_authorized')) return LOGIN_UI.show('受入・検査 管理画面', 'BLUE IMPULSE / 管理(PC)');
  main();
}
async function main() {
  document.body.className = 'admin';
  DEVICE.name = lsGet('bi_pc_name') || '管理PC';   // 現場アプリとは別の名前で記録する
  window.addEventListener('hashchange', () => { route(); render(); });
  route(); render();
  await loadAll();
  setInterval(poll, 2500);
  setInterval(() => { if (VIEW === 'dash' || VIEW === 'devices') renderLive(); }, 5000);
}
function route() { const m = location.hash.match(/^#([a-z]+)(?:-(.+))?$/); VIEW = m ? m[1] : 'dash'; ARG = m && m[2] ? decodeURIComponent(m[2]) : ''; }
async function loadAll() {
  try {
    MAST = await readMasters();
    const rows = await readRows('events');
    FIRSTID = (rows[0] || [])[0] || '';
    EVENTS = rows.filter(r => r[0]).map((r, i) => rowEvent(r, i + 2));
    EVENTS.forEach(e => RECV[e.id] = 0);
    LASTROW = 1 + rows.length; rebuild(); LOADED = true;
    FEED = EVENTS.slice(-14).reverse().map(e => ({ e, recv: 0 }));
  } catch (e) { netError(e); }
  render();
}
function rebuild() { ST = buildState(MAST, EVENTS); }
function netError(e) { if (e instanceof NeedLogin) { NET.needLogin = true; } renderTop(); }

/* ---------------- 現場からの到着を受け取る ---------------- */
let POLLING = false, MAST_T = 0;
async function poll() {
  if (POLLING || !tokenValid()) return renderTop(); POLLING = true;
  try {
    if (Date.now() - MAST_T > 30000) { MAST = await readMasters(); MAST_T = Date.now(); }
    const { first, rows } = await readEventsSince(LASTROW + 1);
    if (FIRSTID && first !== FIRSTID) { clearLocal(); await loadAll(); toast('デモがリセットされました'); return; }   // 別のPCでリセットされた
    FIRSTID = first;
    const news = rows.filter(r => r[0]).map((r, i) => rowEvent(r, LASTROW + 1 + i)).filter(e => !(e.id in RECV));
    LASTROW += rows.length;
    if (news.length) {
      for (const e of news) { RECV[e.id] = Date.now(); EVENTS.push(e); if (e.tag) FRESH[e.tag] = Date.now(); if (e.cart) FRESH['cart:' + e.cart] = Date.now(); FEED.unshift({ e, recv: Date.now() }); animateFlow(e); }
      FEED = FEED.slice(0, 40); rebuild(); renderLive(); onArrivals(news);
    }
  } catch (e) { netError(e); }
  finally { POLLING = false; renderTop(); }
}
function onArrivals(news) {
  for (const e of news) {   // 優先品を通常の場所に置いた、などは画面上で知らせる
    if (e.type === 'place' && e.data.pri && !e.data.pz && !e.data.cartPz) toast(`優先品 ${e.part} が通常の台車・置き場所(${e.cart || ''} @ ${e.loc})に置かれました`, true);
    if (e.type === 'ng') toast(`計画と違う置き方を検知しました: ${e.part || '台車 ' + e.cart} → ${e.cart} @ ${e.loc}(現場では未登録)`, true);
    if (e.type === 'ack' && e.data.order) { toast(`${e.device} が指示を開始しました(台車 ${e.cart} → ${e.loc})`); renderOrderModal(); }
    else if (e.type === 'ack') { const a = ST.alerts.find(x => x.id === e.data.alert); if (a) toast(`${e.device} がアラートを確認しました(${e.part})`); renderAlertModal(); }
    if (e.type === 'cart') { const o = ST.orders.find(x => x.done && x.done.id === e.id); if (o) { toast(`指示の移動が完了しました: 台車 ${e.cart} → ${e.loc}`); renderOrderModal(); } }
    if (e.type === 'status' && e.data.to === '保留') toast(`保留: ${e.part}(${e.data.reason || ''})`, true);
  }
}
let FIRSTID = '';
function clearLocal() { EVENTS = []; FEED = []; LASTROW = 1; FIRSTID = ''; for (const o of [RECV, FRESH]) for (const k of Object.keys(o)) delete o[k]; rebuild(); }
/* ---------------- デモのリセット ---------------- */
async function resetDemo() {
  let plan = false;
  const p = dialog(`<h3 style="margin:0 0 8px">デモをリセット</h3><div class="dlg-msg">現場で登録した記録(置いた・台車の移動・検査済・保留・優先アラート)を<b>すべて消して</b>、はじめからにします。<br><span class="small mute">タグ・台車・置き場所はそのまま残ります。現場のスマホも数秒で自動的にリセットされます。</span></div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="rs_plan" style="width:auto;margin:0"> 計画も「仮の計画」に戻す</label>`, [{ label: 'やめる' }, { label: 'リセットする', cls: 'red', ok: true }]);
  setTimeout(() => { const c = $('rs_plan'); if (c) c.onchange = () => { plan = c.checked; }; });
  if ((await p).i !== 1) return;
  try {
    await clearRows('events');
    if (plan) { await ensureTabs(); await clearRows('plans'); await appendRows('plans', DEMO_PLAN); }
    await appendRows('events', [eventRow(newEvent('reset', { data: { plan } }))]);   // 先頭がこの行に変わる → スマホがリセットに気づく
    closeAlert(); clearLocal(); MAST = await readMasters(); await loadAll();
    toast(plan ? '登録の記録を消し、計画を仮の計画に戻しました' : '登録の記録を消しました。はじめからデモできます');
  } catch (e) { toast('リセットできませんでした: ' + e.message, true); }
}
async function post(ev) {   // 管理画面からのイベント(アラート・保留解除など)
  const t0 = performance.now();
  try { await appendRows('events', [eventRow(ev)]); } catch (e) { toast('送れませんでした: ' + e.message, true); throw e; }
  RECV[ev.id] = Date.now(); EVENTS.push(ev); LASTROW++; FEED.unshift({ e: ev, recv: Date.now(), out: true, ms: Math.round(performance.now() - t0) });
  animateFlow(ev, true); rebuild(); renderLive();
}

/* ---------------- 画面の骨組み ---------------- */
const NAV = [['dash', '現場の状況'], ['items', '部品一覧'], ['tags', 'タグ発行'], ['locs', '台車・置き場所'], ['plan', '計画'], ['devices', '現場端末'], ['setup', '設定']];
function render() {
  $('app').innerHTML = `<header class="top"><div class="brand">受入・検査 管理画面<small>BLUE IMPULSE</small></div>
    <nav class="nav">${NAV.map(([k, n]) => `<a href="#${k}" class="${VIEW === k ? 'on' : ''}">${n}</a>`).join('')}</nav>
    <div class="topst" id="topst"></div></header>
    <main class="wrap" id="main">${LOADED ? (VIEWS[VIEW] || VIEWS.dash)() : '<div class="card empty">スプレッドシートを読み込んでいます…</div>'}</main>`;
  renderTop(); afterRender();
}
function renderLive() { if (!LOADED) return; const m = $('main'); if (!m) return; if (VIEW === 'dash') { $('live').innerHTML = dashLive(); afterRender(); } else if (VIEW === 'devices' || VIEW === 'items') { m.innerHTML = VIEWS[VIEW](); afterRender(); } }
function afterRender() { document.querySelectorAll('[data-qr]').forEach(el => { if (!el.innerHTML) el.innerHTML = qrSvg(el.dataset.qr); }); }
function renderTop() {
  const el = $('topst'); if (!el) return;
  const s = !tokenValid() ? ['warn', 'ログインが必要'] : !NET.online ? ['bad', 'Googleにつながりません'] : ['on', `受信中(2.5秒ごと)`];
  el.innerHTML = `<i class="dot ${s[0]}"></i>${s[1]}${!tokenValid() ? ' <button class="btn" onclick="login()">ログイン</button>' : ''}`;
}
const stH = s => `<span class="st st-${s}">${s}</span>`;
const priH = it => it.pri ? `<span class="pri ${it.priSrc === 'アラート' ? 'alert' : ''}">優先${it.priSrc === 'アラート' ? '(アラート)' : ''}</span>` : '';
const locName = c => { const l = MAST.locs[c]; return l ? `${l.type} ${c}` : c; };
const cartOf = c => ST.carts[c] || { code: c, name: '', pz: false, loc: '' };
// 部品のいまの場所: 「台車 C-01(仮置き T-01)」
const whereOf = i => i.cart ? `台車 ${i.cart}(${cartOf(i.cart).loc ? locName(cartOf(i.cart).loc) : '置き場所 未記録'})` : i.loc ? locName(i.loc) : '';
const priOK = i => (i.cart && cartOf(i.cart).pz) || (i.loc && (MAST.locs[i.loc] || {}).pz);
const placed = i => !!(i.cart || i.loc);
const planOf = i => (MAST.plans || {})[i.part];
const offPlan = i => placed(i) ? planNG(MAST, i.part, i.cart, i.loc) : [];   // いまの置き方が計画と違う
const planH = p => p ? `${esc(p.carts.join('・') || '台車指定なし')} @ ${esc(p.locs.join('・') || '場所指定なし')}` : '<span class="mute">計画なし</span>';
const VIEWS = {};

/* ---------------- 現場の状況(ダッシュボード) ---------------- */
VIEWS.dash = () => {
  if (!Object.keys(MAST.tags).length && !EVENTS.some(e => e.type === 'place')) return `<div class="card welcome"><h2>はじめに</h2>
    <p>共有のスプレッドシートにはまだタグがありません。デモ用のタグと置き場所を作ると、すぐに試せます。</p>
    <button class="btn primary big" onclick="seedDemo()">デモ用のタグ・台車・置き場所を作る</button>
    <p class="mute small">部品タグ8枚(うち2枚は発行時点で優先)、台車3台、置き場所9か所(検査机・保留場所・入庫前を含む)と、仮の計画を登録します。「タグ発行」「台車・置き場所」から印刷できます。</p></div>`;
  return `<div class="head"><div><h1>現場の状況</h1><div class="mute small">現場のスマホがタグを読むと、数秒でここに反映されます。</div></div>
    <div class="row"><button class="btn" onclick="resetDemo()">デモをリセット</button><button class="btn primary big" onclick="openOrder()">移動を指示</button><button class="btn red big" onclick="openAlert()">優先アラートを受信(デモ)</button></div></div>
    <section class="flowcard"><div class="flow" id="flow">
      <div class="fnode dev" id="fn-dev"><div class="fn-t">現場端末</div><div id="fn-devs"></div></div>
      <div class="lane" id="lane1"><span>結果だけを送信 →</span></div>
      <div class="fnode g" id="fn-g"><div class="fn-t">Google スプレッドシート</div><div class="fn-s">ログインした人だけが読み書き</div></div>
      <div class="lane" id="lane2"><span>→ 数秒ごとに受信</span></div>
      <div class="fnode pc" id="fn-pc"><div class="fn-t">この管理画面</div><div class="fn-s" id="fn-pcst"></div></div>
    </div></section>
    <div id="live">${dashLive()}</div>`;
};
function dashLive() {
  const items = Object.values(ST.items);
  const cnt = Object.fromEntries(STATUSES.map(s => [s, items.filter(i => i.status === s).length]));
  const devs = Object.values(ST.devices).filter(d => d.name !== PC_NAME()).sort((a, b) => b.lastT - a.lastT);
  setTimeout(() => {
    const fd = $('fn-devs'); if (fd) fd.innerHTML = devs.slice(0, 4).map(d => `<div class="fdev"><i class="dot ${Date.now() - d.lastT < 120000 ? 'on' : ''}"></i>${esc(d.name)}</div>`).join('') || '<div class="fn-s">まだ接続なし</div>';
    const ps = $('fn-pcst'); if (ps) ps.textContent = `受信 ${EVENTS.length} 件`;
  });
  const chip = i => { const ng = offPlan(i); return `<div class="chip ${i.pri ? 'p' : ''} ${ng.length ? 'ng' : ''} ${Date.now() - (FRESH[i.tag] || 0) < 6000 ? 'fresh' : ''}" title="${ng.length ? esc('計画外: ' + ngText(ng).join(' / ')) : ''}" onclick="showItem('${esc(i.tag)}')"><b class="mono">${ng.length ? '⚠ ' : ''}${esc(i.part)}</b><span>${esc(i.name)}</span>${stH(i.status)}</div>`; };
  const carts = Object.values(ST.carts);
  const onCart = c => items.filter(i => i.cart === c.code);
  const cbox = c => `<div class="cbox ${c.pz ? 'pz' : ''} ${Date.now() - (FRESH['cart:' + c.code] || 0) < 6000 ? 'fresh' : ''}"><div class="cb-h"><span class="cb-k">台車</span><b class="mono">${esc(c.code)}</b>${c.pz ? '<span class="pri">優先台車</span>' : ''}<span class="cb-n">${onCart(c).length}点</span></div>${onCart(c).map(chip).join('') || '<div class="lb-e">空</div>'}</div>`;
  const locs = Object.values(MAST.locs);
  const used = new Set([...carts.map(c => c.loc), ...items.filter(i => !i.cart).map(i => i.direct)].filter(Boolean));
  [...used].filter(c => !MAST.locs[c]).forEach(c => locs.push({ code: c, type: 'その他', name: '', pz: false }));
  const groups = [...new Set([...Object.values(LOC_KIND), ...locs.map(l => l.type)])].filter(g => g !== 'その他').concat('その他');
  const lbox = l => { const cs = carts.filter(c => c.loc === l.code), ds = items.filter(i => !i.cart && i.direct === l.code);
    return `<div class="lbox ${l.pz ? 'pz' : ''}"><div class="lb-h"><b class="mono">${esc(l.code)}</b><span>${esc(l.name)}</span>${l.pz ? '<span class="pri">優先置き場</span>' : ''}</div>${cs.map(cbox).join('')}${ds.map(chip).join('')}${cs.length || ds.length ? '' : '<div class="lb-e">台車なし</div>'}</div>`; };
  const loose = carts.filter(c => !c.loc);
  const unplaced = items.filter(i => !placed(i));
  const pris = items.filter(i => i.pri && !['検査済', '未入庫', '入庫済'].includes(i.status));
  return `<div class="kpis">${STATUSES.map(s => `<div class="kpi k-${s}"><div>${s}</div><b>${cnt[s]}</b></div>`).join('')}</div>
  <div class="dgrid"><section class="card"><div class="ch"><h2>置き場マップ</h2><span class="mute small">置き場所 ＞ 台車 ＞ 部品 ・ 光っているのは、いま届いた変更</span></div>
    ${groups.map(g => { const ls = locs.filter(l => l.type === g); if (!ls.length) return ''; return `<div class="lgroup"><div class="lg-t">${esc(g)}</div><div class="lgrid">${ls.map(lbox).join('')}</div></div>`; }).join('')}
    ${loose.length ? `<div class="lgroup"><div class="lg-t">置き場所がまだ記録されていない台車</div><div class="lgrid">${loose.map(cbox).join('')}</div></div>` : ''}
    ${unplaced.length ? `<div class="lgroup"><div class="lg-t">まだ台車に載せていない(未受入)</div><div class="unpl">${unplaced.map(chip).join('')}</div></div>` : ''}
  </section>
  <div class="dside">
    ${holdCard()}
    ${ordersCard()}
    <section class="card"><div class="ch"><h2>通信モニター</h2><span class="mute small">新しい順</span></div><div class="feed">${FEED.slice(0, 16).map(feedRow).join('') || '<div class="mute small">まだ受信していません</div>'}</div></section>
    <section class="card"><div class="ch"><h2>優先品の所在</h2><span class="mute small">${pris.length} 件</span></div>
      ${pris.length ? `<table class="tbl"><tbody>${pris.map(i => `<tr class="${placed(i) && !priOK(i) ? 'warnrow' : ''}"><td><b class="mono">${esc(i.part)}</b><div class="small mute">${esc(i.priSrc)}で優先</div></td><td>${stH(i.status)}</td><td>${placed(i) ? esc(whereOf(i)) : '<span class="mute">未記録</span>'}${placed(i) && !priOK(i) ? '<div class="small" style="color:var(--pri)">優先台車・優先置き場ではない</div>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="mute small">ありません</div>'}
    </section>
  </div></div>`;
}
function feedRow(f) {
  const e = f.e, d = e.data || {};
  const delay = f.recv && d.t ? Math.max(0, f.recv - d.t) : null;
  const what = e.type === 'place' && !e.cart ? `<b class="mono">${esc(e.part)}</b> を <b>${esc(e.loc)}</b>${d.hold ? '(保留棚)' : ''} に置いた` : e.type === 'place' ? `<b class="mono">${esc(e.part)}</b> → 台車 <b>${esc(e.cart || '-')}</b> @ <b>${esc(e.loc)}</b>${d.from ? `<div class="small mute">移し替え(${esc(d.from)} から)</div>` : ''}` : e.type === 'cart' ? `台車 <b>${esc(e.cart)}</b> を <b>${esc(e.loc)}</b> へ移動` : e.type === 'ng' ? `<b style="color:var(--pri)">計画外を検知(未登録)</b> ${esc(e.part || '台車 ' + e.cart)} → ${esc(e.cart)} @ ${esc(e.loc)}<div class="small" style="color:var(--pri)">${(d.reasons || []).map(esc).join(' / ')}</div>` : e.type === 'status' ? `<b class="mono">${esc(e.part)}</b> を ${esc(d.to)}${d.reason ? '(' + esc(d.reason) + ')' : ''}`
    : e.type === 'status' ? `<b class="mono">${esc(e.part)}</b> を ${stH(d.to === '解除' ? '未検査' : d.to)}${d.reason ? `(${esc(d.reason)}${d.planned ? '・計画' : ''})` : ''}${e.loc ? ` @ <b>${esc(e.loc)}</b>` : ''}`
    : e.type === 'order' ? `<b>移動の指示</b>: 台車 <b>${esc(e.cart)}</b> → <b>${esc(d.toName || e.loc)}</b>(${esc(e.loc)})`
    : e.type === 'ack' && d.order ? `指示を開始: 台車 <b>${esc(e.cart)}</b> → ${esc(e.loc)}`
    : e.type === 'alert' ? `優先アラートを現場へ: <b class="mono">${esc(e.part)}</b>` : e.type === 'ack' ? `アラートを了解: <b class="mono">${esc(e.part)}</b>` : e.type === 'hello' ? '端末が接続' : e.type === 'reset' ? '<b>デモをリセット</b>(登録の記録を消去)' : esc(e.type);
  const dir = f.out || e.device === PC_NAME() ? 'out' : 'in';
  return `<div class="fr ${dir} ${d.pri ? 'p' : ''} ${f.recv && Date.now() - f.recv < 5000 ? 'new' : ''}"><span class="fr-t">${hms(e.at)}</span>
    <span class="fr-d">${dir === 'out' ? '管理 → 現場' : esc(e.device) + ' →'}</span><span class="fr-w">${what}${d.pri ? ' <span class="pri">優先</span>' : ''}${d.offPlan ? ' <span class="pri">計画外</span>' : ''}</span>
    <span class="fr-m">${e.bytes || eventRow(e).join('').length} B${delay !== null && delay < 120000 ? ` ・ 遅れ ${(delay / 1000).toFixed(1)}秒` : ''}${f.ms ? ` ・ 送信 ${(f.ms / 1000).toFixed(1)}秒` : ''}</span></div>`;
}
// 通信の流れのアニメーション: 端末 → Google → この画面(アラートは逆向き)
function animateFlow(e, out) {
  if (VIEW !== 'dash') return;
  const lanes = out ? ['lane2', 'lane1'] : ['lane1', 'lane2'];
  const label = e.type === 'place' ? `${e.part} → ${e.cart ? e.cart + ' @ ' : ''}${e.loc}` : e.type === 'cart' ? `台車 ${e.cart} → ${e.loc}` : e.type === 'ng' ? `⚠ 計画外 ${e.part || e.cart}` : e.type === 'status' ? `${e.part} ${e.data.to}` : e.type === 'order' ? `指示 ${e.cart} → ${e.loc}` : e.type === 'alert' ? `優先アラート ${e.part}` : e.type === 'ack' ? `了解 ${e.part}` : '接続';
  const cls = (e.data || {}).pri || e.type === 'alert' || e.type === 'ng' ? 'p' : e.type === 'ack' ? 'a' : '';
  lanes.forEach((id, k) => setTimeout(() => {
    const lane = $(id); if (!lane) return;
    const p = document.createElement('div'); p.className = 'packet ' + cls; p.textContent = label; lane.appendChild(p);
    const w = lane.clientWidth - p.offsetWidth;
    p.animate(out ? [{ transform: `translateX(${w}px)`, opacity: 1 }, { transform: 'translateX(0)', opacity: 1 }] : [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${w}px)`, opacity: 1 }], { duration: 900, easing: 'ease-in-out' }).onfinish = () => p.remove();
    const node = $(k === 0 ? 'fn-g' : out ? 'fn-dev' : 'fn-pc'); if (node) setTimeout(() => { node.classList.remove('hit'); void node.offsetWidth; node.classList.add('hit'); }, 880);
  }, k * 950));
}

/* ---------------- 優先アラート(デモ: ボタンで受信したことにする) ---------------- */
let ALERT_UI = null;
function openAlert() {
  const items = Object.values(ST.items);
  const cand = items.filter(i => !i.pri && placed(i)).sort((a, b) => String(b.since).localeCompare(String(a.since)))[0] || items.find(i => !i.pri) || items[0];
  if (!cand) return toast('タグがありません。先にデモ用のタグを作ってください', true);
  ALERT_UI = { part: cand.part, at: now(), sent: null };
  renderAlertModal(true);
}
function renderAlertModal(open) {
  if (!ALERT_UI) return;
  let d = $('almodal');
  if (!d) { if (!open) return; d = document.createElement('div'); d.id = 'almodal'; d.className = 'dlg-back'; document.body.appendChild(d); }
  const parts = [...new Set(Object.values(ST.items).map(i => i.part))].sort();
  const its = Object.values(ST.items).filter(i => i.part === ALERT_UI.part);
  const it = its[0] || {};
  const where = its.filter(placed).map(i => `${whereOf(i)}(${i.by} が ${hms(i.since)} に載せた)`).join(' / ');
  const sent = ALERT_UI.sent && ST.alerts.find(a => a.id === ALERT_UI.sent);
  d.innerHTML = `<div class="dlg almodal"><div class="al-top"><span>優先アラート 受信</span><span>${hms(ALERT_UI.at)}</span></div>
    <div class="al-body">
      <div class="small mute">生産計画の変更により、次の部品が優先になりました(デモ)</div>
      <div class="row"><select id="alpart" ${sent ? 'disabled' : ''} onchange="ALERT_UI.part=this.value;renderAlertModal()">${parts.map(p => `<option ${p === ALERT_UI.part ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><span>${esc(it.name || '')}</span></div>
      <div class="al-where"><div class="small mute">いまの場所(現場の記録から)</div><b>${where ? esc(where) : 'まだ現場で読み取られていません'}</b></div>
      ${sent ? `<div class="al-st"><div>✓ 現場へ送信しました(${hms(sent.at)})</div>${sent.acks.length ? sent.acks.map(a => `<div class="ack">✓ ${esc(a.device)} が了解(${(((a.data.t || 0) - (sent.data.t || 0)) / 1000).toFixed(1)}秒後)</div>`).join('') : '<div class="waiting">現場の確認を待っています…</div>'}</div>` : ''}
    </div>
    <div class="row end">${sent ? '<button class="btn primary" onclick="closeAlert()">閉じる</button>' : `<button class="btn" onclick="closeAlert()">閉じる</button><button class="btn red big" onclick="sendAlert()">現場に知らせる</button>`}</div></div>`;
}
async function sendAlert() {
  const its = Object.values(ST.items).filter(i => i.part === ALERT_UI.part);
  const where = its.filter(placed).map(whereOf).join('・');
  const ev = newEvent('alert', { part: ALERT_UI.part, data: { name: (its[0] || {}).name || '', where, msg: '優先に変更' } });
  try { await post(ev); ALERT_UI.sent = ev.id; renderAlertModal(); } catch (e) { }
}
function closeAlert() { const d = $('almodal'); if (d) d.remove(); ALERT_UI = null; }

/* ---------------- 部品一覧・履歴 ---------------- */
VIEWS.items = () => {
  const items = Object.values(ST.items).sort((a, b) => (b.pri - a.pri) || String(b.since).localeCompare(String(a.since)));
  return `<div class="head"><h1>部品一覧</h1><span class="mute small">${items.length} 件</span></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>タグ</th><th>品番</th><th>品名</th><th>ロット</th><th>数量</th><th>ステータス</th><th>台車</th><th>置き場所</th><th>計画</th><th>最終更新</th><th></th></tr></thead><tbody>
  ${items.map(i => `<tr class="${i.pri ? 'prirow' : ''}"><td class="mono">${esc(i.tag)}</td><td><b class="mono">${esc(i.part)}</b> ${priH(i)}</td><td>${esc(i.name)}</td><td class="mono">${esc(i.lot)}</td><td class="num">${esc(i.qty)}</td>
    <td>${stH(i.status)}${i.hold ? `<div class="small mute">${esc(i.hold)}</div>` : i.planHold && i.status !== '保留' ? `<div class="small" style="color:var(--s-hold)">計画で保留: ${esc(i.planHold)}</div>` : ''}</td><td class="mono">${i.cart ? `<b>${esc(i.cart)}</b>${cartOf(i.cart).pz ? ' <span class="pri">優先</span>' : ''}` : '<span class="mute">-</span>'}</td><td>${i.loc ? esc(locName(i.loc)) : '<span class="mute">未記録</span>'}</td><td class="small">${planH(planOf(i))}${offPlan(i).length ? '<div style="color:var(--pri);font-weight:700">✗ 計画と違う</div>' : planOf(i) && placed(i) ? '<div style="color:var(--ok)">✓ 計画どおり</div>' : ''}</td><td class="small">${esc(i.since ? hms(i.since) + ' ' + i.by : '')}</td>
    <td><button class="btn" onclick="showItem('${esc(i.tag)}')">履歴</button>${i.status === '保留' ? ` <button class="btn" onclick="release('${esc(i.tag)}')">保留を解除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">まだありません</td></tr>'}
  </tbody></table></div>`;
};
function showItem(tag) {
  const i = ST.items[tag]; if (!i) return;
  dialog(`<h3 style="margin:0 0 6px"><span class="mono">${esc(i.part)}</span> ${priH(i)} ${stH(i.status)}</h3><div class="small mute">タグ ${esc(i.tag)} ・ ${esc(i.name)} ・ ロット ${esc(i.lot)} ・ 数量 ${esc(i.qty)}</div>
    <div class="hlist">${i.hist.slice().reverse().map(e => `<div><span class="mute">${esc(e.at)}</span> ${e.type === 'place' ? `台車 ${esc(e.cart || '-')} に載せた(${esc(locName(e.loc))})` : e.type === 'cart' ? `台車 ${esc(e.cart)} ごと ${esc(locName(e.loc))} へ移動` : e.type === 'ng' ? `<b style="color:var(--pri)">計画外を検知(未登録)</b> 台車 ${esc(e.cart)} @ ${esc(e.loc)}` : e.type === 'alert' ? '優先アラート' : esc(e.data.to)} <span class="mute">(${esc(e.device)})</span></div>`).join('') || '<div class="mute">記録なし</div>'}</div>`, [{ label: '閉じる', cls: 'primary' }]);
}
async function release(tag) { const i = ST.items[tag]; await post(newEvent('status', { tag, part: i.part, lot: i.lot, data: { to: '解除' } })); toast('保留を解除しました'); render(); }

/* ---------------- タグ発行・印刷 ---------------- */
VIEWS.tags = () => {
  const tags = Object.values(MAST.tags);
  const parts = [...new Set(tags.map(t => t.part))];
  return `<div class="head"><div><h1>タグ発行</h1><div class="mute small">発行時に「優先」にしたタグは、現場で読んだ瞬間に優先品として知らせます(パターン1)。</div></div>
    <button class="btn primary" onclick="printTags()">選んだタグを印刷</button></div>
  <div class="card sect noprint"><h2>新しく発行する</h2><div class="row">
    <input type="text" id="t_part" placeholder="品番" list="partl" style="width:160px"><datalist id="partl">${parts.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <input type="text" id="t_name" placeholder="品名" style="width:180px"><input type="text" id="t_lot" placeholder="ロット" style="width:120px">
    <input type="number" id="t_qty" placeholder="数量" style="width:80px"><label class="row"><input type="checkbox" id="t_pri"> 優先</label>
    <input type="number" id="t_n" value="1" min="1" max="50" style="width:70px"> 枚 <button class="btn primary" onclick="issueTags()">発行</button></div></div>
  <div class="card flush"><table class="tbl"><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('.tsel').forEach(c=>c.checked=this.checked)"></th><th>タグ</th><th>品番</th><th>品名</th><th>ロット</th><th>数量</th><th>優先</th><th>状態</th><th>発行</th></tr></thead><tbody>
  ${tags.map(t => { const i = ST.items[t.tag] || {}; return `<tr><td><input type="checkbox" class="tsel" value="${esc(t.tag)}" checked></td><td class="mono">${esc(t.tag)}</td><td class="mono">${esc(t.part)}</td><td>${esc(t.name)}</td><td class="mono">${esc(t.lot)}</td><td>${esc(t.qty)}</td><td>${t.pri ? '<span class="pri">優先</span>' : ''}</td><td>${i.status ? stH(i.status) : ''}</td><td class="small">${esc(t.issued)}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">まだありません</td></tr>'}
  </tbody></table></div>`;
};
async function issueTags() {
  const part = $('t_part').value.trim().toUpperCase(); if (!part) return toast('品番を入れてください', true);
  const n = Math.max(1, Math.min(50, +$('t_n').value || 1));
  let max = Math.max(0, ...Object.keys(MAST.tags).map(k => +k.replace(/\D/g, '') || 0));
  const rows = []; for (let i = 0; i < n; i++) { max++; rows.push([`T${pad(max, 4)}`, part, $('t_name').value.trim(), $('t_lot').value.trim().toUpperCase(), $('t_qty').value, $('t_pri').checked ? '優先' : '', now()]); }
  try { await appendRows('tags', rows); MAST = await readMasters(); rebuild(); toast(`${n} 枚発行しました`); render(); } catch (e) { toast(e.message, true); }
}
function printTags() {
  const sel = [...document.querySelectorAll('.tsel:checked')].map(c => c.value);
  const list = sel.map(t => MAST.tags[t]).filter(Boolean);
  printSheet(list.map(t => `<div class="ptag ${t.pri ? 'p' : ''}"><div data-qr="${esc(partQR(t))}" class="pq"></div><div class="pt"><div class="pk">部品タグ ${esc(t.tag)}</div><div class="pn mono">${esc(t.part)}</div><div class="pm">${esc(t.name)}</div><div class="pl">LOT ${esc(t.lot)} ・ ${esc(t.qty)}</div>${t.pri ? '<div class="pp">優先</div>' : ''}</div></div>`));
}
function printSheet(cards) {
  const w = document.createElement('div'); w.className = 'printarea'; w.innerHTML = cards.join('');
  document.body.appendChild(w); w.querySelectorAll('[data-qr]').forEach(el => el.innerHTML = qrSvg(el.dataset.qr));
  document.body.classList.add('printing'); setTimeout(() => { window.print(); document.body.classList.remove('printing'); w.remove(); }, 100);
}

/* ---------------- 台車・置き場所 ---------------- */
VIEWS.locs = () => {
  const locs = Object.values(MAST.locs), carts = Object.values(ST.carts);
  return `<div class="head"><div><h1>台車・置き場所</h1><div class="mute small">台車タグを台車に、場所タグを棚・床・検査エリアに貼っておくと、現場で「部品 → 台車 → 置き場所」と読むだけで記録されます。</div></div>
    <div class="row"><button class="btn primary" onclick="printCarts()">台車タグを印刷</button><button class="btn primary" onclick="printLocs()">場所タグを印刷</button></div></div>
  <div class="grid2">
  <section><div class="card sect"><h2>台車を追加</h2><div class="row"><input type="text" id="c_code" placeholder="台車番号 例: C-03" style="width:130px"><input type="text" id="c_name" placeholder="名称" style="width:150px">
    <label class="row"><input type="checkbox" id="c_pz"> 優先台車</label><button class="btn primary" onclick="addCart()">追加</button></div></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>台車番号</th><th>名称</th><th>優先</th><th>いまの置き場所</th><th>載っている部品</th></tr></thead><tbody>
  ${carts.map(c => `<tr><td class="mono"><b>${esc(c.code)}</b></td><td>${esc(c.name)}</td><td>${c.pz ? '<span class="pri">優先台車</span>' : ''}</td><td>${c.loc ? esc(locName(c.loc)) : '<span class="mute">未記録</span>'}</td><td class="num">${Object.values(ST.items).filter(i => i.cart === c.code).length}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">まだありません</td></tr>'}
  </tbody></table></div></section>
  <section><div class="card sect"><h2>置き場所を追加</h2><div class="row"><input type="text" id="l_code" placeholder="コード 例: T-03" style="width:120px">
    <select id="l_type">${Object.values(LOC_KIND).map(t => `<option>${t}</option>`).join('')}</select><input type="text" id="l_name" placeholder="名称" style="width:140px">
    <label class="row"><input type="checkbox" id="l_pz"> 優先置き場</label><button class="btn primary" onclick="addLoc()">追加</button></div></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>コード</th><th>種別</th><th>名称</th><th>優先</th><th>ある台車</th></tr></thead><tbody>
  ${locs.map(l => `<tr><td class="mono"><b>${esc(l.code)}</b></td><td>${esc(l.type)}</td><td>${esc(l.name)}</td><td>${l.pz ? '<span class="pri">優先置き場</span>' : ''}</td><td class="mono small">${carts.filter(c => c.loc === l.code).map(c => esc(c.code)).join(' ') || '<span class="mute">-</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">まだありません</td></tr>'}
  </tbody></table></div></section></div>`;
};
async function addCart() {
  const code = $('c_code').value.trim().toUpperCase(); if (!code) return toast('台車番号を入れてください', true);
  try { await ensureTabs(); await appendRows('carts', [[code, $('c_name').value.trim(), $('c_pz').checked ? '○' : '']]); MAST = await readMasters(); rebuild(); toast('追加しました'); render(); } catch (e) { toast(e.message, true); }
}
async function addLoc() {
  const code = $('l_code').value.trim().toUpperCase(); if (!code) return toast('コードを入れてください', true);
  try { await appendRows('locs', [[code, $('l_type').value, $('l_name').value.trim(), $('l_pz').checked ? '○' : '']]); MAST = await readMasters(); rebuild(); toast('追加しました'); render(); } catch (e) { toast(e.message, true); }
}
function printCarts() {
  printSheet(Object.values(MAST.carts).map(c => `<div class="ptag cart ${c.pz ? 'p' : ''}"><div data-qr="${esc(cartQR(c))}" class="pq"></div><div class="pt"><div class="pk">台車</div><div class="pn mono">${esc(c.code)}</div><div class="pm">${esc(c.name)}</div>${c.pz ? '<div class="pp">優先台車</div>' : ''}</div></div>`));
}
function printLocs() {
  printSheet(Object.values(MAST.locs).map(l => `<div class="ptag loc ${l.pz ? 'p' : ''}"><div data-qr="${esc(locQR(l))}" class="pq"></div><div class="pt"><div class="pk">置き場所 ${esc(l.type)}</div><div class="pn mono">${esc(l.code)}</div><div class="pm">${esc(l.name)}</div>${l.pz ? '<div class="pp">優先置き場</div>' : ''}</div></div>`));
}

/* ---------------- 移動の指示(例: 未検査を検査員Aの机へ) ----------------
   管理が「台車をどこへ」を指示 → 現場のスマホに表示 →「はじめる」→ 台車を運んで場所タグを読むと完了 */
let ORDER_UI = null;
const cartStat = c => { const its = Object.values(ST.items).filter(i => i.cart === c); const n = s => its.filter(i => i.status === s).length; return { all: its.length, un: n('未検査') }; };
function openOrder(cart, to) {
  const carts = Object.values(ST.carts).filter(c => c.loc);
  const best = cart || (carts.slice().sort((a, b) => cartStat(b.code).un - cartStat(a.code).un)[0] || {}).code || '';
  const desk = to || (Object.values(MAST.locs).find(l => l.type === '検査机') || {}).code || '';
  ORDER_UI = { cart: best, to: desk, sent: null }; renderOrderModal(true);
}
function renderOrderModal(open) {
  if (!ORDER_UI) return;
  let d = $('ordmodal');
  if (!d) { if (!open) return; d = document.createElement('div'); d.id = 'ordmodal'; d.className = 'dlg-back'; document.body.appendChild(d); }
  const carts = Object.values(ST.carts), locs = Object.values(MAST.locs);
  const sent = ORDER_UI.sent && ST.orders.find(o => o.id === ORDER_UI.sent);
  const c = ST.carts[ORDER_UI.cart] || {}, cs = cartStat(ORDER_UI.cart), L = MAST.locs[ORDER_UI.to] || {};
  const quick = locs.filter(l => ['検査机', '入庫前'].includes(l.type));
  d.innerHTML = `<div class="dlg ordm"><div class="om-top">移動の指示 <span>現場のスマホに届きます</span></div>
    ${sent ? '' : `<div class="om-q">${quick.map(l => `<button class="btn ${ORDER_UI.to === l.code ? 'primary' : ''}" onclick="ORDER_UI.to='${esc(l.code)}';renderOrderModal()">${l.type === '検査机' ? '未検査を' : '検査済を'} ${esc(l.name || l.code)} へ</button>`).join('')}</div>`}
    <div class="om-g"><label>台車<select ${sent ? 'disabled' : ''} onchange="ORDER_UI.cart=this.value;renderOrderModal()">${carts.map(x => { const t = cartStat(x.code); return `<option value="${esc(x.code)}" ${x.code === ORDER_UI.cart ? 'selected' : ''}>${esc(x.code)}(${x.loc ? esc(x.loc) : '場所未記録'}・${t.all}点・未検査${t.un})</option>`; }).join('')}</select></label>
      <label>行き先<select ${sent ? 'disabled' : ''} onchange="ORDER_UI.to=this.value;renderOrderModal()">${locs.map(l => `<option value="${esc(l.code)}" ${l.code === ORDER_UI.to ? 'selected' : ''}>${esc(l.code)} ${esc(l.name)}(${esc(l.type)})</option>`).join('')}</select></label></div>
    <div class="om-sum">台車 <b>${esc(ORDER_UI.cart || '-')}</b>(いま ${esc(c.loc || '場所未記録')}・${cs.all}点、うち未検査 ${cs.un}点)を <b>${esc(L.name || ORDER_UI.to)}</b>(${esc(ORDER_UI.to)})へ</div>
    ${sent ? `<div class="al-st"><div>✓ 現場へ送信しました(${hms(sent.at)})</div>${sent.acks.map(a => `<div class="ack">✓ ${esc(a.device)} が開始(${(((a.data.t || 0) - (sent.data.t || 0)) / 1000).toFixed(1)}秒後)</div>`).join('') || '<div class="waiting">現場が「はじめる」を押すのを待っています…</div>'}
      ${sent.done ? `<div class="ack done">✓ 移動が完了しました(${esc(sent.done.device)}・${hms(sent.done.at)})</div>` : sent.acks.length ? '<div class="waiting">台車を運んで、場所タグを読むのを待っています…</div>' : ''}</div>` : ''}
    <div class="row end">${sent ? '<button class="btn primary" onclick="closeOrder()">閉じる</button>' : `<button class="btn" onclick="closeOrder()">閉じる</button><button class="btn primary big" ${ORDER_UI.cart && ORDER_UI.to ? '' : 'disabled'} onclick="sendOrder()">現場に指示する</button>`}</div></div>`;
}
async function sendOrder() {
  const L = MAST.locs[ORDER_UI.to] || {}, cs = cartStat(ORDER_UI.cart);
  const note = L.type === '検査机' ? `未検査 ${cs.un}点を検査してください` : L.type === '入庫前' ? '入庫前に置いてください' : '';
  const ev = newEvent('order', { cart: ORDER_UI.cart, loc: ORDER_UI.to, data: { toName: L.name || '', note } });
  try { await post(ev); ORDER_UI.sent = ev.id; renderOrderModal(); } catch (e) { }
}
function closeOrder() { const d = $('ordmodal'); if (d) d.remove(); ORDER_UI = null; }
// 計画で保留(=検査しないで保留棚へ)の部品が、いまどうなっているか
function holdCard() {
  const its = Object.values(ST.items).filter(i => i.planHold);
  if (!its.length) return '';
  const st = i => i.status === '保留' && (MAST.locs[i.loc] || {}).type === '保留場所' ? ['ok', `✓ 保留棚 ${esc(i.loc)}`]
    : i.status === '保留' ? ['wait', '保留済・保留棚へ移動待ち'] : i.status === '未受入' ? ['wait', '未受入(届いたら保留棚へ)'] : ['ng', `未対応(いま ${esc(whereOf(i) || '-')})`];
  return `<section class="card"><div class="ch"><h2>保留の指示(検査しないで保留棚へ)</h2><span class="mute small">計画から</span></div><div class="olist">${its.map(i => { const [c, t] = st(i);
    return `<div class="orow hold-${c}"><span class="mono"><b>${esc(i.part)}</b></span><span>${esc(i.planHold)}</span><span class="ost">${t}</span></div>`; }).join('')}</div></section>`;
}
function ordersCard() {
  const os = (ST.orders || []).slice(-5).reverse();
  if (!os.length) return '';
  return `<section class="card"><div class="ch"><h2>移動の指示</h2><span class="mute small">新しい順</span></div><div class="olist">${os.map(o => `<div class="orow ${o.done ? 'done' : ''}">
    <span class="fr-t">${hms(o.at)}</span><span>台車 <b class="mono">${esc(o.cart)}</b> → <b>${esc((o.data || {}).toName || o.to)}</b>(${esc(o.to)})</span>
    <span class="ost">${o.done ? `✓ 完了 ${hms(o.done.at)}` : o.acks.length ? `実行中(${esc(o.acks[0].device)})` : '送信済・未開始'}</span></div>`).join('')}</div></section>`;
}

/* ---------------- 計画(仮) ---------------- */
const DEMO_PLAN = [['IHF-30112-A', 'CP-01', 'TP-01/K-P', '優先品'], ['IHF-30113-A', 'C-01', 'T-01/K-N', ''], ['IHF-41005-C', 'C-01', 'T-01/K-N', ''],
  ['IHF-52001-D', 'CP-01', 'TP-01/K-P', '優先品'], ['IHF-60340-A', 'C-02', 'T-02/K-N', ''], ['IHF-70015-B', 'C-02', 'T-02/K-N', '', '図面改訂待ち(Rev.C)'], ['HW-10011-M6', 'C-02', '', '置き場所は自由'], ['HW-10530-S', '', '', '指定なし']];
VIEWS.plan = () => {
  const parts = [...new Set([...Object.values(MAST.tags).map(t => t.part), ...Object.keys(MAST.plans || {})])].sort();
  const name = p => (Object.values(MAST.tags).find(t => t.part === p) || {}).name || '';
  const its = p => Object.values(ST.items).filter(i => i.part === p);
  const carts = Object.values(ST.carts).filter(c => cartPlanLocs(MAST, c.code).length);
  return `<div class="head"><div><h1>計画(仮)</h1><div class="mute small">品番ごとに、載せる台車と置き場所を決めておくと、現場で違う台車・置き場所を読んだときにエラーになります(登録されません)。「保留理由」を書いた品番は「検査しないで、保留棚へ」の指示になり、現場で読んだ時点で(受入でも検査でも)理由つきで知らせて保留棚へ誘導します。受入済みの部品に保留理由を足すと、現場のスマホにも「計画の変更」として届きます。複数あるときは「T-01/K-N」のように / で区切ります。空欄はどこでもよい。</div></div>
    ${Object.keys(MAST.plans || {}).length ? '' : '<button class="btn primary" onclick="seedPlan()">仮の計画を入れる(デモ)</button>'}</div>
  <div class="card sect"><h2>計画を入れる・変える</h2><div class="row">
    <input type="text" id="p_part" placeholder="品番" list="ppl" style="width:160px"><datalist id="ppl">${parts.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <input type="text" id="p_cart" placeholder="台車 例: C-01" style="width:140px"><input type="text" id="p_loc" placeholder="置き場所 例: T-01/K-N" style="width:170px"><input type="text" id="p_memo" placeholder="メモ" style="width:140px"><input type="text" id="p_hold" placeholder="保留理由(書くと検査しないで保留棚へ)" style="width:260px">
    <button class="btn primary" onclick="addPlan()">保存</button><span class="mute small">同じ品番を保存すると上書きされます</span></div></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>品番</th><th>品名</th><th>計画の台車</th><th>計画の置き場所</th><th>メモ</th><th>保留理由</th><th>いまの状態</th><th></th></tr></thead><tbody>
  ${parts.map(p => { const pl = (MAST.plans || {})[p]; const st = its(p).map(i => !placed(i) ? '<span class="mute">未配置</span>' : offPlan(i).length ? `<b style="color:var(--pri)">✗ ${esc(whereOf(i))}</b>` : `<span style="color:var(--ok)">✓ ${esc(whereOf(i))}</span>`).join('<br>');
    return `<tr class="${its(p).some(i => offPlan(i).length) ? 'warnrow' : ''}"><td class="mono"><b>${esc(p)}</b></td><td>${esc(name(p))}</td><td class="mono">${pl ? esc(pl.carts.join('・')) || '<span class="mute">指定なし</span>' : '<span class="mute">-</span>'}</td><td class="mono">${pl ? esc(pl.locs.join('・')) || '<span class="mute">指定なし</span>' : '<span class="mute">-</span>'}</td><td class="small">${pl ? esc(pl.memo) : ''}</td><td>${pl && pl.hold ? `<span class="st st-保留">保留</span> ${esc(pl.hold)}` : ''}</td><td class="small">${st}</td>
      <td><button class="btn" onclick="editPlan('${esc(p)}')">変更</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">まだありません</td></tr>'}
  </tbody></table></div>
  ${carts.length ? `<section class="card sect" style="margin-top:16px"><h2>台車ごとの移動で使う計画</h2><div class="mute small" style="margin-bottom:6px">台車を置いてよい場所 = その台車に載せる計画の部品の置き場所</div><table class="kv"><tbody>${carts.map(c => `<tr><th class="mono">${esc(c.code)}</th><td class="mono">${esc(cartPlanLocs(MAST, c.code).join('・'))}</td></tr>`).join('')}</tbody></table></section>` : ''}`;
};
function editPlan(p) { const pl = (MAST.plans || {})[p] || { carts: [], locs: [], memo: '' }; $('p_part').value = p; $('p_cart').value = pl.carts.join('/'); $('p_loc').value = pl.locs.join('/'); $('p_memo').value = pl.memo; $('p_hold').value = pl.hold || ''; $('p_cart').focus(); }
async function addPlan() {
  const part = $('p_part').value.trim().toUpperCase(); if (!part) return toast('品番を入れてください', true);
  const up = v => v.trim().toUpperCase();
  try { await ensureTabs(); await appendRows('plans', [[part, up($('p_cart').value), up($('p_loc').value), $('p_memo').value.trim(), $('p_hold').value.trim()]]); MAST = await readMasters(); rebuild(); toast('保存しました(現場のスマホには1分以内に届きます)'); render(); } catch (e) { toast(e.message, true); }
}
async function seedPlan() {
  try { await ensureTabs(); await appendRows('plans', DEMO_PLAN); MAST = await readMasters(); rebuild(); toast('仮の計画を入れました'); render(); } catch (e) { toast(e.message, true); }
}

/* ---------------- 現場端末 ---------------- */
function fieldUrl() { const base = location.href.replace(/[^/]*(\?.*)?(#.*)?$/, ''); return `${base}index.html?c=${encodeURIComponent(CONF.clientId)}&s=${encodeURIComponent(CONF.sheetId)}`; }
VIEWS.devices = () => {
  const devs = Object.values(ST.devices).sort((a, b) => b.lastT - a.lastT);
  return `<div class="head"><h1>現場端末</h1></div>
  <div class="grid2"><section class="card"><h2>スマホを追加する</h2>
    <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><div data-qr="${esc(fieldUrl())}" style="width:170px;height:170px;flex:none"></div>
    <div class="small"><p style="margin-top:0">スマホのカメラでこのQRを読み、現場アプリを開いてください。利用を許可されたGoogleアカウントでログインすると使えます。</p>
    <p>スマホにアプリを入れる必要はありません。ブラウザの「ホーム画面に追加」をすると、アプリのように開けます。</p></div></div></section>
    <section class="card"><h2>しくみ</h2><table class="kv"><tbody>
      <tr><th>現場のスマホ</th><td>カメラでタグを読み取り(端末の中で処理)、結果だけを送る</td></tr>
      <tr><th>Google</th><td>結果をスプレッドシートにためる。共有された人しか読み書きできない</td></tr>
      <tr><th>この管理画面</th><td>2.5秒ごとに新しい結果だけを読み、置き場マップを更新。優先アラートを現場へ送る</td></tr>
      <tr><th>通信が切れたら</th><td>スマホが結果をためておき、つながったら自動で送る</td></tr></tbody></table></section></div>
  <section class="card flush" style="margin-top:16px"><table class="tbl"><thead><tr><th>端末</th><th>状態</th><th>アカウント</th><th>最終連絡</th><th>送った件数</th><th>送信待ち</th></tr></thead><tbody>
  ${devs.map(d => `<tr><td><b>${esc(d.name)}</b></td><td>${Date.now() - d.lastT < 120000 ? '<span class="ok">● 接続中</span>' : '<span class="mute">○ 未接続</span>'}</td><td class="small">${esc(d.account)}</td><td class="small">${esc(d.last)}</td><td class="num">${d.n}</td><td class="num">${d.info && d.info.pending ? d.info.pending : 0}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">まだありません</td></tr>'}
  </tbody></table></section>`;
};

/* ---------------- 設定 ---------------- */
VIEWS.setup = () => `<div class="head"><h1>設定</h1></div>
  <section class="card sect"><table class="kv"><tbody>
    <tr><th>ログイン</th><td>${esc(ACCOUNT.email)} <button class="btn" onclick="logout()">ログアウト</button></td></tr>
    <tr><th>スプレッドシート</th><td><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(CONF.sheetId)}" target="_blank" rel="noopener">開く</a> <span class="mono small mute">${esc(CONF.sheetId)}</span></td></tr>
    <tr><th>クライアントID</th><td class="mono small">${esc(CONF.clientId)}</td></tr>
    <tr><th>通信回数</th><td class="small">この画面を開いてから ${NET.calls} 回(Googleの上限は1分あたり60回/人。スマホとPCは別のアカウントにすると余裕があります)</td></tr>
  </tbody></table></section>
  <section class="card"><h2>デモ用データ</h2><div class="row"><button class="btn" onclick="seedDemo()">デモ用データをそろえる(足りないものだけ追加)</button><button class="btn danger" onclick="resetDemo()">デモをリセット(登録の記録を消す)</button></div></section>`;

/* ---------------- デモ用データ ---------------- */
async function seedDemo() {
  const T = [['IHF-30112-A', 'タービンブレード 1段', 'L2610-03', 12, 1], ['IHF-30113-A', 'タービンブレード 2段', 'L2610-04', 8, 0], ['IHF-41005-C', '燃料ノズル', 'J2610-21', 4, 0],
    ['IHF-52001-D', 'ベアリング No.3', 'R2610-15', 2, 1], ['IHF-60340-A', 'シールリング', 'J2610-22', 30, 0], ['IHF-70015-B', '点火プラグ', 'J2610-23', 6, 0],
    ['HW-10011-M6', '六角ボルト M6', 'B2610-01', 200, 0], ['HW-10530-S', 'ロックワイヤ', 'B2610-07', 20, 0]];
  const L = [['T-01', '仮置き', '入荷口 左', ''], ['T-02', '仮置き', '入荷口 右', ''], ['TP-01', '仮置き', '優先仮置き', '○'], ['K-N', '検査エリア', '通常品置き場', ''], ['K-P', '検査エリア', '優先品置き場', '○'],
    ['D-01', '検査机', '検査員Aの机', ''], ['D-02', '検査机', '検査員Bの机', ''], ['H-01', '保留場所', '保留棚', ''], ['N-01', '入庫前', '入庫前置き場', '']];
  const C = [['C-01', '通常台車1', ''], ['C-02', '通常台車2', ''], ['CP-01', '優先台車1', '○']];
  let max = Math.max(0, ...Object.keys(MAST.tags).map(k => +k.replace(/\D/g, '') || 0));
  try {
    await ensureTabs();
    // 何度押しても大丈夫: まだないものだけ追加する
    const haveParts = new Set(Object.values(MAST.tags).map(t => t.part));
    const nt = T.filter(t => !haveParts.has(t[0]));
    if (nt.length) await appendRows('tags', nt.map(([p, n, l, q, pr]) => [`T${pad(++max, 4)}`, p, n, l, String(q), pr ? '優先' : '', now()]));
    const have = new Set([...Object.keys(MAST.locs), ...Object.keys(MAST.carts || {})]);
    const nl = L.filter(l => !have.has(l[0])); if (nl.length) await appendRows('locs', nl);
    const nc = C.filter(c => !have.has(c[0])); if (nc.length) await appendRows('carts', nc);
    if (!Object.keys(MAST.plans || {}).length) await appendRows('plans', DEMO_PLAN);
    else { const add = DEMO_PLAN.filter(p => p[4] && !((MAST.plans[p[0]] || {}).hold)); if (add.length) await appendRows('plans', add); }   // 保留理由のある計画を追加
    MAST = await readMasters(); rebuild(); toast(`デモ用データをそろえました(追加: 部品${nt.length}・置き場所${nl.length}・台車${nc.length})`); location.hash = '#tags'; render();
  } catch (e) { toast(e.message, true); }
}
boot();
