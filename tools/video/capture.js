/* =====================================================================================
   寸进链 · 讲解视频 · 场景捕获
   =====================================================================================
   用系统 Chrome（无头 + CDP）把讲解视频要用的每个场景跑一遍，截成帧存到 frames/。
   每个场景 = 一段旁白 + 若干张截图；截图里会带一个「虚拟鼠标指针」，
   这样合成出来的视频看起来像有人在真的操作。

     node tools/video/capture.js            # 需要服务已启动在 8901
   ===================================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9461;
const BASE = 'http://127.0.0.1:8901';
const OUT = __dirname;
const FRAMES = path.join(OUT, 'frames');
const SCENES_JSON = path.join(OUT, 'scenes.json');
const PROFILE = path.join(OUT, '_profile_' + Date.now());

// CJ_ONLY=S05,S06 只重跑指定场景，其余沿用上一轮截图（改一两个场景不用整轮重来）
const ONLY = (process.env.CJ_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO_USER = process.env.CJ_USER || 'cunjin005';

// 视口：16:9，导出成 1920×1080
const VW = 1600, VH = 900, DSF = 1.5;

// 清空上一轮的帧（逐个删，别用递归删目录 —— 会被安全策略拦下）
// 只重跑部分场景时不能清，旧帧还要接着用
fs.mkdirSync(FRAMES, { recursive: true });
if (!ONLY.length) {
  for (const f of fs.readdirSync(FRAMES)) {
    if (f.endsWith('.png')) { try { fs.unlinkSync(path.join(FRAMES, f)); } catch (e) { /* ignore */ } }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- CDP 底座 ------------------------------- */
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=' + VW + ',' + VH, '--remote-debugging-port=' + PORT,
  '--force-device-scale-factor=' + DSF,
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
    throw new Error('页面异常：' + String(d || JSON.stringify(r.exceptionDetails)).slice(0, 260));
  }
  return r.result && r.result.value;
}

async function getWs() {
  for (let i = 0; i < 80; i++) {
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

/* ---------------------------- 页面动作封装 ---------------------------- */
const CURSOR_CSS = `
#__ptr{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;
  transition:transform .55s cubic-bezier(.22,.61,.36,1);
  transform:translate(-100px,-100px);will-change:transform}
#__ptr svg{filter:drop-shadow(0 3px 6px rgba(15,23,42,.35))}
#__ptr.hit::after{content:'';position:absolute;left:-14px;top:-14px;width:44px;height:44px;border-radius:50%;
  border:2px solid rgba(99,102,241,.85);animation:__pr .5s ease-out forwards}
@keyframes __pr{from{transform:scale(.3);opacity:.95}to{transform:scale(1.25);opacity:0}}`;

async function injectCursor() {
  return ev(`(() => {
    if (document.getElementById('__ptr')) return 'has';
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(CURSOR_CSS)};
    document.head.appendChild(s);
    const d = document.createElement('div'); d.id = '__ptr';
    d.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M5 2.2l13.2 8.6-5.9 1.1 2.7 6.4-2.5 1.1-2.8-6.5-4.7 3.5z" fill="#fff" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(d);
    window.__ptr = d;
    return 'injected';
  })()`);
}

/** 把虚拟光标移到某个选择器上（返回是否找到） */
async function moveTo(sel, dx = 6, dy = 6, hold = 620) {
  const r = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
  })()`);
  if (!r) return false;
  const x = Math.round(Math.min(Math.max(r.x + dx, 8), VW - 34));
  const y = Math.round(Math.min(Math.max(r.y + dy, 8), VH - 34));
  await ev(`window.__ptr && (window.__ptr.style.transform='translate(${x}px,${y}px)')`);
  await sleep(hold);
  return true;
}

/** 真鼠标点击（在元素中心派发 CDP 鼠标事件，比 el.click() 更接近真人） */
async function clickAt(sel, dy = 0) {
  const r = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!r) return false;
  const x = Math.round(r.x), y = Math.round(r.y + dy);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(type === 'mouseMoved' ? 60 : 40);
  }
  return true;
}

/** 移动光标 → 点一下（带按压动画） */
async function clickWithCursor(sel, dy = 0, wait = 900) {
  const found = await moveTo(sel, 6, dy);
  if (!found) return false;
  await ev(`(() => { const p = document.getElementById('__ptr'); if (p) { p.classList.add('hit'); setTimeout(() => p.classList.remove('hit'), 500); } })()`);
  await clickAt(sel, dy);
  await sleep(wait);
  return true;
}

async function scrollTo(sel, opt) {
  const off = (opt && opt.offset) || 0;
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.scrollIntoView({ block: ${JSON.stringify((opt && opt.block) || 'center')}, behavior: 'smooth' });
    if (${off}) setTimeout(() => window.scrollBy(0, ${off}), 300);
    return true;
  })()`);
}

async function typeInto(sel, text) {
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.focus(); el.value = ''; } })()`);
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
    await sleep(55);
  }
  return true;
}

let shotIdx = 0;
const shots = [];

/** 截一帧（先补光标，再整页截图） */
async function frame(name, wait = 380) {
  await sleep(wait);
  await injectCursor();
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = name + '.png';
  fs.writeFileSync(path.join(FRAMES, file), Buffer.from(r.data, 'base64'));
  shots.push(file);
  shotIdx++;
  process.stdout.write(`    ▸ ${file}\n`);
  return file;
}

async function nav(url, wait = 3000) {
  await send('Page.navigate', { url });
  await sleep(wait);
  await injectCursor();
}

/**
 * 关掉页面上可能残留的弹层。
 * 注意 Page.navigate 到「同路径、只差 hash」的地址时浏览器不会重新加载页面，
 * 上一个场景留下的 modal 会一直盖在上面，后面的点击全打在遮罩上（踩过一次：
 * 徽章铸造的凭证弹窗盖住了商城，兑换按钮怎么点都没反应）。
 */
async function closeModals() {
  const n = await ev(`(() => {
    const list = document.querySelectorAll('.dlg [data-x], .dlg-f [data-no]');
    list.forEach((b) => b.click());
    return list.length;
  })()`);
  if (n) await sleep(450);
  return n;
}

/** 让浏览器自己带上登录 cookie（同源 fetch，Set-Cookie 由浏览器收下） */
async function ensureLogin(user = DEMO_USER) {
  const cur = await ev(`(async () => {
    try { const r = await fetch('/api/me').then((x) => x.json()); return (r.user && r.user.username) || null; }
    catch (e) { return null; }
  })()`);
  if (cur === user) return true;
  await ev(`(async () => {
    await fetch('/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(user)}, password: '123456' }) });
    return 'ok';
  })()`);
  await sleep(700);
  return true;
}

async function waitFor(expr, ms = 15000, step = 220) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch (e) { /* 页面在换 */ }
    await sleep(step);
  }
  return false;
}

/* ============================== 场景定义 ============================== */
/* 每个场景：id / title（章节标题）/ narr（旁白，一句一句写，字幕按句切） / run */
const SCENES = [];

/* ---- S01 开场：三端入口 ---- */
SCENES.push({
  id: 'S01', title: '项目概览 · 四个入口',
  narr: [
    '这是寸进链，一个把每日打卡积分和链上成就存证写进区块链的小平台。',
    '它一共有四个入口：学习者端负责每天签到、做任务、赚积分；链浏览器是公开的，能查到每一个区块和每一笔交易；',
    '运营管理端管人、管规则、管风控；凭证验真页面对任何第三方开放，不用登录就能验证一枚成就徽章是真是假。',
  ],
  run: async () => {
    await nav(BASE + '/', 3400);
    await ev('localStorage.clear()');
    await nav(BASE + '/', 3600);
    await moveTo('#navlink', 0, 0);
    await frame('S01_1');
    // 依次指出四个入口
    await moveTo('[data-act="openLogin"]', 0, 0, 500);
    await frame('S01_2');
    await nav(BASE + '/chain', 3200);
    await moveTo('#navlink', 0, 0);
    await frame('S01_3');
    await nav(BASE + '/admin', 3000);
    await moveTo('#gate', 0, 0);
    await frame('S01_4');
    await nav(BASE + '/verify', 3000);
    await moveTo('#view', 0, 0);
    await frame('S01_5');
  },
});

/* ---- S02 登录 ---- */
SCENES.push({
  id: 'S02', title: '学习者端 · 登录',
  narr: [
    '先看学习者端。用演示账号 cunjin005 登录，密码 123456。',
    '登录之后，顶部会显示出你的链上地址和当前积分——这个地址不是随便编的，它由一对 Ed25519 密钥的公钥推出来，你后面赚的每一分都由这把私钥签名。',
  ],
  run: async () => {
    await nav(BASE + '/', 3400);
    await clickWithCursor('[data-act="openLogin"]', 0, 900);
    await frame('S02_1');
    await typeInto('#au', 'cunjin005');
    await frame('S02_2', 500);
    await typeInto('#ap', '123456');
    await moveTo('[data-yes]', 0, 0, 400);
    await frame('S02_3');
    await clickWithCursor('[data-yes]', 0, 2600);
    await waitFor("document.body.innerText.indexOf('欢迎回来') >= 0 || document.querySelector('.toast')", 8000);
    await moveTo('#navlink', 0, 0, 600);
    await frame('S02_4');
  },
});

/* ---- S03 签到 → 上链 ---- */
SCENES.push({
  id: 'S03', title: '每日签到 · 一笔交易上链',
  narr: [
    '签到是这套系统里最小的一个动作，但背后跑的是一整套流程。',
    '点下立即签到，服务端先算奖励：基础分加上连续签到的加成，然后写业务流水、更新账户台账，',
    '最后发一笔带 Ed25519 签名的交易到交易池。',
    '稍等几秒出块，我们就能在链浏览器里看到它——这笔交易已经进了新区块，之后谁都改不动。',
  ],
  run: async () => {
    await nav(BASE + '/', 3400);
    await scrollTo('#view .card', { block: 'start', offset: -88 });
    await sleep(500);
    await moveTo('[data-act="checkin"]', 4, 4, 700);
    await frame('S03_1');
    await clickWithCursor('[data-act="checkin"]', 0, 2200);
    await waitFor("!!document.querySelector('#view .card')", 9000);
    await sleep(1100);
    await scrollTo('#view .card', { block: 'start', offset: -88 });
    await moveTo('#view', 0, 0, 400);
    await frame('S03_2');
    // 交易池里能看到刚发出去的那笔（出块间隔 15 秒，来得及）
    await nav(BASE + '/chain#/pool', 3400);
    await sleep(700);
    await moveTo('#view', 0, 0, 500);
    await frame('S03_3');
    // 等出块，再到区块列表：高度已经 +1，刚那笔就在里面
    await sleep(9000);
    await nav(BASE + '/chain#/blocks', 3800);
    await scrollTo('#view .blk-card', { block: 'start', offset: -88 });
    await sleep(700);
    await moveTo('#view .blk-card', 0, 0, 500);
    await frame('S03_4');
  },
});

/* ---- S04 任务与徽章 ---- */
SCENES.push({
  id: 'S04', title: '任务结算 · 铸造徽章',
  narr: [
    '任务区每天清零重置。勾掉一项任务就是一次完成事件，全部勾完还有当日全清奖励。',
    '徽章不一样，徽章是要铸造的。铸造会消耗积分，产出的是一张带序列号、验真码和 Merkle 路径的链上凭证——',
    '这张凭证，就是后面可以在任何一个第三方那里被验证的东西。',
  ],
  run: async () => {
    await nav(BASE + '/', 3400);
    // 勾掉两项任务
    const n = await ev("document.querySelectorAll('#view .tck[data-act=\\'toggleTask\\']:not(.done)').length");
    if (n > 0) {
      await scrollTo('#view .tck', { block: 'center' });
      await sleep(500);
      await clickWithCursor('#view .tck[data-act="toggleTask"]:not(.done)', 0, 1800);
      await frame('S04_1');
      const n2 = await ev("document.querySelectorAll('#view .tck[data-act=\\'toggleTask\\']:not(.done)').length");
      if (n2 > 0) {
        await clickWithCursor('#view .tck[data-act="toggleTask"]:not(.done)', 0, 1800);
        await frame('S04_2');
      }
    }
    // 徽章墙
    await nav(BASE + '/#/badges', 3600);
    await scrollTo('#view .badge-tile', { block: 'start', offset: -88 });
    await sleep(700);
    await moveTo('#view .badge-tile', 0, 0, 500);
    await frame('S04_3');
    // 挑一个「能铸造」的徽章：点下去会当场出一张带序列号的链上凭证
    const hasClaim = await ev(`(() => {
      const b = document.querySelector('[data-act="claim"]');
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    if (hasClaim) {
      await sleep(1000);
      await clickWithCursor('[data-act="claim"]', 0, 2400);
      const shown = await waitFor("!!document.querySelector('.dlg')", 9000);
      await sleep(800);
      if (shown) { await moveTo('.dlg', 0, 0, 500); await frame('S04_4'); }
    }
    // 收尾：关掉凭证弹窗，别让它盖住下一个场景
    await closeModals();
  },
});

/* ---- S05 商城兑换 ---- */
SCENES.push({
  id: 'S05', title: '积分商城 · 兑换即扣分',
  narr: [
    '积分不是只能看着。商城里的东西用积分兑换，确认之前它会明确告诉你：积分不可撤销。',
    '点下确认的瞬间就扣分，并且同样生成一笔链上交易——你花掉的每一分，链上都有据可查，运营端也没法偷偷改余额。',
  ],
  run: async () => {
    await nav(BASE + '/', 3200);            // 先整页重载，清掉上个场景残留的弹层
    await ensureLogin();
    await closeModals();
    await nav(BASE + '/#/shop', 3600);
    await scrollTo('#view .rw-card', { block: 'start', offset: -130 });
    await sleep(700);
    await moveTo('#view .rw-card', 0, 0, 500);
    await frame('S05_1');
    // 兑换要先过一次确认弹窗（「积分不可撤销」）
    await clickWithCursor('[data-act="redeem"]', 0, 1500);
    const hasDlg = await waitFor("!!document.querySelector('.dlg [data-yes]')", 9000);
    if (hasDlg) {
      await moveTo('.dlg [data-yes]', 0, 0, 400);
      await frame('S05_2');
      await clickWithCursor('.dlg [data-yes]', 0, 1500);
      await sleep(900);
      await moveTo('#view', 0, 0, 400);
      await frame('S05_3');
    }
  },
});

/* ---- S06 链浏览器 · 区块与交易 ---- */
SCENES.push({
  id: 'S06', title: '链浏览器 · 区块结构',
  narr: [
    '现在换到链浏览器，这个是公开的，谁都能看。',
    '每个区块里存着前一个区块的哈希、这一批交易的 Merkle 根、随机数和工作量证明。',
    '所以任何一块被改过，后面所有的块都会对不上——这也是为什么链上的数据改不了。',
  ],
  run: async () => {
    await nav(BASE + '/chain', 3400);
    await moveTo('#view', 0, 0, 500);
    await frame('S06_1');
    await nav(BASE + '/chain#/blocks', 3400);
    await scrollTo('#view .blk-card', { block: 'start' });
    await sleep(600);
    await moveTo('#view .blk-card', 0, 0, 500);
    await frame('S06_2');
    // 打开最新一块看详情
    await clickWithCursor('#view .blk-card', 0, 2200);
    await moveTo('#view', 0, 0, 600);
    await frame('S06_3');
  },
});

/* ---- S07 全链校验 ---- */
SCENES.push({
  id: 'S07', title: '一键全链校验',
  narr: [
    '这里可以一键跑全链校验。它会把每一个区块、每一笔交易从头到尾重算一遍：',
    '链式哈希对不对，Merkle 根对不对，工作量证明够不够难度，还有每一笔的 Ed25519 签名是不是本人签的。',
    '全部通过，说明这整条链到现在为止没有被任何人动过。',
  ],
  run: async () => {
    await nav(BASE + '/chain#/validate', 3400);
    await scrollTo('[data-act="validateAll"]', { block: 'center' });
    await sleep(500);
    await moveTo('[data-act="validateAll"]', 4, 4, 600);
    await frame('S07_1');
    await clickWithCursor('[data-act="validateAll"]', 0, 1200);
    await frame('S07_2', 800);
    await waitFor("(() => { const t=document.body.innerText; return t.indexOf('全部')>=0 && t.indexOf('校验通过')>=0; })()", 45000);
    await sleep(600);
    await scrollTo('#valOut', { block: 'center' });
    await moveTo('#valOut', 0, 0, 500);
    await frame('S07_3');
  },
});

/* ---- S08 篡改实验室 ---- */
SCENES.push({
  id: 'S08', title: '篡改实验室 · 改了必被抓',
  narr: [
    '那如果绕过系统，直接去数据库里改一笔金额呢？篡改实验室就是专门干这件事的。',
    '它提供六种改法，比如改交易金额、改时间戳、改签名。我们挑一个改一改，然后再跑一次校验。',
    '结果很直接：链会精确地告诉你是哪一个区块、哪一笔交易对不上。',
  ],
  run: async () => {
    await nav(BASE + '/chain#/lab', 3400);
    await scrollTo('.lab-card', { block: 'start' });
    await sleep(600);
    await moveTo('.lab-card', 0, 0, 600);
    await frame('S08_1');
    await clickWithCursor('[data-act="pickTamper"]', 0, 1300);
    await frame('S08_2');
    await scrollTo('[data-act="tamperGo"]', { block: 'center' });
    await clickWithCursor('[data-act="tamperGo"]', 0, 1400);
    await waitFor("(() => { const o=document.querySelector('#tamperOut'); return !!o && /抓到|不通过|失败|Merkle|对不上|不匹配|被改动/.test(o.innerText); })()", 25000);
    await sleep(700);
    await scrollTo('#tamperOut', { block: 'center' });
    await moveTo('#tamperOut', 0, 0, 500);
    await frame('S08_3');
  },
});

/* ---- S09 凭证验真 ---- */
SCENES.push({
  id: 'S09', title: '凭证验真 · 浏览器本地重算',
  narr: [
    '这是我认为整套系统里最有意思的一页：凭证验真。它不需要登录，也不需要相信这家平台。',
    '输入凭证号之后，浏览器会自己动手做四件事：查业务库、查凭证状态、核对链上那笔交易，',
    '最后用 WebCrypto 把 Merkle 路径在现场重算一遍。注意，这个重算是在你自己的浏览器里跑的，不是服务端告诉你的结论。',
    '如果一枚徽章被撤销过，页面会明确告诉你它还留在链上，但已经失效；随便编一个号码，它只会告诉你查不到。',
  ],
  run: async () => {
    const j = await fetch(BASE + '/api/verify/samples').then((r) => r.json());
    const good = (j.list.find((x) => x.status === 'valid') || j.list[0]).verify_code;
    const revoked = (j.list.find((x) => x.status === 'revoked') || {}).verify_code;

    await nav(BASE + '/verify', 3200);
    await moveTo('#view', 0, 0, 500);
    await frame('S09_1');

    await nav(BASE + '/verify?code=' + good, 4000);
    await waitFor("document.querySelectorAll('#verifySteps .st').length >= 4", 12000);
    await scrollTo('#verifySteps', { block: 'center' });
    await sleep(700);
    await moveTo('#verifySteps', 0, 0, 500);
    await frame('S09_2');
    await scrollTo('#view .cert', { block: 'center' });
    await sleep(600);
    await moveTo('#view .cert', 0, 0, 500);
    await frame('S09_3');

    if (revoked) {
      await nav(BASE + '/verify?code=' + revoked, 4000);
      await scrollTo('#view', { block: 'start' });
      await sleep(700);
      await moveTo('#view .cert', 0, 0, 500);
      await frame('S09_4');
    }
    await nav(BASE + '/verify?code=CJX-0000-0000-0000', 3400);
    await moveTo('#view', 0, 0, 600);
    await frame('S09_5');
  },
});

/* ---- S10 运营管理端 ---- */
SCENES.push({
  id: 'S10', title: '运营管理端 · 待办与三方对账',
  narr: [
    '最后是运营管理端，入口有一道登录门，普通用户进不来。',
    '进来第一屏不是数据大屏，而是「需要我处理的事」——风控告警、对账异常、待审核的兑换，每条后面都有个「去处理」，',
    '点下去会直接落到已经按这个问题排好序的列表，而不是把你丢进一张大表里自己找。',
    '三方对账这一页，把业务流水、账户台账和链上余额并排放在一起核对，三个数对得上，账才算干净。',
  ],
  run: async () => {
    await nav(BASE + '/admin', 3400);
    await moveTo('#gate', 0, 0, 600);
    await frame('S10_1');
    await typeInto('#lgU', 'ops_lin');
    await typeInto('#lgP', '123456');
    await moveTo('#lgGo', 0, 0, 500);
    await frame('S10_2');
    await clickWithCursor('#lgGo', 0, 3200);
    await waitFor("!document.querySelector('#shell').classList.contains('hide')", 15000);
    await sleep(2200);
    await moveTo('#view', 0, 0, 600);
    await frame('S10_3');
    const hasTodo = await ev("!!document.querySelector('[data-act=\\'goTodo\\']')");
    if (hasTodo) {
      await clickWithCursor('[data-act="goTodo"]', 0, 2800);
      await frame('S10_4');
    } else {
      await ev("document.querySelector('.adm-nav a[href=\\'#/risk\\']').click()");
      await sleep(2400);
      await frame('S10_4');
    }
    await nav(BASE + '/admin#/reconcile', 3600);
    await sleep(1800);
    await scrollTo('#view', { block: 'start' });
    await moveTo('#view', 0, 0, 500);
    await frame('S10_5');
    await nav(BASE + '/admin#/analytics', 3800);
    await sleep(2000);
    await scrollTo('#view', { block: 'start' });
    await moveTo('#view', 0, 0, 500);
    await frame('S10_6');
    await nav(BASE + '/admin#/chain', 3600);
    await sleep(1800);
    await moveTo('#view', 0, 0, 500);
    await frame('S10_7');
  },
});

/* ---- S11 技术栈收尾 ---- */
SCENES.push({
  id: 'S11', title: '技术栈与收尾',
  narr: [
    '最后说一下技术栈。后端是 Node.js 加 Express，数据库是 MySQL，一共二十三张表，每张表都灌了五十条以上的测试数据。',
    '区块链这一层是完全自己写的，没有用任何现成的链框架：SHA-256 链式哈希、Merkle 树、Ed25519 签名、工作量证明，都是自己实现的。',
    '前端是原生 ES 模块，没有构建步骤，图表和图标全部手写 SVG，不依赖任何 CDN。',
    '代码、数据库脚本、论文和产品开发文档都在项目里，启动只要一句话：npm start。',
  ],
  run: async () => {
    await nav(BASE + '/chain', 3400);
    await scrollTo('#view', { block: 'start' });
    await moveTo('#view', 0, 0, 600);
    await frame('S11_1');
    await nav(BASE + '/', 3400);
    await scrollTo('#view', { block: 'start' });
    await moveTo('#navlink', 0, 0, 600);
    await frame('S11_2');
  },
});

/* ============================== 主流程 ============================== */
(async () => {
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
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: DSF, mobile: false,
  });

  const prev = fs.existsSync(SCENES_JSON)
    ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
  const byId = new Map(prev.map((s) => [s.id, s]));

  for (const sc of SCENES) {
    if (ONLY.length && !ONLY.includes(sc.id)) continue;
    console.log(`\n[${sc.id}] ${sc.title}`);
    const before = shots.length;
    try {
      await sc.run();
    } catch (e) {
      console.log(`  !! 场景出错但继续：${e.message}`);
    }
    const mine = shots.slice(before);
    if (!mine.length) { console.log('  !! 这个场景一帧都没截到'); continue; }
    byId.set(sc.id, { id: sc.id, title: sc.title, narr: sc.narr, shots: mine });
  }

  // 按 SCENES 的定义顺序输出；只重跑部分场景时，把上一轮的结果接回来
  const manifest = [];
  for (const sc of SCENES) {
    const m = byId.get(sc.id);
    if (m) manifest.push(m);
  }

  fs.writeFileSync(SCENES_JSON, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('\n' + '─'.repeat(60));
  console.log(`场景 ${manifest.length} 个 · 本轮截图 ${shots.length} 张`
    + (ONLY.length ? `（只重跑 ${ONLY.join(',')}）` : ''));
  console.log('清单：' + path.join(OUT, 'scenes.json'));
  console.log('帧目录：' + FRAMES);

  child.kill();
  await sleep(900);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); }
  catch (e) { console.log('（临时目录稍后清：' + path.basename(PROFILE) + '）'); }
  process.exit(0);
})().catch(async (e) => {
  console.error('\n捕获脚本出错：' + e.message);
  child.kill();
  await sleep(600);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch (e2) { /* ignore */ }
  process.exit(2);
});
