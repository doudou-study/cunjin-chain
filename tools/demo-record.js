/* =====================================================================================
   寸进链 · 线上演示快照录制
   =====================================================================================
   线上发布沙箱只给「一个 HTTP 端口」，跑不了 MySQL。所以线上版走「只读快照回放」：
   这里在**真实数据库**环境下用无头 Chrome 把四个端真走一遍，
   拦截前端实际发出的每一条 /api 请求与响应，落成 snapshot.json。

   录制策略：
     · 注入 fetch 钩子（Page.addScriptToEvaluateOnNewDocument），页面加载前就挂上
     · 同一个接口记两次：精确 URL（带参数）优先，归一化模式（数字段→*）兜底
     · 只保留 200 的 JSON 与 SVG；登录/登出/验真这类「读语义」的 POST 也录

     node tools/demo-record.js          # 需要 8901 已经在跑
   ===================================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9477;                       // 别跟别的套件撞
const BASE = 'http://127.0.0.1:8901';
const OUTDIR = path.join(__dirname, '..', 'deploy-online', 'data');
const OUT = path.join(OUTDIR, 'snapshot.json');
const PROFILE = path.join(__dirname, '_rec_profile_' + Date.now());

const USER = { username: 'cunjin005', password: '123456' };
const ADMIN = { username: 'admin', password: '123456' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 页面内的拦截钩子 ------------------------------ */
// 注意：不能出现反引号，整段会作为普通字符串注入
const HOOK = [
  'window.__REC__ = []; window.__REC_PEND__ = 0;',
  '(function(){',
  '  var of = window.fetch;',
  '  window.fetch = function(input, init){',
  '    var url = (typeof input === "string") ? input : ((input && input.url) || "");',
  '    var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();',
  '    var body = (init && init.body) ? String(init.body) : null;',
  '    return of.apply(this, arguments).then(function(res){',
  '      var ct = (res.headers && res.headers.get) ? (res.headers.get("content-type") || "") : "";',
  '      window.__REC_PEND__++;',
  '      var done = function(t){',
  '        window.__REC__.push({ url: url, method: method, body: body, status: res.status, ct: ct, text: t });',
  '        window.__REC_PEND__--;',
  '      };',
  '      try { res.clone().text().then(done, function(){ done(null); }); }',
  '      catch (e) { window.__REC_PEND__--; }',
  '      return res;',
  '    });',
  '  };',
  '})();',
].join('\n');

/* ------------------------------ 快照键 ------------------------------ */
function patternOf(url) {
  let u;
  try { u = new URL(url, BASE); } catch (e) { return url; }
  const p = u.pathname.replace(/\/(\d+|[0-9a-fA-F]{12,})(?=\/|$)/g, '/*');
  const keys = [...u.searchParams.keys()].sort().join(',');
  return p + (keys ? '?' + keys : '');
}

const exact = new Map();     // "GET /api/me"          → 记录
const pattern = new Map();   // "GET /api/me"          → 记录（数字段已归一）
let recCount = 0;

function keep(rec) {
  if (!rec || !rec.url) return;
  if (rec.url.indexOf('/api/') === -1) return;
  if (rec.text === null || rec.text === undefined) return;
  if (rec.status !== 200) return;
  const isJson = String(rec.ct).indexOf('json') >= 0;
  const isSvg = String(rec.ct).indexOf('svg') >= 0;
  if (!isJson && !isSvg) return;

  const ek = rec.method + ' ' + rec.url;
  const pk = rec.method + ' ' + patternOf(rec.url);
  if (!exact.has(ek)) { exact.set(ek, rec); recCount++; }
  if (!pattern.has(pk)) pattern.set(pk, rec);
}

/* ------------------------------ CDP ------------------------------ */
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1440,1000', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });

let seq = 0;
const pending = new Map();
let ws;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++seq;
    pending.set(mid, { resolve, reject });
    setTimeout(() => { if (pending.delete(mid)) reject(new Error('CDP 超时 ' + method)); }, 40000);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error('页面异常：' + String(d || JSON.stringify(r.exceptionDetails)).slice(0, 240));
  }
  return r.result && r.result.value;
}

async function nav(url, wait = 2600) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

async function waitFor(expr, ms = 12000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) { /* 页面在换 */ }
    await sleep(step);
  }
  return false;
}

/** 把当前文档里攒下的记录收进快照，然后清空 */
async function collect(tag) {
  await waitFor('window.__REC_PEND__ === 0', 8000, 150);
  const raw = await ev('JSON.stringify(window.__REC__||[])');
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (e) { list = []; }
  const before = recCount;
  list.forEach(keep);
  await ev('window.__REC__=[]');
  console.log(`   · ${tag}：文档内 ${list.length} 条，快照新增 ${recCount - before}`);
}

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const t = list.find((x) => x.type === 'page');
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch (e) { /* 等 Chrome */ }
    await sleep(250);
  }
  throw new Error('Chrome CDP 没起来');
}

const LOGIN = (u, p) => 'fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},'
  + 'body:JSON.stringify({username:"' + u + '",password:"' + p + '"})}).then(function(r){return r.text()})';

/* ------------------------------ 主流程 ------------------------------ */
(async () => {
  ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

  console.log('\n【1】用户端 /');
  await nav(BASE + '/', 3800);
  await ev('window.__REC__=[]');                       // 丢掉未登录那批
  await ev(LOGIN(USER.username, USER.password));       // 登录取 Cookie
  await sleep(1200);
  await ev('window.__REC__=[]');                       // 登录本身单独留一次即可
  await nav(BASE + '/', 3600);                         // 带 Cookie 重载，录登录态
  for (const h of ['#/today', '#/data', '#/badges', '#/shop', '#/stake', '#/teams', '#/rank', '#/donate']) {
    await ev('location.hash="' + h + '"');
    await sleep(2100);
  }
  await collect('用户端');

  console.log('\n【2】链浏览器 /chain');
  await nav(BASE + '/chain', 3600);
  for (const h of ['#/', '#/blocks', '#/txs', '#/pool', '#/lab']) {
    await ev('location.hash="' + h + '"');
    await sleep(2200);
  }
  await ev('location.hash="#/validate"');
  await sleep(1500);
  await ev('(document.querySelector("[data-act=\'validateAll\']")||{click:function(){}}).click()');
  await waitFor('document.body.innerText.indexOf("校验通过")>=0', 60000, 600);
  await sleep(1500);
  await collect('链浏览器');

  console.log('\n【3】运营管理端 /admin');
  await nav(BASE + '/admin', 3600);
  await ev('window.__REC__=[]');
  await ev(LOGIN(ADMIN.username, ADMIN.password));
  await sleep(1200);
  await ev('window.__REC__=[]');
  await nav(BASE + '/admin', 3600);
  for (const t of ['overview', 'users', 'rules', 'rewards', 'orders', 'risk', 'chain', 'reconcile', 'announce', 'audit', 'analytics']) {
    await ev('location.hash="#/' + t + '"');
    await sleep(2300);
  }
  await collect('管理端');

  console.log('\n【4】凭证验真 /verify');
  await nav(BASE + '/verify', 3200);
  const sm = await ev('fetch("/api/verify/samples").then(function(r){return r.text()})');
  let codes = [];
  try { codes = (JSON.parse(sm).list || []).slice(0, 3).map((x) => x.verify_code); } catch (e) { codes = []; }
  console.log('   样例凭证：' + (codes.join(', ') || '（没取到）'));
  // 注意：__REC__ 是挂在 window 上的，**每次整页导航都会归零**。
  // 这里每个凭证号都是一次整页导航，所以必须「导航一次收一次」，
  // 否则只剩最后一次的记录（第一版就是这么漏掉前两个凭证号的）。
  for (const c of codes) {
    await nav(BASE + '/verify?code=' + encodeURIComponent(c), 3800);
    await collect('验真 ' + c);
  }

  /* ------------------------------ 落盘 ------------------------------ */
  const dump = {
    meta: {
      recordedAt: new Date().toISOString(),
      source: BASE,
      demoUser: USER.username,
      note: '由 tools/demo-record.js 从真实 MySQL 环境录制，仅用于线上只读演示',
    },
    exact: Object.fromEntries([...exact.entries()].map(([k, v]) => [k, { status: v.status, ct: v.ct, text: v.text }])),
    pattern: Object.fromEntries([...pattern.entries()].map(([k, v]) => [k, { status: v.status, ct: v.ct, text: v.text }])),
  };
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dump));

  const size = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log('\n' + '─'.repeat(60));
  console.log('  快照已写出：' + OUT);
  console.log('  精确键 ' + exact.size + ' 条 · 归一化键 ' + pattern.size + ' 条 · ' + size + ' MB');
  console.log('─'.repeat(60) + '\n');

  try { ws.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 被占着就算了 */ }
  process.exit(0);
})().catch((e) => {
  console.error('\n录制失败：' + e.message);
  try { child.kill(); } catch (_) { /* ignore */ }
  process.exit(1);
});
