/* =====================================================================================
   寸进链 · 静态演示回放层（浏览器端）
   =====================================================================================
   为什么有这个东西：
     线上只读演示原本靠 deploy-online/server.js 回放接口快照，但静态托管（Surge /
     Pages / Netlify）只收文件、不给跑进程。于是把同一套回放逻辑搬到浏览器里：
     拦下 window.fetch 里所有 /api/** 请求，从 data/snapshot.json 里取录好的响应。

     逻辑和 deploy-online/server.js 一一对应（精确命中 → 归一化兜底 → 明确拒绝），
     改一边记得改另一边，否则线上线下行为会不一致。

   放在 <script src> 里、且在 app.js 之前同步执行 —— 必须抢在业务代码调用 fetch 之前
   把 window.fetch 换掉。数据是异步加载的，所以每个被拦截的请求自己 await 数据就绪。
   ===================================================================================== */
(function () {
  'use strict';

  var REAL_FETCH = window.fetch.bind(window);

  // 从自己的 <script src> 反推部署根，这样部署在子目录（xxx.app/demo/）也不会错
  var BASE = (function () {
    var s = document.currentScript;
    var src = (s && s.src) || '';
    var i = src.indexOf('demo-shim.js');
    return i >= 0 ? src.slice(0, i) : '';
  })();

  var SNAP = null, ACC = null, DATA_ERR = null;
  var READY = Promise.all([
    REAL_FETCH(BASE + 'data/snapshot.json').then(function (r) { return r.json(); }),
    REAL_FETCH(BASE + 'data/accounts.json').then(function (r) { return r.json(); })
  ]).then(function (a) {
    SNAP = a[0]; ACC = a[1];
  }, function (e) {
    DATA_ERR = e;
  });

  var DEMO_PASS = '123456';
  var COOKIE = 'cj_demo';
  var ANON = '-';   // 主动登出后用这个哨兵，跟「从没登录过」区分开
  var DEFAULT_USER = 'cunjin005';   // 首次进来直接以演示用户视角展示（知远）

  /* ------------------------------ 与 server.js 对齐的工具 ------------------------------ */

  /** 与录制端保持一致：数字段 / 长十六进制段归一成 *，查询串只留键名 */
  function patternOf(p) {
    var qi = p.indexOf('?');
    var pathname = qi >= 0 ? p.slice(0, qi) : p;
    var qs = qi >= 0 ? p.slice(qi + 1) : '';
    var keys = '';
    if (qs) {
      var seen = {};
      qs.split('&').forEach(function (kv) {
        if (!kv) return;
        var k = kv.split('=')[0];
        if (k) seen[k] = 1;
      });
      keys = Object.keys(seen).sort().join(',');
    }
    var normalized = pathname.replace(/\/(\d+|[0-9a-fA-F]{12,})(?=\/|$)/g, '/*');
    return normalized + (keys ? '?' + keys : '');
  }

  /** 按「精确 → 归一化 → 去掉查询串」三级回退找快照 */
  function lookup(method, target) {
    var m = String(method).toUpperCase();
    var cands = [m + ' ' + target];
    try {
      var u = new URL(target, location.href);
      cands.push(m + ' ' + patternOf(u.pathname + u.search));
      cands.push(m + ' ' + patternOf(u.pathname));
      if (u.search) cands.push(m + ' ' + u.pathname);
    } catch (e) { /* target 不正常，只用原串 */ }

    for (var i = 0; i < cands.length; i++) if (SNAP.exact[cands[i]]) return SNAP.exact[cands[i]];
    for (var j = 0; j < cands.length; j++) if (SNAP.pattern[cands[j]]) return SNAP.pattern[cands[j]];
    return null;
  }

  function getCookie(name) {
    var raw = document.cookie || '';
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      if (parts[i].slice(0, eq).trim() === name) {
        try { return decodeURIComponent(parts[i].slice(eq + 1).trim()); }
        catch (e) { return parts[i].slice(eq + 1).trim(); }
      }
    }
    return '';
  }

  function setCookie(v) {
    document.cookie = COOKIE + '=' + encodeURIComponent(v) + '; Path=/; Max-Age=86400; SameSite=Lax';
  }

  function jsonResponse(obj, code) {
    return new Response(JSON.stringify(obj), {
      status: code || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function bodyOf(init, input) {
    var b = (init && init.body) || (input && input.body) || '';
    if (typeof b === 'string') return b;
    return '';
  }

  /* ------------------------------ 拦截 ------------------------------ */
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    var u;
    try { u = new URL(url, location.href); } catch (e) { return REAL_FETCH(input, init); }
    if (u.pathname.indexOf('/api/') !== 0) return REAL_FETCH(input, init);

    return READY.then(function () {
      if (DATA_ERR) {
        return jsonResponse({ ok: false, demo: true, msg: '演示快照没能加载：' + DATA_ERR.message });
      }
      var pathname = u.pathname;

      /* ---- 登录态：只认录制下来的演示账号，密码统一 123456 ---- */
      if (pathname === '/api/auth/login' && method === 'POST') {
        var payload = {};
        try { payload = JSON.parse(bodyOf(init, input) || '{}'); } catch (e) { payload = {}; }
        var username = String(payload.username || '').trim();
        var password = String(payload.password || '');
        var acc = ACC[username];
        if (!acc) {
          return jsonResponse({ ok: false, demo: true,
            msg: '在线演示只开放这几个账号：' + Object.keys(ACC).join(' / ') });
        }
        if (password !== DEMO_PASS) {
          return jsonResponse({ ok: false, demo: true,
            msg: '在线演示所有账号的密码统一是 ' + DEMO_PASS });
        }
        setCookie(username);
        return jsonResponse(acc.login);
      }

      if (pathname === '/api/auth/logout') {
        setCookie(ANON);
        return jsonResponse({ ok: true });
      }

      if (pathname === '/api/me') {
        var who = getCookie(COOKIE) || DEFAULT_USER;
        if (who === ANON) return jsonResponse({ ok: true, user: null });
        var a2 = ACC[who];
        return jsonResponse(a2 ? a2.me : { ok: true, user: null });
      }

      var hit = lookup(method, pathname + u.search);
      if (hit) {
        return new Response(hit.text, {
          status: hit.status || 200,
          headers: { 'Content-Type': hit.ct || 'application/json; charset=utf-8' }
        });
      }

      // 没录到：不假装成功。写操作明确告诉用户去哪儿跑。
      var isWrite = method !== 'GET' && method !== 'HEAD';
      return jsonResponse({
        ok: false,
        demo: true,
        msg: isWrite
          ? '在线演示为只读快照，写入操作（' + pathname + '）不会生效；完整功能请本地 npm start 后使用。'
          : '在线演示快照未收录该查询（' + pathname + '）。'
      });
    });
  };

  /* ------------------------------ 顶部横幅 ------------------------------ */
  var BANNER_CSS = [
    '#__demo_banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;gap:10px;',
    'align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;',
    'background:rgba(99,102,241,.96);color:#fff;font-size:12.5px;line-height:1.5;',
    'font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
    'box-shadow:0 -6px 24px rgba(30,34,80,.18);backdrop-filter:blur(6px)}',
    '#__demo_banner b{font-weight:700}',
    '#__demo_banner span{opacity:.92}',
    'body{padding-bottom:46px}'
  ].join('');

  var BANNER_HTML = [
    '<b>在线演示 · 只读快照</b>',
    '<span>数据由真实 MySQL 环境录制，四个端都可以点开看；',
    '签到、兑换这类写操作需要本地跑（<code>npm start</code>）才可用。</span>'
  ].join('');

  function injectBanner() {
    if (document.getElementById('__demo_banner')) return;
    var st = document.createElement('style');
    st.id = '__demo_banner_css';
    st.textContent = BANNER_CSS;
    document.head.appendChild(st);
    var div = document.createElement('div');
    div.id = '__demo_banner';
    div.innerHTML = BANNER_HTML;
    document.body.appendChild(div);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectBanner);
  else injectBanner();
})();
