'use strict';
/* =====================================================================================
   寸进链 · 线上只读演示服务
   =====================================================================================
   为什么有这个东西：
     正式的 server.js 需要 MySQL，而线上发布沙箱只给一个 HTTP 端口、不带数据库。
     所以线上版把「四个端的静态资源」+「真实环境录下来的接口快照」一起端出去，
     让评审能直接在浏览器里点开看四个端长什么样、数据长什么样。

   零依赖：只用 node:http / node:fs，不装任何包（package.json 里 dependencies 是空的）。

   行为：
     GET  /api/**  → 命中快照就回放（精确 URL 优先，数字段归一化兜底）
     其他 /api/**  → 明确回「只读演示」而不是假装成功，避免误导
     静态资源      → public/ 下按扩展名给 Content-Type，/admin 这类无扩展名走 .html
     HTML          → 注入一条顶部横幅，说明这是只读演示、完整功能以本地为准

   本地自测：  PORT=3901 node server.js
   ===================================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3901;
const HOST = '0.0.0.0';

const SNAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'snapshot.json'), 'utf8'));
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'accounts.json'), 'utf8'));

const DEMO_PASS = '123456';
const COOKIE = 'cj_demo';
const ANON = '-';            // 主动登出后用这个哨兵，跟「从没登录过」区分开

/* ------------------------------ 工具 ------------------------------ */
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 与录制端保持一致：数字段 / 长十六进制段归一成 *，查询串只留键名 */
function patternOf(p) {
  const qi = p.indexOf('?');
  const pathname = qi >= 0 ? p.slice(0, qi) : p;
  const qs = qi >= 0 ? p.slice(qi + 1) : '';
  const keys = qs
    ? [...new Set(qs.split('&').filter(Boolean).map((kv) => kv.split('=')[0]))].sort().join(',')
    : '';
  const normalized = pathname.replace(/\/(\d+|[0-9a-fA-F]{12,})(?=\/|$)/g, '/*');
  return normalized + (keys ? '?' + keys : '');
}

/** 按「精确 → 归一化 → 去掉查询串」三级回退找快照 */
function lookup(method, target) {
  const m = method.toUpperCase();
  const cands = [m + ' ' + target];
  try {
    const u = new URL(target, 'http://localhost');
    cands.push(m + ' ' + patternOf(u.pathname + u.search));
    cands.push(m + ' ' + patternOf(u.pathname));
    if (u.search) cands.push(m + ' ' + u.pathname);
  } catch (e) { /* target 不正常，只用原串 */ }

  for (const k of cands) {
    if (SNAP.exact[k]) return SNAP.exact[k];
  }
  for (const k of cands) {
    if (SNAP.pattern[k]) return SNAP.pattern[k];
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1048576) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

/* ------------------------------ 顶部横幅 ------------------------------ */
const BANNER = [
  '<style id="__demo_banner_css">',
  '#__demo_banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;gap:10px;',
  'align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;',
  'background:rgba(99,102,241,.96);color:#fff;font-size:12.5px;line-height:1.5;',
  'font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
  'box-shadow:0 -6px 24px rgba(30,34,80,.18);backdrop-filter:blur(6px)}',
  '#__demo_banner b{font-weight:700}',
  '#__demo_banner span{opacity:.92}',
  'body{padding-bottom:46px}</style>',
  '<div id="__demo_banner"><b>在线演示 · 只读快照</b>',
  '<span>数据由真实 MySQL 环境录制，四个端都可以点开看；',
  '签到、兑换这类写操作需要本地跑（<code>npm start</code>）才可用。</span></div>',
].join('');

function injectBanner(html) {
  if (html.indexOf('__demo_banner') >= 0) return html;
  return html.indexOf('</body>') >= 0
    ? html.replace('</body>', BANNER + '</body>')
    : html + BANNER;
}

/* ------------------------------ 静态资源 ------------------------------ */
const PAGE_ALIAS = { '/': 'index.html', '/admin': 'admin.html', '/chain': 'chain.html', '/verify': 'verify.html' };

function serveStatic(req, res, pathname) {
  let rel = PAGE_ALIAS[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  let full = path.resolve(ROOT, rel);

  // 目录穿越防护：解析后的路径必须还在 public 里
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { ok: false, msg: '禁止访问' });
  }
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
  if (!fs.existsSync(full)) {
    // 无扩展名再试一次 .html（和 Express 的 extensions:['html'] 行为对齐）
    if (!path.extname(full) && fs.existsSync(full + '.html')) full += '.html';
    else return sendJson(res, 404, { ok: false, msg: '页面不存在：' + pathname });
  }

  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  let body = fs.readFileSync(full);
  if (ext === '.html') body = Buffer.from(injectBanner(body.toString('utf8')), 'utf8');

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ------------------------------ 入口 ------------------------------ */
const server = http.createServer(async (req, res) => {
  let target;
  try { target = new URL(req.url, 'http://localhost'); } catch (e) {
    return sendJson(res, 400, { ok: false, msg: '请求地址不合法' });
  }
  const pathname = target.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const body = req.method === 'POST' ? await readBody(req) : '';

  /* ---- 登录态：只认录制下来的演示账号，密码统一 123456 ---- */
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const acc = ACCOUNTS[username];
    if (!acc) {
      return sendJson(res, 200, { ok: false, demo: true,
        msg: '在线演示只开放这几个账号：' + Object.keys(ACCOUNTS).join(' / ') });
    }
    if (password !== DEMO_PASS) {
      return sendJson(res, 200, { ok: false, demo: true,
        msg: '在线演示所有账号的密码统一是 ' + DEMO_PASS });
    }
    res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(username) + '; Path=/; Max-Age=86400; SameSite=Lax');
    return sendJson(res, 200, acc.login);
  }

  if (pathname === '/api/auth/logout') {
    res.setHeader('Set-Cookie', COOKIE + '=' + ANON + '; Path=/; Max-Age=86400; SameSite=Lax');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/me') {
    const who = getCookie(req, COOKIE) || 'cunjin005';   // 首次进来直接以演示用户视角展示
    if (who === ANON) return sendJson(res, 200, { ok: true, user: null });
    const acc = ACCOUNTS[who];
    return sendJson(res, 200, acc ? acc.me : { ok: true, user: null });
  }

  const hit = lookup(req.method, target.pathname + target.search);

  if (hit) {
    const buf = Buffer.from(hit.text, 'utf8');
    res.writeHead(200, {
      'Content-Type': hit.ct || 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // 没录到：不假装成功。写操作明确告诉用户去哪儿跑。
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  sendJson(res, 200, {
    ok: false,
    demo: true,
    msg: isWrite
      ? '在线演示为只读快照，写入操作（' + pathname + '）不会生效；完整功能请本地 npm start 后使用。'
      : '在线演示快照未收录该查询（' + pathname + '）。',
  });
});

server.listen(PORT, HOST, () => {
  const n = Object.keys(SNAP.exact).length;
  console.log('');
  console.log('  寸进链 · 线上只读演示');
  console.log('  ────────────────────────────────────────────────');
  console.log('  快照   ' + n + ' 条精确接口 · ' + Object.keys(SNAP.pattern).length + ' 条归一化');
  console.log('  录制于 ' + (SNAP.meta && SNAP.meta.recordedAt || '—'));
  console.log('  地址   http://localhost:' + PORT + '/   (PORT=' + PORT + ')');
  console.log('');
});
