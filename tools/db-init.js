'use strict';
/**
 * 建库建表：读取 sql/schema.sql 整段执行。
 *   node tools/db-init.js
 * 注意：这里不经过 lib/db.js 的连接池，因为连接池绑定的是 cunjin_chain 库，
 *      而本脚本的首要任务恰恰是「如果这个库还不存在就创建它」。
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('../lib/config');

(async () => {
  const sqlFile = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  const dsn = { host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    multipleStatements: true, charset: 'utf8mb4' };
  console.log(`→ 连接 MySQL ${dsn.host}:${dsn.port} (user=${dsn.user})`);
  let conn;
  try {
    conn = await mysql.createConnection(dsn);
  } catch (e) {
    console.error('\n✗ 连不上 MySQL。请确认：');
    console.error('  1) MySQL 已启动（phpstudy 面板里启动，或 mysqld --defaults-file=...）');
    console.error('  2) config.json / 环境变量里的端口、账号、密码正确');
    console.error('  3) 当前配置：' + JSON.stringify({ ...dsn, password: '***' }));
    console.error('  原始错误：' + e.message + '\n');
    process.exit(1);
  }
  await conn.query(sql);
  const [rows] = await conn.query(
    'SELECT table_name AS t, table_rows AS r FROM information_schema.tables WHERE table_schema=? ORDER BY table_name',
    [cfg.db.database]);
  const [views] = await conn.query(
    "SELECT table_name AS t FROM information_schema.views WHERE table_schema=?", [cfg.db.database]);
  console.log(`✓ ${cfg.db.database} 建库完成：${rows.length} 张表 + ${views.length} 个视图`);
  console.log('  表清单：' + rows.map((r) => r.t).join(' '));
  console.log('  视图：' + views.map((v) => v.t).join(' '));
  console.log('\n下一步：node tools/seed.js   ← 灌入每表 50 条以上的演示数据');
  await conn.end();
})().catch((e) => { console.error('✗ 建库失败：' + e.message); process.exit(1); });
