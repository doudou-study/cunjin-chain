/* =====================================================================================
   寸进链 · 把只读演示打包成「纯静态」目录（默认 deploy-static/）
   =====================================================================================
   为什么需要：
     deploy-online/ 要起一个 Node 进程来回放接口快照，而 Surge / Pages / Netlify 这类
     免费静态托管只收文件、不给跑进程。所以把回放逻辑挪进浏览器（tools/demo-shim.js），
     于是整个演示站变成纯静态，任何静态托管都能收。

   做什么：
     1. 复制 deploy-online/public/ 与 data/
     2. 按 --base 重写站内绝对路径（部署在子目录时是必须的，见下）
     3. 放进 demo-shim.js，并往每个 HTML 的 </body> 前插一个 <script>
     4. 额外生成 chain/ admin/ verify/ 三个目录页（兼容不做 clean URL 的托管）
     5. 生成一份 404.html（放行 SPA 用的 hash 路由）

   用法：
     node tools/build-static.js
       → deploy-static/   根路径部署（surge.sh），会写 CNAME

     node tools/build-static.js --base=/cunjin-chain/ --out=deploy-pages --cname=0
       → GitHub Pages 项目站点：站点挂在 https://<user>.github.io/<repo>/ 子路径下

   为什么必须分两套 base：
     源码里的资源引用是绝对路径（/css/app.css、/chain、/js/app.js）。
     放在域名根时正确；放在 GitHub Pages 的子路径下，浏览器会去请求
     https://<user>.github.io/css/app.css —— 404，整页白屏。
     所以子路径部署必须把这些前缀补上。同一份产物没法同时满足两者。
   ===================================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------ 参数 ------------------------------ */
function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : def;
}
const BASE = arg('base', '/').replace(/\/+$/, '/');          // 统一以单个 / 结尾
const OUT_NAME = arg('out', 'deploy-static');
const WRITE_CNAME = arg('cname', BASE === '/' ? '1' : '0') === '1';

const ROOT = path.join(__dirname, '..');
const SRC_PUBLIC = path.join(ROOT, 'deploy-online', 'public');
const SRC_DATA = path.join(ROOT, 'deploy-online', 'data');
const SHIM = path.join(__dirname, 'demo-shim.js');
const OUT = path.join(ROOT, OUT_NAME);

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

/* ------------------------------ 2) 站内绝对路径加前缀 ------------------------------ */
/*
  只改「属性值恰好是站内路径」和「location.href 赋值的站内路径」两类，
  不碰 /api/**（那些由 shim 拦截）、不碰 //cdn 这种协议相对地址、不碰 data: URI。
  目录页（chain/ admin/ verify/）用的是同一份 HTML，前缀也就一致 —— 不必按深度区分。
*/
let htmlFixed = 0, jsFixed = 0;
if (BASE !== '/') {
  const HTML_RE = /="(\/(?!\/)[^"]*)"/g;                       // =" /xxx"  与  =" /"

  /*
    JS 里不能用上面那种通配规则 —— 源码里到处是 SVG 片段（"/><path d="）和正则字面量（"/g），
    长得跟站内路径一模一样，通配会当场改坏。所以这里改成白名单，只认真正的页面和资源目录。
    注意 admin.js 是用模板字符串拼 HTML 的，href="/chain" 藏在前端 JS 里，别只盯着 HTML 文件看。
  */
  const JS_RULES = [
    [/(["'`])\/(chain|verify|admin)(?=["'`#?/])/g, (m, q, seg) => q + BASE + seg],        // '/verify?code='、`/chain#/tx/`
    [/(["'`])\/(css|js|img|data)\//g, (m, q, seg) => q + BASE + seg + '/'],              // '/css/app.css'
    [/(["'`])\/(?=["'`])/g, (m, q) => q + BASE]                                          // 裸根 '"/"'
  ];

  for (const f of walk(OUT)) {
    if (f.endsWith('.html')) {
      const t = fs.readFileSync(f, 'utf8');
      const n = t.replace(HTML_RE, (_m, p) => '="' + BASE + p.slice(1) + '"');
      if (n !== t) { fs.writeFileSync(f, n, 'utf8'); htmlFixed++; }
    } else if (f.endsWith('.js') && path.basename(f) !== 'demo-shim.js') {
      // demo-shim.js 自己要靠 <script src> 反推部署根，改了它反而坏事
      const t = fs.readFileSync(f, 'utf8');
      let n = t;
      for (const [re, fn] of JS_RULES) n = n.replace(re, fn);
      if (n !== t) { fs.writeFileSync(f, n, 'utf8'); jsFixed++; }
    }
  }
}

/* ------------------------------ 3) 注入 shim ------------------------------ */
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
  /*
    src 必须写成「前缀 + demo-shim.js」这种绝对路径，不能用相对的 demo-shim.js / ../demo-shim.js ——
    相对路径取决于文档 URL 的目录，而 /chain 这种不带尾斜杠的 URL 会被托管解析成文件，
    ../ 于是退到域名根，shim 404，整页只剩一句「请求失败」，看着像后端挂了（真踩过）。
    前缀是构建时已知的，写死最稳；shim 自己也是靠这个 src 反推部署根的。
  */
  const tag = '<script src="' + BASE + 'demo-shim.js"></script>\n</body>';
  html = html.indexOf('</body>') >= 0
    ? html.replace('</body>', tag)
    : html + tag;
  fs.writeFileSync(p, html, 'utf8');
  injected++;
}

/* ------------------------------ 4) 目录页（兼容不做 clean URL 的托管） ------------------------------ */
const CLEAN = { 'chain': 'chain.html', 'admin': 'admin.html', 'verify': 'verify.html' };
let dirPages = 0;
for (const dir of Object.keys(CLEAN)) {
  const srcFile = path.join(OUT, CLEAN[dir]);
  if (!fs.existsSync(srcFile)) continue;
  const sub = path.join(OUT, dir);
  fs.mkdirSync(sub, { recursive: true });
  // 直接复用根级那份：shim 用的是绝对前缀，放在哪一层都对，不必再往上一级找
  fs.copyFileSync(srcFile, path.join(sub, 'index.html'));
  dirPages++;
}

/* ------------------------------ 5) 域名绑定（surge 认这个文件） ------------------------------ */
/*
  重新生成静态包会清空目录，surge 之前写下的 CNAME 会一起没掉。
  这里主动写回去，之后 `surge <dir> publish` 就能沿用同一个域名。
  换域名就改这一处。

  ⚠️ GitHub Pages 那份（--cname=0）绝不能带 CNAME：
     文件里写的是 surge 的域名，Pages 读到会去认领一个不属于它的自定义域名，
     结果 github.io 地址直接 404。
*/
const DOMAIN = 'cunjin-chain.surge.sh';
let cname = '不写（本次 --cname=0）';
if (WRITE_CNAME) {
  fs.writeFileSync(path.join(OUT, 'CNAME'), DOMAIN + '\n', 'utf8');
  cname = DOMAIN;
}

/* ------------------------------ 6) 残留扫描 ------------------------------ */
/*
  加了前缀之后如果还有漏网的站内绝对路径，子路径部署就会白屏。
  这里扫一遍（只看引号包起来的），非空就是有问题 —— 别删这段。
*/
/*
  ⚠️ JS 侧不能用通配扫：源码里到处是 SVG 片段（"/><path d="）、正则字面量（"/g）、
     favicon 那串内联 data URI（%3C/svg%3E），长得跟站内路径一模一样，
     通配扫会刷一屏假警报。所以 JS 只扫「白名单类型」的路径 —— 命中即漏改。
*/
const leftovers = [];
if (BASE !== '/') {
  const HTML_SCAN = /="(\/(?!\/)[^"]*)"/g;
  const URL_SCAN = /url\((\/(?!\/)[^)]*)\)/g;
  const JS_SCAN = /(["'`])\/(chain|verify|admin|css|js|img|data)(?=["'`#?/.])/g;
  const push = (rel, u) => { if (leftovers.indexOf(rel + '  →  ' + u) < 0) leftovers.push(rel + '  →  ' + u); };

  for (const f of walk(OUT)) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    if (path.basename(f) === 'demo-shim.js') continue;      // 它自己算部署根
    const rel = path.relative(OUT, f).replace(/\\/g, '/');
    const t = fs.readFileSync(f, 'utf8');
    const isJs = f.endsWith('.js');

    let m;
    const re = isJs ? JS_SCAN : HTML_SCAN;
    while ((m = re.exec(t))) {
      // JS 命中的是 "/seg"，说明没经过白名单替换 —— 一律报；HTML 命中的要排除已加前缀的
      if (!isJs && m[1].indexOf(BASE) === 0) continue;
      push(rel, isJs ? '/' + m[2] + '…' : m[1]);
    }
    if (!isJs) {
      while ((m = URL_SCAN.exec(t))) {
        if (m[1].indexOf(BASE) === 0) continue;
        push(rel, 'url(' + m[1] + ')');
      }
    }
  }
}

/* ------------------------------ 7) 报告 ------------------------------ */
const files = walk(OUT);
let bytes = 0;
for (const f of files) bytes += fs.statSync(f).size;

console.log('');
console.log('  寸进链 · 静态演示包已生成');
console.log('  ────────────────────────────────────────────────');
console.log('  目录     ' + OUT);
console.log('  部署根   ' + BASE + (BASE === '/' ? '  （域名根，surge 用）' : '  （子路径，GitHub Pages 用）'));
console.log('  路径改写 ' + htmlFixed + ' 个 HTML / ' + jsFixed + ' 个 JS');
console.log('  注入     ' + injected + ' 个 HTML');
console.log('  目录页   ' + dirPages + ' 个（chain / admin / verify）');
console.log('  CNAME    ' + cname);
console.log('  文件数   ' + files.length);
console.log('  体积     ' + (bytes / 1024).toFixed(0) + ' KB');
if (BASE !== '/') {
  const uniq = Array.from(new Set(leftovers));
  if (uniq.length) {
    console.log('');
    console.log('  ⚠️ 仍有站内绝对路径未加前缀（子路径部署会 404）：');
    uniq.slice(0, 12).forEach((s) => console.log('     ' + s));
    if (uniq.length > 12) console.log('     ...还有 ' + (uniq.length - 12) + ' 条');
  } else {
    console.log('  残留扫描 通过（无未加前缀的站内路径）');
  }
}
console.log('');
console.log('  本地自测：node tools/static-preview.js');
console.log('');
