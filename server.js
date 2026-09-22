'use strict';
/**
 * 寸进链 · 服务端入口
 * ==========================================================================
 *   node server.js                 默认 http://localhost:8901
 *   三个端共用一个进程：
 *     /            用户端（学习者）
 *     /admin       运营管理端（需要 operator / admin 账号）
 *     /chain       链浏览器（公开，含篡改实验室）
 *     /verify      凭证验真（公开，可 /verify?code=XXXX-XXXX-XXXX）
 *
 * 启动时会做三件事：
 *   ① 连数据库、数表行数（少于 50 行的表会提醒你去 seed）
 *   ② 确保创世块存在
 *   ③ 起一个定时器按配置间隔打包交易池
 */
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const cfg = require('./lib/config');
const store = require('./lib/chainstore');
const auth = require('./lib/auth');
const chain = require('./lib/chain');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

/* ------------------------------ 路由 ------------------------------ */
// 顺序有讲究：/api/chain 和 /api/admin 必须先于 /api 挂载
app.use('/api/chain', require('./routes/chainapi'));
app.use('/api/admin', require('./routes/adminapi'));
app.use('/api', require('./routes/api'));

// 静态资源
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 三个端的 HTML 入口（都允许直接访问，登录态由前端自己判断）
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', page('index.html'));
app.get('/admin', page('admin.html'));
app.get('/chain', page('chain.html'));
app.get('/verify', page('verify.html'));

// 404 / 错误
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, msg: '接口不存在：' + req.path });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server]', err.message);
  res.status(500).json({ ok: false, msg: err.message || '服务器错误' });
});

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  const line = '─'.repeat(66);
  console.log('\n' + line);
  console.log('  寸进链 · 每日打卡积分与链上成就存证平台');
  console.log(line);

  let health;
  try {
    health = await db.health();
  } catch (e) {
    console.error('  ✗ 连不上 MySQL：' + e.message);
    console.error('    请先启动 MySQL（本项目默认 phpstudy 的 3307 端口），或修改 config.json');
    process.exit(1);
  }
  console.log(`  MySQL      ${health.version} · 库 ${health.database} · ${health.tables} 张表`);

  // 表里有没有数据，一眼能看出来；空库直接提示去 seed
  const u = Number(await db.scalar('SELECT COUNT(*) AS c FROM users')) || 0;
  const b = Number(await db.scalar('SELECT COUNT(*) AS c FROM blocks')) || 0;
  if (!u || !b) {
    console.log('\n  ⚠ 数据库还是空的，先跑这几条：');
    console.log('      node tools/db-init.js   # 建库建表');
    console.log('      node tools/seed.js      # 灌入演示数据（约 2~4 分钟）\n');
  } else {
    console.log(`  用户        ${u} 个（含链上地址与 Ed25519 密钥对）`);
    console.log(`  区块        ${b} 个 · 交易 ${Number(await db.scalar('SELECT COUNT(*) AS c FROM txs'))} 笔`);
  }

  const g = await store.init();
  if (g.created) console.log('  创世块      已生成');

  const st = await store.stats();
  console.log(`  链状态      高度 ${st.height} · 待打包 ${st.pending} 笔 · 难度 ${st.difficulty} · 平均挖矿 ${st.avg_mined_ms}ms/块`);
  const plat = require('./lib/keys');
  console.log(`  平台地址    ${plat.platformAddr()}`);
  console.log(line);
  console.log(`  用户端      http://localhost:${cfg.port}/`);
  console.log(`  运营管理端  http://localhost:${cfg.port}/admin     （admin / 123456）`);
  console.log(`  链浏览器    http://localhost:${cfg.port}/chain`);
  console.log(`  凭证验真    http://localhost:${cfg.port}/verify`);
  console.log(line + '\n');

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`  ✓ 服务已启动，监听 ${cfg.host}:${cfg.port}`);
  });

  /*
   * 定时出块：两个条件满足其一就打一个块
   *   ① 交易池攒够 maxTxPerBlock 笔（攒批，省算力）
   *   ② 池子里最老那笔已经等了超过 blockIntervalMs（超时兜底，不让用户干等）
   * 这样「链浏览器」上交易池平时是有内容的，不是一出块就空。
   */
  let mining = false;
  const timer = setInterval(async () => {
    if (mining) return;
    mining = true;
    try {
      const n = await store.poolSize();
      if (n > 0) {
        const oldest = await store.oldestPendingTs();
        const stale = oldest !== null && (Date.now() - oldest) > cfg.chain.blockIntervalMs;
        if (n >= cfg.chain.maxTxPerBlock || stale) {
          const blk = await store.mineBlock({ maxTx: cfg.chain.maxTxPerBlock * 3 });
          if (blk) {
            console.log(`  ⛏  出块 #${blk.height} · ${blk.pending} 笔 · nonce ${blk.nonce}`
              + ` · ${blk.mined_ms}ms${stale && n < cfg.chain.maxTxPerBlock ? '（超时兜底）' : ''}`);
          }
        }
      }
    } catch (e) {
      console.error('  ✗ 出块失败：' + e.message);
    } finally { mining = false; }
  }, cfg.chain.blockIntervalMs);

  const stop = () => {
    clearInterval(timer);
    server.close(() => {
      console.log('\n  已停止。');
      db.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) boot();
module.exports = { app, boot };
