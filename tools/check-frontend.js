/* =====================================================================================
   前端静态检查：语法 + 模块导入导出
   =====================================================================================
   为什么需要它：
   ESM 的模块解析错误不会在服务端报错，也不会在 `node --check server.js` 里暴露 ——
   它只在浏览器里抛一个 SyntaxError，然后**整页空白**。
   实测踩过两次：
     · app.js 从 ui.js import 了 levelBar（其实在 charts.js 里）→ 首页全白
     · admin.js 少了一个右括号 → 管理端全白
   这两类问题截图完全看不出来（就是一片白 / 一个空壳），但静态检查一秒就能抓到。

     node tools/check-frontend.js
   ===================================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
const problems = [];

/* ---------- ① 语法：.js 里写 ESM 时 node --check 会误判，先复制成 .mjs 再检查 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cjchk-'));
for (const f of files) {
  const copy = path.join(tmp, f.replace(/\.js$/, '.mjs'));
  fs.writeFileSync(copy, fs.readFileSync(path.join(DIR, f), 'utf8'));
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter((l) => l.trim()).slice(0, 4).join(' ');
    problems.push(`语法错误 ${f}：${msg}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- ② 收集每个模块真正导出的名字 ---------- */
const exportsOf = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach((x) => {
      const t = x.trim().split(/\s+as\s+/).pop().trim();
      if (t) set.add(t);
    });
  }
  exportsOf[f] = set;
}

/* ---------- ③ 逐个 import 对账 ---------- */
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.-]+\.js)'/g)) {
    const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const target = m[2];
    if (!exportsOf[target]) { problems.push(`${f} 引用了不存在的模块 ${target}`); continue; }
    for (const n of names) {
      if (!exportsOf[target].has(n)) {
        problems.push(`${f} 从 ${target} 导入了不存在的 ${n}（这会让整页静默空白）`);
      }
    }
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*'\.\/([\w.-]+\.js)'/g)) {
    if (!exportsOf[m[1]]) problems.push(`${f} 引用了不存在的模块 ${m[1]}`);
  }
}

/* ---------- ④ 页面引用的脚本文件是否真的存在 ---------- */
const pub = path.join(__dirname, '..', 'public');
for (const h of fs.readdirSync(pub).filter((x) => x.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(pub, h), 'utf8');
  for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/[^"]+\.(?:js|css))"/g)) {
    const p = path.join(pub, m[1]);
    if (!fs.existsSync(p)) problems.push(`${h} 引用了不存在的资源 ${m[1]}`);
  }
}

/* ---------- ⑤ 服务端路由点名的 HTML 是否都在 ---------- */
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const m of serverSrc.matchAll(/page\('([^']+)'\)/g)) {
  if (!fs.existsSync(path.join(pub, m[1]))) problems.push(`server.js 引用了不存在的页面 ${m[1]}`);
}

/* ---------- 输出 ---------- */
if (problems.length) {
  console.log(`✗ 前端静态检查发现 ${problems.length} 个问题：`);
  problems.forEach((p) => console.log('  · ' + p));
  process.exit(1);
}
console.log(`✓ 前端静态检查通过（${files.length} 个模块：语法、导入导出、页面资源引用）`);
