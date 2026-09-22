/* =====================================================================================
   寸进链 · 线上演示账号录制
   =====================================================================================
   demo-record.js 录的是「各端页面会调哪些读接口」，但登录这一步是页面里手动触发的，
   没被录进去。而线上演示里管理员端必须先点一次「登录管理端」才露出面板，
   所以这里把几个代表账号的登录响应与 /api/me 一并录下来。

   直接用 node fetch 打真实服务，不需要浏览器。

     node tools/demo-record-auth.js        # 需要 8901 已经在跑
   ===================================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8901';
const PASSWORD = '123456';
const ACCOUNTS = ['cunjin001', 'cunjin003', 'cunjin005', 'ops_lin', 'admin'];
const OUTDIR = path.join(__dirname, '..', 'deploy-online', 'data');
const OUT = path.join(OUTDIR, 'accounts.json');

(async () => {
  const out = {};

  for (const username of ACCOUNTS) {
    let login, me, cookie = '';
    try {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD }),
      });
      login = await r.json();
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      cookie = sc.map((s) => s.split(';')[0]).join('; ');
    } catch (e) {
      console.log('  ✗ ' + username + ' 登录失败：' + e.message);
      continue;
    }

    if (!login || login.ok === false) {
      console.log('  ✗ ' + username + ' 被拒绝：' + ((login && login.msg) || '未知原因'));
      continue;
    }

    try {
      const r2 = await fetch(BASE + '/api/me', { headers: { cookie } });
      me = await r2.json();
    } catch (e) {
      me = { ok: true, user: null };
    }

    out[username] = { login, me };
    const role = (login.user && login.user.role) || '?';
    console.log('  ✓ ' + username.padEnd(10) + ' role=' + role.padEnd(9)
      + ' 昵称=' + ((login.user && login.user.nickname) || '—'));
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('\n  已写出 ' + OUT + '（' + Object.keys(out).length + ' 个账号）\n');
  process.exit(0);
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
