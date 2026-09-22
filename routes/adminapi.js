'use strict';
/**
 * 运营 / 管理端 API
 * 只允许 operator 与 admin 访问（lib/auth.js 的 requireRole 守卫）。
 * 管理端做的每一件事都会写 audit_logs；凡涉及钱和规则的动作还会上链（RULE / ADJUST 交易）。
 */
const express = require('express');
const db = require('../lib/db');
const points = require('../lib/points');
const risk = require('../lib/risk');
const store = require('../lib/chainstore');
const auth = require('../lib/auth');
const keys = require('../lib/keys');

const router = express.Router();
const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, msg });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[admin]', req.method, req.originalUrl, e.message);
  bad(res, e.message || '服务器错误', 500);
});
const page = (q) => {
  const p = Math.max(1, Number(q.page) || 1);
  const size = Math.min(100, Math.max(1, Number(q.size) || 20));
  return { p, size, offset: (p - 1) * size };
};
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');

/** 所有路由都要 operator 或 admin */
router.use(auth.requireRole('operator', 'admin'));

async function audit(req, action, target, detail, txid) {
  await db.exec(
    `INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, ip, txid) VALUES (?,?,?,?,?,?,?)`,
    [req.user.id, req.user.role, action, target, detail, ipOf(req), txid || null]);
}

/* ============================ 概览看板 ============================ */

/**
 * 第一屏不是一堆数字，而是「需要我处理的事」。
 * 每条待办都带上 sort / 落点，前端点「去处理」能直接跳到已按该问题排好序的列表。
 */
router.get('/overview', wrap(async (req, res) => {
  const today = points.dayOf();
  const kpi = await db.queryOne(
    `SELECT (SELECT COUNT(*) FROM users WHERE role='user') AS users,
            (SELECT COUNT(*) FROM users WHERE role='user' AND status=1) AS active_users,
            (SELECT COUNT(*) FROM checkins WHERE day = CURDATE()) AS today_checkin,
            (SELECT COUNT(*) FROM checkins WHERE day = DATE_SUB(CURDATE(), INTERVAL 1 DAY)) AS yday_checkin,
            (SELECT COUNT(*) FROM tasks WHERE day = CURDATE()) AS today_tasks,
            (SELECT COUNT(*) FROM tasks WHERE day = CURDATE() AND status='done') AS today_done,
            (SELECT COUNT(*) FROM badge_claims) AS claims,
            (SELECT COUNT(*) FROM redemptions) AS redemptions,
            (SELECT COUNT(*) FROM donations) AS donations,
            (SELECT COUNT(*) FROM risk_alerts WHERE handled = 0) AS open_alerts,
            (SELECT COUNT(*) FROM stakes WHERE status='running') AS running_stakes`);
  const money = await db.queryOne(
    `SELECT (SELECT COALESCE(SUM(amount),0) FROM point_ledger WHERE direction=1) AS issued,
            (SELECT COALESCE(SUM(amount),0) FROM point_ledger WHERE direction=-1) AS consumed,
            (SELECT COALESCE(on_chain,0) FROM point_accounts WHERE addr='CJBURN') AS burned,
            (SELECT COALESCE(on_chain,0) FROM point_accounts WHERE addr='CJPOOL') AS pool,
            (SELECT COALESCE(on_chain,0) FROM point_accounts WHERE addr='CJDONATE') AS donate_pool,
            (SELECT COALESCE(SUM(balance),0) FROM user_stats) AS user_total,
            (SELECT COALESCE(SUM(frozen),0) FROM user_stats) AS frozen`);
  const chainStat = await store.stats();
  const rec = await points.reconcileAll();
  const riskOv = await risk.overview();

  // 待办清单
  const todos = [];
  if (riskOv.open) todos.push({ level: 'high', title: `${riskOv.open} 条风控告警未处置`,
    desc: '刷分会直接稀释真实用户的积分价值，建议今天就清一批',
    action: '去处理', route: '#/risk', sort: 'level_desc' });
  const lowStock = Number(await db.scalar(
    'SELECT COUNT(*) AS c FROM rewards WHERE stock < 10 AND status = 1 AND category <> "charity"')) || 0;
  if (lowStock) todos.push({ level: 'mid', title: `${lowStock} 件商品库存低于 10`,
    desc: '库存见底会让用户兑不到东西，影响体验', action: '去看', route: '#/rewards', sort: 'stock_asc' });
  const pending = Number(chainStat.pending) || 0;
  if (pending > 30) todos.push({ level: 'mid', title: `交易池积压 ${pending} 笔`,
    desc: '超过 ' + (chainStat.pending) + ' 笔还没打包，可以手动出块',
    action: '去出块', route: '#/chain', sort: 'none' });
  if (!rec.ok) todos.push({ level: 'high', title: `对账不平：${rec.mismatch.length} 个用户三方余额不一致`,
    desc: '说明有人绕过积分引擎改了数据，请查审计日志', action: '去对账', route: '#/reconcile', sort: 'diff_desc' });
  const d1 = Number(kpi.today_checkin) || 0, d0 = Number(kpi.yday_checkin) || 0;
  if (d0 > 0 && d1 < d0 * 0.7) {
    todos.push({ level: 'low', title: `今日签到较昨日下降 ${Math.round((1 - d1 / d0) * 100)}%`,
      desc: `昨日 ${d0} 人、今日 ${d1} 人。可以发一条公告提醒`, action: '去发公告', route: '#/announce', sort: 'none' });
  }
  const claimsNoProof = Number(await db.scalar(
    `SELECT COUNT(*) AS c FROM badge_claims WHERE merkle_path IS NULL`)) || 0;
  if (claimsNoProof) todos.push({ level: 'low', title: `${claimsNoProof} 张凭证缺 Merkle 证明`,
    desc: '补上之后轻节点才能独立验证这些凭证', action: '去看看', route: '#/chain', sort: 'none' });

  ok(res, { today, kpi, money, chain: chainStat, risk: riskOv, todos,
    reconcile: { ok: rec.ok, mismatch: rec.mismatch.length, issued: rec.issued, burned: rec.burned },
    platformAddr: keys.platformAddr() });
}));

/* ============================ 用户管理 ============================ */

router.get('/users', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const where = []; const args = [];
  if (req.query.q) {
    where.push('(u.username LIKE ? OR u.nickname LIKE ? OR u.addr LIKE ?)');
    const like = '%' + req.query.q + '%';
    args.push(like, like, like);
  }
  if (req.query.role) { where.push('u.role = ?'); args.push(req.query.role); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sortMap = { balance: 's.balance DESC', streak: 's.streak DESC', points: 's.earned DESC',
    risk: 's.id DESC', new: 'u.id DESC' };
  const order = sortMap[req.query.sort] || 's.balance DESC';
  const total = Number(await db.scalar(`SELECT COUNT(*) AS c FROM users u ${w}`, args));
  const list = await db.query(
    `SELECT u.id, u.username, u.nickname, u.role, u.addr, u.city, u.goal, u.status, u.created_at, u.last_login,
            s.balance, s.earned, s.spent, s.frozen, s.streak, s.max_streak, s.checkin_days, s.task_done,
            s.badge_count, s.level,
            (SELECT COUNT(*) FROM risk_alerts r WHERE r.user_id = u.id AND r.handled = 0) AS open_alerts
       FROM users u LEFT JOIN user_stats s ON s.user_id = u.id ${w}
      ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, size, offset]);
  ok(res, { list, total, page: p, size });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.queryOne(
    `SELECT u.*, s.* FROM users u LEFT JOIN user_stats s ON s.user_id = u.id WHERE u.id = ?`, [id]);
  if (!u) return bad(res, '用户不存在', 404);
  delete u.priv_key; delete u.password; delete u.salt;
  const ledger = await db.query(
    'SELECT * FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const alerts = await db.query('SELECT * FROM risk_alerts WHERE user_id = ? ORDER BY id DESC LIMIT 10', [id]);
  const acc = await db.queryOne('SELECT * FROM point_accounts WHERE addr = ?', [u.addr]);
  const rec = await points.reconcile(id);
  ok(res, { user: u, ledger, alerts, account: acc, reconcile: rec });
}));

router.post('/users/:id/status', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const st = Number(req.body && req.body.status) ? 1 : 0;
  if (id === req.user.id) return bad(res, '不能封禁自己');
  await db.exec('UPDATE users SET status = ? WHERE id = ?', [st, id]);
  await audit(req, st ? '解封账号' : '封禁账号', 'users', `用户 #${id} → ${st ? '正常' : '封禁'}`);
  ok(res, { status: st });
}));

/**
 * 人工调账。
 * 这是管理端唯一能「凭空」改用户余额的入口，所以必须双向留痕：
 *   · 走 credit/debit 生成真实的链上 ADJUST 交易（不是直接 UPDATE 余额）
 *   · 写审计日志
 * 如果绕过这里直接 UPDATE 数据库，对账立刻会发现「汇总 ≠ 链上」。
 */
router.post('/adjust', wrap(async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  const amt = Math.round(Number(amount));
  if (!userId || !amt) return bad(res, '缺少用户或金额');
  if (!reason || String(reason).trim().length < 4) return bad(res, '调账必须写清理由（至少 4 个字）');
  const u = await db.queryOne('SELECT * FROM users WHERE id = ?', [Number(userId)]);
  if (!u) return bad(res, '用户不存在');
  let r;
  if (amt > 0) {
    r = await points.credit({ userId: u.id, addr: u.addr, userName: u.nickname, type: 'ADJUST',
      amount: amt, memo: `人工调账：${String(reason).slice(0, 60)}` });
  } else {
    r = await points.debit({ userId: u.id, addr: u.addr, userName: u.nickname, priv: u.priv_key,
      type: 'ADJUST', amount: -amt, toAddr: 'CJMINT',
      toLabel: '系统铸币账户（积分发行总源头）', memo: `人工扣减：${String(reason).slice(0, 60)}` });
  }
  await audit(req, '人工调账', 'point_ledger', `用户 #${u.id} ${amt > 0 ? '+' : ''}${amt} 分：${reason}`, r.tx.txid);
  ok(res, { balanceAfter: r.balanceAfter, txid: r.tx.txid });
}));

/* ============================ 积分规则 ============================ */

router.get('/rules', wrap(async (req, res) => {
  const active = await db.query('SELECT * FROM point_rules WHERE active = 1 ORDER BY rule_key');
  const history = await db.query('SELECT * FROM point_rules ORDER BY rule_key, version DESC LIMIT 80');
  ok(res, { active, history, totalRules: Number(await db.scalar('SELECT COUNT(*) AS c FROM point_rules')) });
}));

/**
 * 改规则 = 插一个新版本（不覆盖旧版本）。
 * 好处：任何一笔积分的发放都能追溯到「当时生效的是哪一版规则」，
 * 而且每次改动都会生成一笔 RULE 交易上链存证。
 */
router.post('/rules', wrap(async (req, res) => {
  const { rule_key, val_num, val_text, reason } = req.body || {};
  if (!rule_key) return bad(res, '缺少规则键');
  if (!reason || String(reason).trim().length < 4) return bad(res, '改规则必须写变更理由');
  const cur = await db.queryOne(
    'SELECT * FROM point_rules WHERE rule_key = ? ORDER BY version DESC LIMIT 1', [rule_key]);
  if (!cur) return bad(res, '规则不存在');
  const v = Number(cur.version) + 1;
  const r = await db.exec(
    `INSERT INTO point_rules (rule_key, version, rule_name, val_num, val_text, unit, active, changed_by, reason)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    [rule_key, v, cur.rule_name, Number(val_num) || 0, val_text || cur.val_text, cur.unit,
      req.user.id, String(reason).slice(0, 120)]);
  await db.exec('UPDATE point_rules SET active = 0 WHERE rule_key = ? AND version < ?', [rule_key, v]);
  // 上链存证
  const tx = await store.submit({
    type: 'RULE', from: 'CJMINT', to: 'CJMINT', amount: 0,
    memo: `规则「${cur.rule_name}」升到 v${v}：${reason}`,
  }, keys.platform().priv, { fromLabel: '系统铸币账户（积分发行总源头）' });
  await db.exec('UPDATE point_rules SET txid = ? WHERE id = ?', [tx.txid, r.insertId]);
  await points.clearRuleCache();
  await store.autoMine();
  await audit(req, '调整积分规则', 'point_rules', `${cur.rule_name} v${cur.version} → v${v}：${reason}`, tx.txid);
  ok(res, { id: r.insertId, version: v, txid: tx.txid });
}));

/* ============================ 奖励与订单 ============================ */

router.get('/rewards', wrap(async (req, res) => {
  const list = await db.query(
    `SELECT r.*, (SELECT COUNT(*) FROM redemptions x WHERE x.reward_id = r.id) AS orders
       FROM rewards r ORDER BY r.stock ASC, r.cost ASC`);
  ok(res, { list });
}));

router.post('/rewards', wrap(async (req, res) => {
  const { name, category, cost, stock, descr, per_limit } = req.body || {};
  if (!name || !cost) return bad(res, '商品名与所需积分必填');
  const r = await db.exec(
    `INSERT INTO rewards (name, category, cost, stock, cover_color, descr, per_limit, status)
     VALUES (?,?,?,?,?,?,?,1)`,
    [String(name).slice(0, 60), category || 'goods', Number(cost), Number(stock) || 0, '#6366f1',
      descr || '', Number(per_limit) || 1]);
  await audit(req, '上架兑换商品', 'rewards', `${name}（${cost} 分 / 库存 ${stock || 0}）`);
  ok(res, { id: r.insertId });
}));

router.post('/rewards/:id/update', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.queryOne('SELECT * FROM rewards WHERE id = ?', [id]);
  if (!cur) return bad(res, '商品不存在', 404);
  const b = req.body || {};
  const stock = b.stock === undefined ? cur.stock : Number(b.stock);
  const cost = b.cost === undefined ? cur.cost : Number(b.cost);
  const status = b.status === undefined ? cur.status : Number(b.status);
  await db.exec('UPDATE rewards SET stock = ?, cost = ?, status = ?, descr = ? WHERE id = ?',
    [stock, cost, status, b.descr === undefined ? cur.descr : b.descr, id]);
  await audit(req, '修改兑换商品', 'rewards', `#${id} 库存 ${cur.stock}→${stock}，价格 ${cur.cost}→${cost}`);
  ok(res, { stock, cost, status });
}));

router.get('/redemptions', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const where = []; const args = [];
  if (req.query.status) { where.push('r.status = ?'); args.push(req.query.status); }
  if (req.query.q) { where.push('(r.order_no LIKE ? OR u.nickname LIKE ?)'); args.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(await db.scalar(
    `SELECT COUNT(*) AS c FROM redemptions r JOIN users u ON u.id = r.user_id ${w}`, args));
  const list = await db.query(
    `SELECT r.*, w.name AS reward_name, w.category, u.nickname, u.addr
       FROM redemptions r JOIN rewards w ON w.id = r.reward_id JOIN users u ON u.id = r.user_id
       ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...args, size, offset]);
  ok(res, { list, total, page: p, size });
}));

router.post('/redemptions/:id/status', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const st = (req.body && req.body.status) || 'shipped';
  if (!['paid', 'shipped', 'done', 'cancel'].includes(st)) return bad(res, '状态非法');
  const cur = await db.queryOne('SELECT * FROM redemptions WHERE id = ?', [id]);
  if (!cur) return bad(res, '订单不存在', 404);
  await db.exec('UPDATE redemptions SET status = ? WHERE id = ?', [st, id]);
  await audit(req, '处理兑换订单', 'redemptions', `订单 ${cur.order_no} → ${st}`);
  ok(res, { status: st });
}));

/* ============================ 风控 ============================ */

router.get('/risk', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const where = []; const args = [];
  if (req.query.handled !== undefined && req.query.handled !== '') {
    where.push('r.handled = ?'); args.push(Number(req.query.handled));
  }
  if (req.query.level) { where.push('r.level = ?'); args.push(req.query.level); }
  if (req.query.rule) { where.push('r.rule_code = ?'); args.push(req.query.rule); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = req.query.sort === 'level_desc'
    ? "FIELD(r.level,'high','mid','low') ASC, r.handled ASC, r.id DESC" : 'r.id DESC';
  const total = Number(await db.scalar(
    `SELECT COUNT(*) AS c FROM risk_alerts r JOIN users u ON u.id = r.user_id ${w}`, args));
  const list = await db.query(
    `SELECT r.*, u.nickname, u.username, u.addr, u.status AS user_status,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = r.user_id) AS ck_total
       FROM risk_alerts r JOIN users u ON u.id = r.user_id ${w}
      ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, size, offset]);
  ok(res, { list, total, page: p, size, overview: await risk.overview() });
}));

router.post('/risk/:id/handle', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = (req.body && req.body.note) || '';
  const ban = !!(req.body && req.body.ban);
  const a = await db.queryOne('SELECT * FROM risk_alerts WHERE id = ?', [id]);
  if (!a) return bad(res, '告警不存在', 404);
  await db.exec('UPDATE risk_alerts SET handled = 1, handler_id = ?, handle_note = ? WHERE id = ?',
    [req.user.id, String(note).slice(0, 120) || '已处置', id]);
  if (ban) {
    await db.exec('UPDATE users SET status = 0 WHERE id = ?', [a.user_id]);
  }
  await audit(req, '处置风控告警', 'risk_alerts', `#${id}（${a.rule_name}）：${note || '已处置'}${ban ? ' · 同时封禁账号' : ''}`);
  ok(res, { handled: true, banned: ban });
}));

/** 手动跑一次风控扫描（演示用：点一下就能抓出新告警） */
router.post('/risk/sweep', wrap(async (req, res) => {
  const n = await risk.sweep(300);
  await audit(req, '手动触发风控扫描', 'risk_alerts', `新增 ${n} 条告警`);
  ok(res, { added: n, overview: await risk.overview() });
}));

/* ============================ 链路运维 ============================ */

router.get('/chain', wrap(async (req, res) => {
  const s = await store.stats();
  const sug = await store.suggestDifficulty();
  const pool = await store.pool(30);
  const v = await store.validate();
  const accounts = await db.query(
    'SELECT * FROM point_accounts WHERE is_system = 1 OR user_id IS NULL ORDER BY addr');
  const cfg = require('../lib/config');
  ok(res, { stats: s, suggest: sug, pool, validate: v, accounts,
    config: { maxTxPerBlock: cfg.chain.maxTxPerBlock, intervalMs: cfg.chain.blockIntervalMs,
      targetMs: cfg.chain.targetMs, difficulty: store.getDifficulty() } });
}));

/** 手动出块：把交易池当前的交易打成一个块（能现场看到挖矿耗时） */
router.post('/chain/mine', wrap(async (req, res) => {
  const t0 = Date.now();
  const b = await store.mineBlock({ maxTx: Number((req.body && req.body.maxTx)) || 50 });
  if (!b) return bad(res, '交易池是空的，没有可打包的交易');
  await audit(req, '手动出块', 'blocks', `高度 ${b.height}，打包 ${b.pending} 笔，耗时 ${Date.now() - t0}ms`);
  const v = await store.validate();
  ok(res, { height: b.height, hash: b.hash, txCount: b.pending, nonce: b.nonce,
    difficulty: b.difficulty, minedMs: Date.now() - t0, validate: { ok: v.ok, reason: v.reason } });
}));

/**
 * 调难度。这是最能说明「PoW 是什么」的一个交互：
 * 调到 5 出块就明显变慢（工作量 ×16），调到 3 立刻变快。
 */
router.post('/chain/difficulty', wrap(async (req, res) => {
  const d = store.setDifficulty(Number((req.body && req.body.difficulty)));
  await audit(req, '调整挖矿难度', 'blocks', `难度调整为 ${d}`);
  ok(res, { difficulty: d });
}));

/** 对账台：把全站「业务流水 / 用户汇总 / 链上账户」三方摆一起 */
router.get('/reconcile', wrap(async (req, res) => {
  const all = await points.reconcileAll();
  const systems = await db.query(
    'SELECT * FROM point_accounts WHERE is_system = 1 OR user_id IS NULL ORDER BY addr');
  const ledgerSum = await db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN direction=1 THEN amount ELSE 0 END),0) AS inflow,
            COALESCE(SUM(CASE WHEN direction=-1 THEN amount ELSE 0 END),0) AS outflow,
            COUNT(*) AS rows_cnt FROM point_ledger`);
  const ledgerByType = await db.query(
    'SELECT type, direction, COUNT(*) AS n, SUM(amount) AS amt FROM point_ledger GROUP BY type, direction ORDER BY amt DESC');
  const issuedTx = Number(await db.scalar(
    `SELECT COALESCE(SUM(amount),0) AS v FROM txs WHERE from_addr='CJMINT' AND type <> 'BADGE'`)) || 0;
  const burnedTx = Number(await db.scalar(
    `SELECT COALESCE(SUM(amount),0) AS v FROM txs WHERE to_addr='CJBURN'`)) || 0;
  ok(res, { ...all, systems, ledgerSum, ledgerByType, issuedTx, burnedTx,
    balance: { ledger: Number(ledgerSum.inflow) - Number(ledgerSum.outflow),
      users: Number(await db.scalar('SELECT COALESCE(SUM(balance),0) AS v FROM user_stats')) || 0,
      chainIssued: issuedTx, chainBurned: burnedTx } });
}));

/* ============================ 公告与审计 ============================ */

router.get('/announcements', wrap(async (req, res) => {
  const list = await db.query('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 60');
  ok(res, { list });
}));

router.post('/announcements', wrap(async (req, res) => {
  const { title, content, category, pinned } = req.body || {};
  if (!title) return bad(res, '公告标题不能为空');
  const r = await db.exec(
    `INSERT INTO announcements (title, content, category, pinned, author_id, status) VALUES (?,?,?,?,?,1)`,
    [String(title).slice(0, 80), String(content || '').slice(0, 400), category || 'notice',
      pinned ? 1 : 0, req.user.id]);
  await audit(req, '发布公告', 'announcements', String(title).slice(0, 60));
  ok(res, { id: r.insertId });
}));

router.post('/announcements/:id/delete', wrap(async (req, res) => {
  await db.exec('UPDATE announcements SET status = 0 WHERE id = ?', [Number(req.params.id)]);
  await audit(req, '下架公告', 'announcements', `#${req.params.id}`);
  ok(res, {});
}));

router.get('/audit', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const where = []; const args = [];
  if (req.query.action) { where.push('a.action LIKE ?'); args.push('%' + req.query.action + '%'); }
  if (req.query.actor) { where.push('u.nickname LIKE ?'); args.push('%' + req.query.actor + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(await db.scalar(
    `SELECT COUNT(*) AS c FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${w}`, args));
  const list = await db.query(
    `SELECT a.*, u.nickname, u.role AS actor_role_name FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...args, size, offset]);
  ok(res, { list, total, page: p, size });
}));

/* ============================ 数据看板（图表） ============================ */

router.get('/analytics', wrap(async (req, res) => {
  const days = Math.min(60, Number(req.query.days) || 21);
  // 注意：趋势里不含「今天」。今天还在进行中，任务刚生成、完成数接近 0，
  // 若画进趋势会得到一根掉到 0 的悬崖，让人误以为系统出问题。
  const daily = await db.query(
    `SELECT d.day,
            (SELECT COUNT(*) FROM checkins c WHERE c.day = d.day) AS checkin_users,
            (SELECT COUNT(*) FROM tasks t WHERE t.day = d.day) AS tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.day = d.day AND t.status='done') AS done_tasks,
            (SELECT COALESCE(SUM(amount),0) FROM point_ledger p
              WHERE DATE(p.created_at) = d.day AND p.direction = 1) AS issued,
            (SELECT COALESCE(SUM(amount),0) FROM point_ledger p
              WHERE DATE(p.created_at) = d.day AND p.direction = -1) AS consumed
       FROM (SELECT DISTINCT day FROM checkins
             UNION SELECT DISTINCT day FROM tasks) d
      WHERE d.day > DATE_SUB(CURDATE(), INTERVAL ? DAY) AND d.day < CURDATE()
      ORDER BY d.day ASC`, [days]);
  const dist = await db.query(
    `SELECT CASE WHEN balance < 50 THEN '0-49' WHEN balance < 150 THEN '50-149'
                 WHEN balance < 400 THEN '150-399' WHEN balance < 1000 THEN '400-999'
                 ELSE '1000+' END AS bucket, COUNT(*) AS n
       FROM user_stats GROUP BY bucket
      ORDER BY FIELD(bucket,'0-49','50-149','150-399','400-999','1000+')`);
  const levelDist = await db.query(
    'SELECT level, COUNT(*) AS n FROM user_stats GROUP BY level ORDER BY level');
  const byCategory = await db.query(
    `SELECT category, COUNT(*) AS n, SUM(status='done') AS done FROM tasks GROUP BY category ORDER BY n DESC`);
  const funnel = await db.queryOne(
    `SELECT (SELECT COUNT(*) FROM users WHERE role='user') AS users,
            (SELECT COUNT(DISTINCT user_id) FROM checkins) AS checked,
            (SELECT COUNT(DISTINCT user_id) FROM tasks WHERE status='done') AS did_task,
            (SELECT COUNT(DISTINCT user_id) FROM badge_claims) AS has_badge,
            (SELECT COUNT(DISTINCT user_id) FROM redemptions) AS redeemed,
            (SELECT COUNT(DISTINCT user_id) FROM donations) AS donated`);
  const badgeHot = await db.query(
    `SELECT b.name, b.category, b.level, b.cost, b.supply,
            (SELECT COUNT(*) FROM badge_claims c WHERE c.badge_id = b.id) AS claims
       FROM badges b ORDER BY claims DESC LIMIT 12`);
  const hourHeat = await db.query(
    `SELECT HOUR(created_at) AS h, COUNT(*) AS n FROM point_ledger GROUP BY HOUR(created_at) ORDER BY h`);
  const weekHeat = await db.query(
    `SELECT DAYOFWEEK(day) AS w, COUNT(*) AS n FROM checkins GROUP BY DAYOFWEEK(day) ORDER BY w`);
  const topTeams = await db.query(
    `SELECT t.name, t.member_count, t.total_points, t.checkin_rate, u.nickname AS owner
       FROM teams t JOIN users u ON u.id = t.owner_id ORDER BY t.total_points DESC LIMIT 10`);
  const redempByCat = await db.query(
    `SELECT w.category, COUNT(*) AS n, SUM(r.cost) AS cost FROM redemptions r
       JOIN rewards w ON w.id = r.reward_id GROUP BY w.category ORDER BY cost DESC`);
  ok(res, { daily, dist, levelDist, byCategory, funnel, badgeHot, hourHeat, weekHeat, topTeams, redempByCat });
}));

module.exports = router;
