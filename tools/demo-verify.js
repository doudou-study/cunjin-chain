/* =====================================================================================
   寸进链 · 线上演示版验收
   =====================================================================================
   发布之前必须自己在无头 Chrome 里把四个端走一遍 —— 「本地能返回 JSON」不等于
   「页面上真的能看」。断言只看渲染出来的结果，不看接口原样。

     node tools/demo-verify.js            # 需要 deploy-online 已在 3901 跑着
   ===================================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9479;
const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3901';
const OUT = path.join(__dirname, '..', 'preview');
const PROFILE = path.join(__dirname, '_dv_profile_' + Date.now());

let pass = 0, fail = 0;
const fails = [];
const errs = [];
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; fails.push(label); console.log('  ✗ ' + label + '  → 实际: ' + extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function nav(url, wait) { await send('Page.navigate', { url }); await sleep(wait || 3200); }

async function waitFor(expr, ms = 12000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) { /* 页面在换 */ }
    await sleep(step);
  }
  return false;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
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

const V = "(document.querySelector('#view')||{innerHTML:''}).innerHTML.length";
const TXT = '((document.querySelector("#view")||document.body).innerText||"")';
const OVF = 'document.documentElement.scrollWidth - document.documentElement.clientWidth';
// 界面上不该出现内部哨兵值或原始错误
const DIRT = '/(__[A-Z_]+__|UNAUTH|undefined|\\[object Object\\]|Error:)/';

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('CONSOLE ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  /* ---------------- ① 用户端 ---------------- */
  console.log('\n【1】用户端 ' + BASE + '/');
  // 公网首屏要把 data/snapshot.json（约 0.5MB）拉下来才开始渲染，本地 4s 够、公网看运气。
  // 所以只给一个短的起步等待，然后轮询到「真渲染出来」为止 —— 别用固定秒数赌网络。
  await nav(BASE + '/', 1200);
  /*
    就绪判断不能用量长度（`#view > 800`）—— 应用会分几帧画出中间态，先画个千把字符的骨架、
    再补数据。在中间态上就去改 location.hash，路由会错过这次变化，页面就停在半成品上，
    后面几条断言全跟着挂（而且控制台一条异常都没有，特别像「代码坏了」）。
    等到「马上要断言的那段内容」真出现为止，才说明应用启动完了。
  */
  await waitFor("document.body.innerText.indexOf('知远') >= 0", 45000, 500);
  ok('页面渲染出内容', (await ev(V)) > 800, await ev(V) + ' 字符');
  ok('顶部导航 8 个入口 + 链浏览器',
    (await ev('document.querySelectorAll("#navlink a").length')) === 9,
    await ev('document.querySelectorAll("#navlink a").length'));
  ok('以演示用户登录（不是未登录态）',
    (await ev('document.body.innerText.indexOf("知远") >= 0')) === true,
    await ev('document.body.innerText.replace(/\\s+/g," ").slice(0,36)'));
  ok('顶部注入了「只读演示」横幅', (await ev('!!document.querySelector("#__demo_banner")')) === true);
  ok('无横向溢出', (await ev(OVF)) <= 2, await ev(OVF));
  const t1 = await ev(TXT);
  ok('界面没漏出内部哨兵值/原始错误', new RegExp(DIRT).test(t1) === false,
    (t1.match(new RegExp(DIRT)) || [''])[0]);
  await shot('demo-01-user-today.png');

  for (const [h, name, marker] of [
    ['#/data', 'demo-02-user-data.png', '签到'],
    ['#/badges', 'demo-03-user-badges.png', '徽章'],
    ['#/shop', 'demo-04-user-shop.png', '积分'],
  ]) {
    await ev('location.hash="' + h + '"');
    // 每个页签都要现拉一次数据，同样别赌固定秒数
    await waitFor("((document.querySelector('#view')||{innerText:''}).innerText||'').indexOf('" + marker + "') >= 0", 25000, 400);
    const t = await ev(TXT);
    ok('用户端 ' + h + ' 渲染出内容', t.length > 200 && t.indexOf(marker) >= 0,
      t.length + ' 字符 / 含「' + marker + '」=' + (t.indexOf(marker) >= 0));
    await shot(name);
  }

  /* ---------------- ② 链浏览器 ---------------- */
  console.log('\n【2】链浏览器 ' + BASE + '/chain');
  await nav(BASE + '/chain', 1200);
  await waitFor(TXT + ".indexOf('链高度') >= 0", 45000, 500);
  ok('出现链高度', (await ev(TXT + '.indexOf("链高度") >= 0')) === true);
  await ev('location.hash="#/blocks"');
  await waitFor('document.querySelectorAll("#view .blk-card").length > 8', 30000, 400);
  ok('区块列表渲染出区块卡',
    (await ev('document.querySelectorAll("#view .blk-card").length')) > 8,
    await ev('document.querySelectorAll("#view .blk-card").length') + ' 张');
  await shot('demo-05-chain-blocks.png');

  await ev('location.hash="#/validate"');
  await waitFor('!!document.querySelector("[data-act=\'validateAll\']")', 30000, 400);
  await ev('(document.querySelector("[data-act=\'validateAll\']")||{click:function(){}}).click()');
  const valOk = await waitFor('document.body.innerText.indexOf("校验通过")>=0', 30000, 400);
  ok('全链校验在演示版里也能给出结论', valOk,
    (await ev('(document.querySelector("#valOut")||document.body).innerText.slice(0,70).replace(/\\n/g," ")')));

  await ev('location.hash="#/lab"');
  await waitFor('document.querySelectorAll(".lab-card").length === 6', 30000, 400);
  ok('篡改实验室列出 6 种篡改方式',
    (await ev('document.querySelectorAll(".lab-card").length')) === 6,
    await ev('document.querySelectorAll(".lab-card").length'));
  await shot('demo-06-chain-lab.png');

  /* ---------------- ③ 运营管理端 ---------------- */
  console.log('\n【3】运营管理端 ' + BASE + '/admin');
  await nav(BASE + '/admin', 4000);
  ok('先出登录门（未登录不露面板）',
    (await ev('!document.querySelector("#gate").classList.contains("hide")')) === true);
  await ev('(document.querySelector("#lgGo")||{click:function(){}}).click()');
  // 公网加载比本地慢：admin.js 可能还没绑好登录按钮的监听，点一次等于点空。
  // 所以「点 → 查侧栏是否出来 → 没出来再点」，而不是点一次就信、再干等固定秒数。
  // 侧栏链接的数量就是「登录成功且外壳渲染完」的可靠信号。
  let navN = 0;
  const tEnter = Date.now();
  while (Date.now() - tEnter < 30000) {
    navN = await ev('document.querySelectorAll("#navlink a").length');
    if (navN >= 11) break;
    await ev('(document.querySelector("#lgGo")||{click:function(){}}).click()');
    await sleep(700);
  }
  ok('用演示账号登录后进入管理端外壳', navN >= 11, navN);
  ok('管理端侧栏渲染 11 个页签', navN === 11, navN);
  await shot('demo-07-admin-overview.png');

  let tabsOk = 0;
  for (const t of ['users', 'rules', 'rewards', 'orders', 'risk', 'chain', 'reconcile', 'announce', 'audit', 'analytics']) {
    await ev('location.hash="#/' + t + '"');
    await waitFor(V + ' > 500', 25000, 400);
    if ((await ev(V)) > 500) tabsOk++;
  }
  ok('其余 10 个页签逐个都能渲染出内容', tabsOk === 10, tabsOk + '/10');

  /* ---------------- ④ 凭证验真 ---------------- */
  console.log('\n【4】凭证验真 ' + BASE + '/verify');
  await nav(BASE + '/verify?code=CBWH-U9UZ-WZAD', 1200);
  await waitFor(TXT + ".indexOf('Merkle') >= 0 || " + TXT + ".indexOf('撤销') >= 0", 45000, 500);
  const vTxt = await ev(TXT);
  ok('验真结果正常渲染（没落到「查询失败」）',
    vTxt.indexOf('查询失败') < 0 && (vTxt.indexOf('撤销') >= 0 || vTxt.indexOf('Merkle') >= 0),
    vTxt.replace(/\s+/g, ' ').slice(0, 90));
  ok('验真页没漏出内部哨兵值', new RegExp(DIRT).test(vTxt) === false,
    (vTxt.match(new RegExp(DIRT)) || [''])[0]);
  await shot('demo-08-verify.png');

  /* ---------------- 汇总 ---------------- */
  const uniq = [...new Set(errs)];
  console.log('\n' + '─'.repeat(62));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fails.length) console.log('  失败项：' + fails.join(' | '));
  console.log('  控制台异常：' + uniq.length + ' 条');
  uniq.slice(0, 6).forEach((e) => console.log('     ' + e));
  console.log('─'.repeat(62) + '\n');

  try { ws.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 占着就算了 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n验收脚本崩了：' + e.message);
  try { child.kill(); } catch (_) { /* ignore */ }
  process.exit(2);
});
