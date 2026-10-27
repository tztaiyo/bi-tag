/* =====================================================================
   管理アプリ(PC)— 現場から届く結果を見て、優先アラートを現場に知らせる
   - 現場のスマホとは別のアプリ。共有のスプレッドシートを数秒ごとに読み、届いた分だけ反映する
   - 「通信の流れ」で、スマホ → Google → この画面 のやりとりを目で見えるようにする
   ===================================================================== */
let MAST = { tags: {}, locs: {} }, EVENTS = [], ST = { items: {}, alerts: [], devices: {} };
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
    const rows = await readRows('events', LASTROW + 1);
    const news = rows.filter(r => r[0]).map((r, i) => rowEvent(r, LASTROW + 1 + i)).filter(e => !(e.id in RECV));
    LASTROW += rows.length;
    if (news.length) {
      for (const e of news) { RECV[e.id] = Date.now(); EVENTS.push(e); if (e.tag) FRESH[e.tag] = Date.now(); FEED.unshift({ e, recv: Date.now() }); animateFlow(e); }
      FEED = FEED.slice(0, 40); rebuild(); renderLive(); onArrivals(news);
    }
  } catch (e) { netError(e); }
  finally { POLLING = false; renderTop(); }
}
function onArrivals(news) {
  for (const e of news) {   // 優先品を通常の場所に置いた、などは画面上で知らせる
    if (e.type === 'place' && e.data.pri && !e.data.pz) toast(`優先品 ${e.part} が通常の置き場所(${e.loc})に置かれました`, true);
    if (e.type === 'ack') { const a = ST.alerts.find(x => x.id === e.data.alert); if (a) toast(`${e.device} がアラートを確認しました(${e.part})`); renderAlertModal(); }
  }
}
async function post(ev) {   // 管理画面からのイベント(アラート・保留解除など)
  const t0 = performance.now();
  try { await appendRows('events', [eventRow(ev)]); } catch (e) { toast('送れませんでした: ' + e.message, true); throw e; }
  RECV[ev.id] = Date.now(); EVENTS.push(ev); LASTROW++; FEED.unshift({ e: ev, recv: Date.now(), out: true, ms: Math.round(performance.now() - t0) });
  animateFlow(ev, true); rebuild(); renderLive();
}

/* ---------------- 画面の骨組み ---------------- */
const NAV = [['dash', '現場の状況'], ['items', '部品一覧'], ['tags', 'タグ発行'], ['locs', '置き場所'], ['devices', '現場端末'], ['setup', '設定']];
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
const VIEWS = {};

/* ---------------- 現場の状況(ダッシュボード) ---------------- */
VIEWS.dash = () => {
  if (!Object.keys(MAST.tags).length && !EVENTS.some(e => e.type === 'place')) return `<div class="card welcome"><h2>はじめに</h2>
    <p>共有のスプレッドシートにはまだタグがありません。デモ用のタグと置き場所を作ると、すぐに試せます。</p>
    <button class="btn primary big" onclick="seedDemo()">デモ用のタグと置き場所を作る</button>
    <p class="mute small">部品タグ8枚(うち2枚は発行時点で優先)と置き場所8か所を登録します。「タグ発行」「置き場所」から印刷できます。</p></div>`;
  return `<div class="head"><div><h1>現場の状況</h1><div class="mute small">現場のスマホがタグを読むと、数秒でここに反映されます。</div></div>
    <button class="btn red big" onclick="openAlert()">優先アラートを受信(デモ)</button></div>
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
  const byLoc = {}; items.filter(i => i.loc).forEach(i => (byLoc[i.loc] = byLoc[i.loc] || []).push(i));
  const groups = ['仮置き', '台車', '検査エリア'];
  const locs = Object.values(MAST.locs);
  Object.keys(byLoc).filter(c => !MAST.locs[c]).forEach(c => locs.push({ code: c, type: 'その他', name: '', pz: false }));
  const chip = i => `<div class="chip ${i.pri ? 'p' : ''} ${Date.now() - (FRESH[i.tag] || 0) < 6000 ? 'fresh' : ''}" onclick="showItem('${esc(i.tag)}')"><b class="mono">${esc(i.part)}</b><span>${esc(i.name)}</span>${stH(i.status)}</div>`;
  const unplaced = items.filter(i => !i.loc);
  const pris = items.filter(i => i.pri && i.status !== '検査済');
  return `<div class="kpis">${STATUSES.map(s => `<div class="kpi k-${s}"><div>${s}</div><b>${cnt[s]}</b></div>`).join('')}</div>
  <div class="dgrid"><section class="card"><div class="ch"><h2>置き場マップ</h2><span class="mute small">光っているのは、いま届いた変更</span></div>
    ${[...groups, 'その他'].map(g => { const ls = locs.filter(l => l.type === g); if (!ls.length) return ''; return `<div class="lgroup"><div class="lg-t">${g}</div><div class="lgrid">${ls.map(l => `<div class="lbox ${l.pz ? 'pz' : ''}"><div class="lb-h"><b class="mono">${esc(l.code)}</b><span>${esc(l.name)}</span>${l.pz ? '<span class="pri">優先置き場</span>' : ''}</div>${(byLoc[l.code] || []).map(chip).join('') || '<div class="lb-e">なし</div>'}</div>`).join('')}</div></div>`; }).join('')}
    ${unplaced.length ? `<div class="lgroup"><div class="lg-t">まだ置き場所の記録がない(未受入)</div><div class="unpl">${unplaced.map(chip).join('')}</div></div>` : ''}
  </section>
  <div class="dside">
    <section class="card"><div class="ch"><h2>通信モニター</h2><span class="mute small">新しい順</span></div><div class="feed">${FEED.slice(0, 16).map(feedRow).join('') || '<div class="mute small">まだ受信していません</div>'}</div></section>
    <section class="card"><div class="ch"><h2>優先品の所在</h2><span class="mute small">${pris.length} 件</span></div>
      ${pris.length ? `<table class="tbl"><tbody>${pris.map(i => `<tr class="${i.loc && !(MAST.locs[i.loc] || {}).pz ? 'warnrow' : ''}"><td><b class="mono">${esc(i.part)}</b><div class="small mute">${esc(i.priSrc)}で優先</div></td><td>${stH(i.status)}</td><td>${i.loc ? esc(locName(i.loc)) : '<span class="mute">未記録</span>'}${i.loc && !(MAST.locs[i.loc] || {}).pz ? '<div class="small" style="color:var(--pri)">優先置き場ではない</div>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="mute small">ありません</div>'}
    </section>
  </div></div>`;
}
function feedRow(f) {
  const e = f.e, d = e.data || {};
  const delay = f.recv && d.t ? Math.max(0, f.recv - d.t) : null;
  const what = e.type === 'place' ? `<b class="mono">${esc(e.part)}</b> を <b>${esc(e.loc)}</b> に置いた` : e.type === 'status' ? `<b class="mono">${esc(e.part)}</b> を ${esc(d.to)}${d.reason ? '(' + esc(d.reason) + ')' : ''}`
    : e.type === 'alert' ? `優先アラートを現場へ: <b class="mono">${esc(e.part)}</b>` : e.type === 'ack' ? `アラートを了解: <b class="mono">${esc(e.part)}</b>` : e.type === 'hello' ? '端末が接続' : esc(e.type);
  const dir = f.out || e.device === PC_NAME() ? 'out' : 'in';
  return `<div class="fr ${dir} ${d.pri ? 'p' : ''} ${f.recv && Date.now() - f.recv < 5000 ? 'new' : ''}"><span class="fr-t">${hms(e.at)}</span>
    <span class="fr-d">${dir === 'out' ? '管理 → 現場' : esc(e.device) + ' →'}</span><span class="fr-w">${what}${d.pri ? ' <span class="pri">優先</span>' : ''}</span>
    <span class="fr-m">${e.bytes || eventRow(e).join('').length} B${delay !== null && delay < 120000 ? ` ・ 遅れ ${(delay / 1000).toFixed(1)}秒` : ''}${f.ms ? ` ・ 送信 ${(f.ms / 1000).toFixed(1)}秒` : ''}</span></div>`;
}
// 通信の流れのアニメーション: 端末 → Google → この画面(アラートは逆向き)
function animateFlow(e, out) {
  if (VIEW !== 'dash') return;
  const lanes = out ? ['lane2', 'lane1'] : ['lane1', 'lane2'];
  const label = e.type === 'place' ? `${e.part} → ${e.loc}` : e.type === 'status' ? `${e.part} ${e.data.to}` : e.type === 'alert' ? `優先アラート ${e.part}` : e.type === 'ack' ? `了解 ${e.part}` : '接続';
  const cls = (e.data || {}).pri || e.type === 'alert' ? 'p' : e.type === 'ack' ? 'a' : '';
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
  const cand = items.filter(i => !i.pri && i.loc).sort((a, b) => String(b.since).localeCompare(String(a.since)))[0] || items.find(i => !i.pri) || items[0];
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
  const where = its.filter(i => i.loc).map(i => `${locName(i.loc)}(${i.by} が ${hms(i.since)} に置いた)`).join(' / ');
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
  const where = its.filter(i => i.loc).map(i => locName(i.loc)).join('・');
  const ev = newEvent('alert', { part: ALERT_UI.part, data: { name: (its[0] || {}).name || '', where, msg: '優先に変更' } });
  try { await post(ev); ALERT_UI.sent = ev.id; renderAlertModal(); } catch (e) { }
}
function closeAlert() { const d = $('almodal'); if (d) d.remove(); ALERT_UI = null; }

/* ---------------- 部品一覧・履歴 ---------------- */
VIEWS.items = () => {
  const items = Object.values(ST.items).sort((a, b) => (b.pri - a.pri) || String(b.since).localeCompare(String(a.since)));
  return `<div class="head"><h1>部品一覧</h1><span class="mute small">${items.length} 件</span></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>タグ</th><th>品番</th><th>品名</th><th>ロット</th><th>数量</th><th>ステータス</th><th>置き場所</th><th>最終更新</th><th></th></tr></thead><tbody>
  ${items.map(i => `<tr class="${i.pri ? 'prirow' : ''}"><td class="mono">${esc(i.tag)}</td><td><b class="mono">${esc(i.part)}</b> ${priH(i)}</td><td>${esc(i.name)}</td><td class="mono">${esc(i.lot)}</td><td class="num">${esc(i.qty)}</td>
    <td>${stH(i.status)}${i.hold ? `<div class="small mute">${esc(i.hold)}</div>` : ''}</td><td>${i.loc ? esc(locName(i.loc)) : '<span class="mute">未記録</span>'}</td><td class="small">${esc(i.since ? hms(i.since) + ' ' + i.by : '')}</td>
    <td><button class="btn" onclick="showItem('${esc(i.tag)}')">履歴</button>${i.status === '保留' ? ` <button class="btn" onclick="release('${esc(i.tag)}')">保留を解除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">まだありません</td></tr>'}
  </tbody></table></div>`;
};
function showItem(tag) {
  const i = ST.items[tag]; if (!i) return;
  dialog(`<h3 style="margin:0 0 6px"><span class="mono">${esc(i.part)}</span> ${priH(i)} ${stH(i.status)}</h3><div class="small mute">タグ ${esc(i.tag)} ・ ${esc(i.name)} ・ ロット ${esc(i.lot)} ・ 数量 ${esc(i.qty)}</div>
    <div class="hlist">${i.hist.slice().reverse().map(e => `<div><span class="mute">${esc(e.at)}</span> ${e.type === 'place' ? `${esc(locName(e.loc))} に置いた` : e.type === 'alert' ? '優先アラート' : esc(e.data.to)} <span class="mute">(${esc(e.device)})</span></div>`).join('') || '<div class="mute">記録なし</div>'}</div>`, [{ label: '閉じる', cls: 'primary' }]);
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

/* ---------------- 置き場所 ---------------- */
VIEWS.locs = () => {
  const locs = Object.values(MAST.locs);
  return `<div class="head"><div><h1>置き場所</h1><div class="mute small">場所タグを台車・棚・検査エリアに貼っておくと、現場で読むだけで場所が記録されます。</div></div><button class="btn primary" onclick="printLocs()">場所タグを印刷</button></div>
  <div class="card sect"><h2>追加する</h2><div class="row"><input type="text" id="l_code" placeholder="コード 例: C-04" style="width:120px">
    <select id="l_type">${Object.values(LOC_KIND).map(t => `<option>${t}</option>`).join('')}</select><input type="text" id="l_name" placeholder="名称" style="width:180px">
    <label class="row"><input type="checkbox" id="l_pz"> 優先置き場</label><button class="btn primary" onclick="addLoc()">追加</button></div></div>
  <div class="card flush"><table class="tbl"><thead><tr><th>コード</th><th>種別</th><th>名称</th><th>優先置き場</th><th>置かれている部品</th></tr></thead><tbody>
  ${locs.map(l => `<tr><td class="mono"><b>${esc(l.code)}</b></td><td>${esc(l.type)}</td><td>${esc(l.name)}</td><td>${l.pz ? '<span class="pri">優先置き場</span>' : ''}</td><td class="num">${Object.values(ST.items).filter(i => i.loc === l.code).length}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">まだありません</td></tr>'}
  </tbody></table></div>`;
};
async function addLoc() {
  const code = $('l_code').value.trim().toUpperCase(); if (!code) return toast('コードを入れてください', true);
  try { await appendRows('locs', [[code, $('l_type').value, $('l_name').value.trim(), $('l_pz').checked ? '○' : '']]); MAST = await readMasters(); toast('追加しました'); render(); } catch (e) { toast(e.message, true); }
}
function printLocs() {
  printSheet(Object.values(MAST.locs).map(l => `<div class="ptag loc ${l.pz ? 'p' : ''}"><div data-qr="${esc(locQR(l))}" class="pq"></div><div class="pt"><div class="pk">置き場所 ${esc(l.type)}</div><div class="pn mono">${esc(l.code)}</div><div class="pm">${esc(l.name)}</div>${l.pz ? '<div class="pp">優先置き場</div>' : ''}</div></div>`));
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
  <section class="card"><h2>デモ用データ</h2><button class="btn" onclick="seedDemo()">デモ用のタグと置き場所を作る</button></section>`;

/* ---------------- デモ用データ ---------------- */
async function seedDemo() {
  const T = [['IHF-30112-A', 'タービンブレード 1段', 'L2610-03', 12, 1], ['IHF-30113-A', 'タービンブレード 2段', 'L2610-04', 8, 0], ['IHF-41005-C', '燃料ノズル', 'J2610-21', 4, 0],
    ['IHF-52001-D', 'ベアリング No.3', 'R2610-15', 2, 1], ['IHF-60340-A', 'シールリング', 'J2610-22', 30, 0], ['IHF-70015-B', '点火プラグ', 'J2610-23', 6, 0],
    ['HW-10011-M6', '六角ボルト M6', 'B2610-01', 200, 0], ['HW-10530-S', 'ロックワイヤ', 'B2610-07', 20, 0]];
  const L = [['T-01', '仮置き', '入荷口 左', ''], ['T-02', '仮置き', '入荷口 右', ''], ['C-01', '台車', '通常台車1', ''], ['C-02', '台車', '通常台車2', ''],
    ['CP-01', '台車', '優先台車1', '○'], ['K-N', '検査エリア', '通常品置き場', ''], ['K-P', '検査エリア', '優先品置き場', '○'], ['TP-01', '仮置き', '優先仮置き', '○']];
  let max = Math.max(0, ...Object.keys(MAST.tags).map(k => +k.replace(/\D/g, '') || 0));
  try {
    await appendRows('tags', T.map(([p, n, l, q, pr]) => [`T${pad(++max, 4)}`, p, n, l, String(q), pr ? '優先' : '', now()]));
    const have = new Set(Object.keys(MAST.locs));
    const nl = L.filter(l => !have.has(l[0])); if (nl.length) await appendRows('locs', nl);
    MAST = await readMasters(); rebuild(); toast('デモ用のタグと置き場所を作りました'); location.hash = '#tags'; render();
  } catch (e) { toast(e.message, true); }
}
boot();
