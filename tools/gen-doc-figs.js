/* =====================================================================================
   论文/开发文档配图渲染器
   -------------------------------------------------------------------------------------
   本机没有 graphviz / plantuml / mermaid-cli，所以配图全部手写 SVG（和项目 UI 一个路子：
   零外部依赖），再用系统 Chrome 无头模式渲染成 2× PNG 供 Word 插入。

     node tools/gen-doc-figs.js                 # 渲染 docs/figs/src/*.svg → docs/figs/*.png
     node tools/gen-doc-figs.js --only arch     # 只渲一张
   ===================================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9461;
const ROOT = path.join(__dirname, '..', 'docs', 'figs');
const SRC = path.join(ROOT, 'src');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const PROFILE = path.join(__dirname, '_figs_' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SRC)) { console.error('缺少目录：' + SRC); process.exit(1); }
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.svg'))
  .filter((f) => !ONLY || f.startsWith(ONLY));

if (!files.length) { console.error('没有可渲染的 SVG（' + SRC + '）'); process.exit(1); }

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=1400,1000',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });

let seq = 0;
const pending = new Map();
let ws;
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++seq;
    pending.set(mid, { resolve, reject });
    setTimeout(() => { if (pending.delete(mid)) reject(new Error('CDP 超时 ' + method)); }, 30000);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = l.find((x) => x.type === 'page');
      if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await send('Page.enable');

  let done = 0;
  for (const f of files) {
    const name = f.replace(/\.svg$/, '');
    const svg = fs.readFileSync(path.join(SRC, f), 'utf8');

    // 从 viewBox 推尺寸，SVG 里没写宽高时按 viewBox 撑满
    const vb = (svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || [])[1];
    const vbW = Number(vb || 0) || Number((svg.match(/viewBox="0 0 ([\d.]+)/) || [])[1]) || 1200;
    const vbH = Number((svg.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/) || [])[1]) || 800;

    // 页面外壳：白底、无内边距，让截图正好等于 SVG
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff}
      svg{display:block;width:${vbW}px;height:${vbH}px}
    </style></head><body>${svg}</body></html>`;
    const tmpHtml = path.join(ROOT, '_tmp.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');

    await send('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(vbW), height: Math.ceil(vbH), deviceScaleFactor: 2, mobile: false,
    });
    await send('Page.navigate', { url: 'file:///' + tmpHtml.replace(/\\/g, '/') });
    await sleep(700);

    const out = path.join(ROOT, name + '.png');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`  ✓ ${name}.png  ${Math.ceil(vbW)}×${Math.ceil(vbH)} @2x  ${kb}KB`);
    done++;
  }

  try { fs.rmSync(path.join(ROOT, '_tmp.html'), { force: true }); } catch (e) { /* ignore */ }
  child.kill();
  await sleep(700);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); } catch (e) { /* ignore */ }
  console.log(`共渲染 ${done} 张 → ${ROOT}`);
  process.exit(0);
})().catch(async (e) => {
  console.error('渲染出错：' + e.message);
  child.kill();
  await sleep(600);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); } catch (e2) { /* ignore */ }
  process.exit(2);
});
