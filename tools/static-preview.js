/* =====================================================================================
   寸进链 · 静态演示包本地预览（仅用于自测，线上不跑这个）
   =====================================================================================
   模拟静态托管的行为，好让 tools/demo-verify.js 能连上来跑验收：
     /            → index.html
     /chain       → chain.html（clean URL）
     /chain/      → chain/index.html（目录页）
     找不到       → 404.html

   用法：
     node tools/static-preview.js
       → 托管 deploy-static/ 在域名根（对应 surge）

     node tools/static-preview.js --root=deploy-pages --prefix=/cunjin-chain
       → 模拟 GitHub Pages 的项目站点：站点挂在 /<repo>/ 子路径下。
         前后缀不匹配的请求一律 404 —— 这正是线上白屏时的症状，本地先撞出来。
   ===================================================================================== */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function argv(name, def) {
  const hit = process.argv.slice(2).find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : def;
}

const DIR = argv('root', 'deploy-static');
const ROOT = path.join(__dirname, '..', DIR);
const PREFIX = argv('prefix', '').replace(/\/+$/, '');     // '' = 域名根；'/cunjin-chain' = 子路径
const PORT = Number(process.env.PORT) || 3903;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;   // 目录穿越防护

  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  if (!path.extname(full) && fs.existsSync(full + '.html')) return full + '.html';
  return null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let pathname = u.pathname;

  if (PREFIX) {
    if (pathname !== PREFIX && pathname.indexOf(PREFIX + '/') !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>站点挂在 ' + PREFIX + '/ 下，这里是 ' + pathname + '</p>');
    }
    pathname = pathname.slice(PREFIX.length) || '/';
  }

  const full = resolveFile(pathname);
  if (!full) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>404</h1><p>' + u.pathname + '</p>');
  }
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, '0.0.0.0', () => {
  console.log('  静态演示本地预览  http://localhost:' + PORT + PREFIX + '/');
  console.log('  目录  ' + DIR + (PREFIX ? '    前缀  ' + PREFIX : '    （域名根）'));
});
