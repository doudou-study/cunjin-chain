/* =====================================================================================
   寸进链 · 把只读演示打包成「纯静态」目录（deploy-static/）
   =====================================================================================
   为什么需要：
     deploy-online/ 要起一个 Node 进程来回放接口快照，而 Surge / Pages / Netlify 这类
     免费静态托管只收文件、不给跑进程。所以把回放逻辑挪进浏览器（tools/demo-shim.js），
     于是整个演示站变成纯静态，任何静态托管都能收。

   做什么：
     1. 复制 deploy-online/public/ 与 data/
     2. 放进 demo-shim.js，并往每个 HTML 的 </body> 前插一个 <script>
     3. 额外生成 chain/ admin/ verify/ 三个目录页（兼容不做 clean URL 的托管）
     4. 生成一份 404.html（放行 SPA 用的 hash 路由）

     node tools/build-static.js
   ===================================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_PUBLIC = path.join(ROOT, 'deploy-online', 'public');
const SRC_DATA = path.join(ROOT, 'deploy-online', 'data');
const SHIM = path.join(__dirname, 'demo-shim.js');
const OUT = path.join(ROOT, 'deploy-static');

/* ------------------------------ 工具 ------------------------------ */
function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) cpDir(a, b);
    else fs.copyFileSync(a, b);
  }
}
function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ------------------------------ 1) 骨架 ------------------------------ */
rmrf(OUT);
cpDir(SRC_PUBLIC, OUT);
cpDir(SRC_DATA, path.join(OUT, 'data'));
fs.copyFileSync(SHIM, path.join(OUT, 'demo-shim.js'));

/* ------------------------------ 2) 注入 shim ------------------------------ */
/*
  shim 必须排在业务脚本之前、且同步执行 —— 它要抢在 app.js 调用 fetch 之前换掉 window.fetch。
  src 用相对路径：部署在子目录时也能正确反推出快照地址。
*/
const PAGES = ['index.html', 'chain.html', 'admin.html', 'verify.html'];

let injected = 0;
for (const name of PAGES) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) continue;
  let html = fs.readFileSync(p, 'utf8');
  if (html.indexOf('demo-shim.js') >= 0) continue;      // 幂等
  const tag = '<script src="demo-shim.js"></script>\n</body>';
  html = html.indexOf('</body>') >= 0
    ? html.replace('</body>', tag)
    : html + tag;
  fs.writeFileSync(p, html, 'utf8');
  injected++;
}

/* ------------------------------ 3) 目录页（兼容不做 clean URL 的托管） ------------------------------ */
const CLEAN = { 'chain': 'chain.html', 'admin': 'admin.html', 'verify': 'verify.html' };
let dirPages = 0;
for (const dir of Object.keys(CLEAN)) {
  const srcFile = path.join(OUT, CLEAN[dir]);
  if (!fs.existsSync(srcFile)) continue;
  const sub = path.join(OUT, dir);
  fs.mkdirSync(sub, { recursive: true });
  // 这一层要往上一级找 shim
  let html = fs.readFileSync(srcFile, 'utf8').replace('<script src="demo-shim.js"></script>', '<script src="../demo-shim.js"></script>');
  fs.writeFileSync(path.join(sub, 'index.html'), html, 'utf8');
  dirPages++;
}

/* ------------------------------ 4) 域名绑定（surge 认这个文件） ------------------------------ */
/*
  重新生成静态包会清空目录，surge 之前写下的 CNAME 会一起没掉。
  这里主动写回去，之后 `surge <dir> publish` 就能沿用同一个域名。
  换域名就改这一处。
*/
const DOMAIN = 'cunjin-chain.surge.sh';
fs.writeFileSync(path.join(OUT, 'CNAME'), DOMAIN + '\n', 'utf8');

/* ------------------------------ 5) 报告 ------------------------------ */
const files = walk(OUT);
let bytes = 0;
for (const f of files) bytes += fs.statSync(f).size;

console.log('');
console.log('  寸进链 · 静态演示包已生成');
console.log('  ────────────────────────────────────────────────');
console.log('  目录     ' + OUT);
console.log('  注入     ' + injected + ' 个 HTML');
console.log('  目录页   ' + dirPages + ' 个（chain / admin / verify）');
console.log('  文件数   ' + files.length);
console.log('  体积     ' + (bytes / 1024).toFixed(0) + ' KB');
console.log('');
console.log('  本地自测：node tools/static-preview.js');
console.log('');
