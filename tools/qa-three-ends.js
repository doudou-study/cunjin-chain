/* =====================================================================================
   寸进链 · 三端端到端验收
   =====================================================================================
   用系统 Chrome（无头 + CDP）真点、真填、真断言，不只截图。
   验收范围：
     ① 用户端：渲染、导航、未登录引导、横向溢出
     ② 链浏览器：区块渲染、全链校验、篡改实验室（真的改一笔再跑校验）
     ③ 凭证验真：已撤销 / 有效 两条分支 + 浏览器本地 Merkle 重算
     ④ 运营管理端：登录 → 11 个页签逐个打开
     ⑤ 移动端 390 宽：是否真的降级、有没有横向溢出
   跑完打印「通过 N / 失败 M」和去重后的异常清单。

     node tools/qa-three-ends.js            # 需要服务已启动在 8901
   ===================================================================================== */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9455;                       // 别跟别的套件撞（本项目暂用 9455）
const BASE = 'http://127.0.0.1:8901';
const OUT = path.join(__dirname, '..', 'preview');
const PROFILE = path.join(__dirname, '_qa_profile_' + Date.now());

// 启动前清掉历史遗留的 Chrome 配置目录（上一次被文件锁挡住没删掉的那些）
try {
  const now = Date.now();
  for (const d of fs.readdirSync(__dirname)) {
    if (!/^(_qa_profile|_dbg)_\d+$/.test(d)) continue;
    const full = path.join(__dirname, d);
    const ageH = (now - Number(d.split('_').pop())) / 3600000;
    if (ageH < 1) continue;   // 一小时内不动，可能是别处正在跑的套件
    try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { /* 还被占着 */ }
  }
} catch (e) { /* 清不掉不影响验收 */ }

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const errs = [];
const fails = [];
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
  else { fail++; fails.push(label); console.log(`  ✗ ${label}  → 实际: ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1360,1000', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });

let seq = 0;
const pending = new Map();
let ws;

/** 每条 CDP 调用都带看门狗，避免无声挂住 */
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++seq;
    pending.set(mid, { resolve, reject });
    setTimeout(() => { if (pending.delete(mid)) reject(new Error('CDP 超时 ' + method)); }, 30000);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
      || JSON.stringify(r.exceptionDetails)).slice(0, 300));
  }
  return r.result && r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
}

async function nav(url, wait = 2600) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

/** 等某个条件成立（页面异步渲染完） */
async function waitFor(expr, ms = 9000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) { /* 页面还在换，忽略 */ }
    await sleep(step);
  }
  return false;
}

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const t = list.find((x) => x.type === 'page');
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch (e) { /* 等 Chrome */ }
    await sleep(250);
  }
  throw new Error('Chrome CDP 没起来');
}

const viewLen = "(document.querySelector('#view')||{innerHTML:''}).innerHTML.length";
const overflow = 'document.documentElement.scrollWidth - document.documentElement.clientWidth';

(async () => {
  // 先过一遍静态检查：前端模块的语法/导入导出错误会让整页静默空白，
  // 而且截图完全看不出来，放在最前面查最省事。
  console.log('\n【0】前端静态检查');
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'check-frontend.js')], { encoding: 'utf8' });
    ok('前端静态检查通过（语法 / 导入导出 / 页面资源）', out.indexOf('✓') === 0, out.trim().slice(2).slice(0, 70));
  } catch (e) {
    ok('前端静态检查', false, String(e.stdout || e.message).split('\n').slice(0, 3).join(' / '));
    console.log('\n静态检查没过，后面的浏览器断言没意义，先修静态问题。');
    process.exit(1);
  }

  ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e2) => {
    const m = JSON.parse(e2.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 260));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('CONSOLE ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  /* ==================== ① 用户端 ==================== */
  console.log('\n【1】用户端 /');
  await nav(BASE + '/', 3200);
  await ev('localStorage.clear()');
  await nav(BASE + '/', 3200);
  let len = await ev(viewLen);
  ok('页面渲染出内容（#view 非空）', len > 800, len + ' 字符');
  ok('顶部导航渲染了 8 个链接 + 链浏览器',
    (await ev("document.querySelectorAll('#navlink a').length")) === 9,
    await ev("document.querySelectorAll('#navlink a').length"));
  ok('未登录时显示登录/注册入口',
    (await ev("!!document.querySelector('[data-act=\"openLogin\"]')")) === true);
  ok('今日视图出了签到卡或任务区',
    (await ev("!!document.querySelector('#view .card')")) === true);
  ok('无横向溢出', (await ev(overflow)) <= 2, await ev(overflow));
  await shot('01-user-today.png');

  // 走一遍前端路由：点「徽章」和「商城」
  await ev("document.querySelector('#navlink a[href=\"#/badges\"]').click()");
  await sleep(2200);
  await shot('02-user-badges.png');
  ok('徽章墙渲染出徽章卡', (await ev("document.querySelectorAll('#view .badge-tile').length")) > 10,
    await ev("document.querySelectorAll('#view .badge-tile').length") + ' 张');
  ok('徽章图标不是「信息圈」兜底（medal/crown 等已补进图标表）',
    (await ev(`(() => {
      const t = document.querySelector('#view .badge-tile .badge-ico svg');
      if (!t) return 'no-svg';
      return t.innerHTML.indexOf('circle cx="12" cy="12" r="9"') === -1 ? 'ok' : 'info-fallback';
    })()`)) === 'ok');

  await ev("document.querySelector('#navlink a[href=\"#/shop\"]').click()");
  await sleep(2000);
  await shot('03-user-shop.png');
  ok('商城渲染出商品卡', (await ev("document.querySelectorAll('#view .rw-card').length")) > 8,
    await ev("document.querySelectorAll('#view .rw-card').length") + ' 件');

  /* ==================== ② 链浏览器 ==================== */
  console.log('\n【2】链浏览器 /chain');
  await nav(BASE + '/chain', 3200);
  len = await ev(viewLen);
  ok('链浏览器渲染出内容', len > 1500, len + ' 字符');
  ok('概览出现链高度', (await ev("document.body.innerText.indexOf('链高度') >= 0")) === true);
  await shot('04-chain-home.png');

  await ev("document.querySelector('#navlink a[href=\"#/blocks\"]').click()");
  await sleep(2400);
  ok('区块列表渲染出区块卡', (await ev("document.querySelectorAll('#view .blk-card').length")) > 8,
    await ev("document.querySelectorAll('#view .blk-card').length") + ' 张');
  await shot('05-chain-blocks.png');

  // 全链校验（真跑，几万个区块要算一会）
  await ev("document.querySelector('#navlink a[href=\"#/validate\"]').click()");
  await sleep(1500);
  await ev("(document.querySelector('[data-act=\"validateAll\"]')||{click(){}}).click()");
  const valOk = await waitFor(`(() => {
    const t = document.body.innerText;
    return t.indexOf('全部') >= 0 && t.indexOf('校验通过') >= 0;
  })()`, 40000);
  ok('全链校验真的跑完并通过（含签名与 Merkle 根）', valOk,
    (await ev("(document.querySelector('#valOut')||document.body).innerText.slice(0,90).replace(/\\n/g,' ')")));
  await shot('06-chain-validate.png');

  // 篡改实验室：改一笔链上金额，看链能不能抓住
  await ev("document.querySelector('#navlink a[href=\"#/lab\"]').click()");
  await sleep(2200);
  ok('篡改实验室列出 6 种篡改方式',
    (await ev("document.querySelectorAll('.lab-card').length")) === 6,
    await ev("document.querySelectorAll('.lab-card').length"));
  await shot('07-chain-lab.png');
  await ev(`(() => {
    const c = document.querySelector('[data-act="pickTamper"]');
    if (c) c.click();
    return c ? 'ok' : 'no-card';
  })()`);
  await sleep(1500);
  await ev("(document.querySelector('[data-act=\"tamperGo\"]')||{click(){}}).click()");
  const caught = await waitFor(`(() => {
    const o = document.querySelector('#tamperOut');
    return !!o && /抓到|不通过|失败|Merkle|对不上|不匹配|被改动/.test(o.innerText);
  })()`, 20000);
  ok('篡改后当场被链抓住（校验不通过）', caught,
    await ev("((document.querySelector('#tamperOut')||{}).innerText||'').slice(0,110).replace(/\\n/g,' ')"));
  await shot('08-chain-tamper.png');

  /* ==================== ③ 凭证验真 ==================== */
  console.log('\n【3】凭证验真 /verify');
  await nav(BASE + '/verify?code=CBWH-U9UZ-WZAD', 3400);
  len = await ev(viewLen);
  ok('验真页渲染出结果', len > 1500, len + ' 字符');
  const revokedText = await ev("document.body.innerText");
  ok('已撤销凭证被判为「已撤销」', /凭证已撤销/.test(revokedText), revokedText.slice(0, 40).replace(/\n/g, ' '));
  ok('撤销理由如实展示', /撤销理由|退还铸造|重复铸造|申请退回/.test(revokedText));
  ok('撤销时仍能证明链上交易存在（Merkle 本地重算通过）', /浏览器重算通过/.test(revokedText));
  await shot('09-verify-revoked.png');

  // 有凭证：走一遍本地 Merkle 重算
  const goodCode = await fetch(BASE + '/api/verify/samples').then((r) => r.json())
    .then((j) => (j.list.find((x) => x.status === 'valid') || j.list[0]).verify_code);
  await nav(BASE + '/verify?code=' + goodCode, 3400);
  const okText = await ev("document.body.innerText");
  ok('有效凭证被判为「凭证有效」', /凭证有效/.test(okText));
  ok('四步校验全通过（业务库/状态/链上/本地 Merkle）',
    (await ev("document.querySelectorAll('#verifySteps .st.ok').length")) === 4,
    await ev("document.querySelectorAll('#verifySteps .st.ok').length") + '/4');
  ok('Merkle 路径被展开给用户看',
    (await ev("document.body.innerText.indexOf('第 1 层') >= 0")) === true);
  ok('凭证卡渲染出持有人与序列号',
    (await ev("!!document.querySelector('#view .cert')")) === true);
  await shot('10-verify-valid.png');

  const badCode = 'CJX-0000-0000-0000';
  await nav(BASE + '/verify?code=' + badCode, 3000);
  ok('伪造/抄错的凭证号查不到', /查不到这个凭证/.test(await ev("document.body.innerText")));
  await shot('11-verify-notfound.png');

  /* ==================== ④ 运营管理端 ==================== */
  console.log('\n【4】运营管理端 /admin');
  await nav(BASE + '/admin', 3200);
  ok('未登录时出现登录门（不是直接放出管理界面）',
    (await ev("!document.querySelector('#gate').classList.contains('hide')")) === true);
  await shot('12-admin-gate.png');
  await ev("document.querySelector('#lgGo').click()");
  const logged = await waitFor("!document.querySelector('#shell').classList.contains('hide')", 12000);
  ok('用 ops_lin 登录成功并进入管理端', logged);
  await sleep(2600);
  ok('侧栏渲染出 11 个页签',
    (await ev("document.querySelectorAll('.adm-nav a').length")) === 11,
    await ev("document.querySelectorAll('.adm-nav a').length"));
  ok('概览第一屏是「需要我处理的事」',
    (await ev("document.body.innerText.indexOf('需要我处理的事') >= 0")) === true);
  ok('概览展示三方对账结论',
    (await ev("document.body.innerText.indexOf('三方对账') >= 0")) === true);
  await shot('13-admin-overview.png');

  // 逐个页签打开，断言每个都能渲染出内容
  // 注意：内容长度够 ≠ 渲染成功 —— 页面的异常兜底卡也是几百字，所以必须同时断言没有「加载失败」
  const TABS = ['users', 'rules', 'rewards', 'orders', 'risk', 'chain', 'reconcile', 'announce', 'audit', 'analytics'];
  for (const t of TABS) {
    await ev(`(() => { const a = document.querySelector('.adm-nav a[href="#/${t}"]'); if (a) a.click(); })()`);
    const rendered = await waitFor(`${viewLen} > 900`, 12000);
    const l2 = await ev(viewLen);
    const errCard = await ev(`(() => {
      const v = document.querySelector('#view');
      if (!v) return 'no-view';
      const m = v.innerText.match(/加载失败[\\s\\S]{0,120}/);
      return m ? m[0].replace(/\\s+/g, ' ').slice(0, 100) : '';
    })()`);
    ok(`页签「${t}」渲染出内容`, rendered && !errCard,
      errCard ? '渲染出异常兜底卡：' + errCard : l2 + ' 字符');
    if (t === 'risk' || t === 'chain' || t === 'analytics' || t === 'reconcile') {
      await sleep(600);
      await shot('14-admin-' + t + '.png');
    }
    await sleep(500);
  }

  // 概览的待办落点：点一下应该跳到「已按该问题排好序」的列表
  await ev("document.querySelector('.adm-nav a[href=\"#/overview\"]').click()");
  await sleep(2600);
  const hasTodo = await ev("!!document.querySelector('[data-act=\"goTodo\"]')");
  if (hasTodo) {
    await ev("document.querySelector('[data-act=\"goTodo\"]').click()");
    await sleep(2600);
    ok('待办「去处理」能跳到对应页签', (await ev(viewLen)) > 900, await ev(viewLen) + ' 字符');
    await shot('15-admin-todo-jump.png');
  } else {
    ok('概览当前没有待办（风控已清零）', true, '无待办，跳过落点测试');
  }

  /* ==================== ⑤ 移动端 ==================== */
  console.log('\n【5】移动端 390×844');
  await nav(BASE + '/', 3000);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  ok('移动端无横向溢出', (await ev(overflow)) <= 2, await ev(overflow));
  await shot('16-mobile-user.png');

  // 管理端窄屏：侧栏应降级成横排
  await nav(BASE + '/chain', 3000);
  await sleep(900);
  ok('链浏览器窄屏无横向溢出', (await ev(overflow)) <= 2, await ev(overflow));
  await shot('17-mobile-chain.png');
  await send('Emulation.clearDeviceMetricsOverride');

  /* ==================== 收尾 ==================== */
  console.log('\n' + '─'.repeat(58));
  const uniq = [...new Set(errs)];
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fails.length) console.log('失败项：\n  - ' + fails.join('\n  - '));
  if (uniq.length) {
    console.log(`\n页面异常/控制台错误 ${uniq.length} 条（去重后）：`);
    uniq.slice(0, 12).forEach((e) => console.log('  · ' + e));
  } else {
    console.log('没有捕获到任何页面异常或控制台错误。');
  }
  console.log('截图目录：' + OUT);

  child.kill();
  await sleep(800);
  // Chrome 放文件锁要一小会儿，给几次重试；删不掉就留给下次启动时清
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); }
  catch (e) { console.log('（临时目录暂时删不掉，下次启动会清：' + path.basename(PROFILE) + '）'); }
  process.exit(fail || uniq.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\n验收脚本自身出错：' + e.message);
  child.kill();
  await sleep(600);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch (e2) { /* ignore */ }
  process.exit(2);
});
