'use strict';
/**
 * 用户端 API（学习者视角）
 * 所有前端页面展示的数据都从这里出 —— 前端不内置任何 mock 数据。
 */
const express = require('express');
const db = require('../lib/db');
const points = require('../lib/points');
const store = require('../lib/chainstore');
const auth = require('../lib/auth');
const chain = require('../lib/chain');

const router = express.Router();
const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, msg });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[api]', req.method, req.originalUrl, e.message);
  bad(res, e.message || '服务器错误', 500);
});
const page = (q) => {
  const p = Math.max(1, Number(q.page) || 1);
  const size = Math.min(100, Math.max(1, Number(q.size) || 20));
  return { p, size, offset: (p - 1) * size };
};

/* ============================ 注册 / 登录 ============================ */

router.post('/auth/register', wrap(async (req, res) => {
  const { username, nickname, password, city, goal } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return bad(res, '用户名需 3~20 位字母数字下划线');
  if (!password || String(password).length < 6) return bad(res, '密码至少 6 位');
  const dup = await db.queryOne('SELECT id FROM users WHERE username = ?', [username]);
  if (dup) return bad(res, '用户名已被占用');

  const kp = chain.newKeyPair();
  const salt = auth.newSalt();
  const r = await db.exec(
    `INSERT INTO users (username, nickname, password, salt, role, addr, pub_key, priv_key, city, goal)
     VALUES (?,?,?,?,'user',?,?,?,?,?)`,
    [username, nickname || username, auth.hashPassword(password, salt), salt,
      chain.addressOf(kp.pub), kp.pub, kp.priv, city || '', goal || '']);
  await db.exec('INSERT INTO user_stats (user_id, balance, earned, spent, level) VALUES (?,0,0,0,1)', [r.insertId]);
  await store.ensureAccount(chain.addressOf(kp.pub), r.insertId, nickname || username, 0);
  await db.exec(`INSERT INTO audit_logs (actor_id, actor_role, action, target, detail) VALUES (?,?,?,?,?)`,
    [r.insertId, 'user', '注册账号', 'users', `生成链上地址 ${chain.addressOf(kp.pub).slice(0, 12)}…`]);
  const u = await db.queryOne('SELECT * FROM users WHERE id = ?', [r.insertId]);
  auth.setCookie(res, auth.makeToken(u));
  ok(res, { user: { id: u.id, username: u.username, nickname: u.nickname, addr: u.addr, role: u.role } });
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = await db.queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!u) return bad(res, '用户名或密码不对');
  if (auth.hashPassword(String(password), u.salt) !== u.password) return bad(res, '用户名或密码不对');
  if (!u.status) return bad(res, '账号已被封禁，请联系运营', 403);
  await db.exec('UPDATE users SET last_login = NOW() WHERE id = ?', [u.id]);
  auth.setCookie(res, auth.makeToken(u));
  ok(res, { user: { id: u.id, username: u.username, nickname: u.nickname, addr: u.addr, role: u.role } });
}));

router.post('/auth/logout', (req, res) => { auth.clearCookie(res); ok(res, {}); });

/** 我是谁：个人主页首屏需要的全部数据一次给全，减少前端往返 */
router.get('/me', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return ok(res, { user: null });
  const day = points.dayOf();
  const ck = await db.queryOne('SELECT * FROM checkins WHERE user_id = ? AND day = ?', [u.id, day]);
  const t = await db.queryOne(
    `SELECT COUNT(*) AS total, SUM(status='done') AS done FROM tasks WHERE user_id = ? AND day = ?`, [u.id, day]);
  const rules = await points.loadRules();
  const ladder = points.parseLadder(rules.streak_bonus.val_text, []);
  // 跨天后早该断掉的 streak 要先归零，否则会出现
  // 「连续签到第 41 天等着你」点下去却变成「连续 1 天」这种自相矛盾
  const curStreak = await points.effectiveStreak(u.id, day);
  const nextStreak = curStreak + 1;
  const recent = await db.query(
    `SELECT type, direction, amount, balance_after, memo, txid, block_height, created_at
       FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 8`, [u.id]);
  const acc = await db.queryOne('SELECT * FROM point_accounts WHERE addr = ?', [u.addr]);
  const step = Math.max(1, rules.level_exp.val_num);
  const rank = Number(await db.scalar(
    'SELECT COUNT(*) + 1 AS r FROM user_stats WHERE balance > ?', [u.balance || 0]));
  ok(res, {
    user: {
      id: u.id, username: u.username, nickname: u.nickname, addr: u.addr, role: u.role,
      city: u.city, goal: u.goal, bio: u.bio, created_at: u.created_at, last_login: u.last_login,
      balance: Number(u.balance || 0), earned: Number(u.earned || 0), spent: Number(u.spent || 0),
      frozen: Number(u.frozen || 0), checkin_days: Number(u.checkin_days || 0),
      streak: curStreak, max_streak: Number(u.max_streak || 0),
      task_done: Number(u.task_done || 0), day_clear: Number(u.day_clear || 0),
      badge_count: Number(u.badge_count || 0), level: Number(u.level || 1), exp: Number(u.exp || 0),
      rank, on_chain: acc ? Number(acc.on_chain) : 0, tx_count: acc ? Number(acc.tx_count) : 0,
    },
    today: {
      day, checked: !!ck,
      checkin: ck || null,
      taskTotal: Number(t.total || 0), taskDone: Number(t.done || 0),
      streakNow: Number(u.streak || 0),
      streakIfCheckin: nextStreak,
      checkinPreview: Math.round(rules.checkin_base.val_num) + (nextStreak >= 2
        ? ladder[Math.min(nextStreak - 1, ladder.length - 1)] || 0 : 0),
      dayBonus: Math.round(rules.day_bonus.val_num),
    },
    levelProgress: { level: Number(u.level || 1), exp: Number(u.exp || 0), step,
      toNext: step - (Number(u.exp || 0) % step), pct: Math.round((Number(u.exp || 0) % step) / step * 100) },
    recent,
  });
}));

/* ============================ 签到 ============================ */

/** 今日任务清单（没有就按模板自动铺一份，这是「每日任务」的来源） */
router.get('/today', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const day = req.query.day || points.dayOf();
  let tasks = await db.query(
    `SELECT * FROM tasks WHERE user_id = ? AND day = ? ORDER BY sort_no, id`, [u.id, day]);
  if (!tasks.length) {
    const n = await points.materialize(u.id, day);
    if (n) tasks = await db.query(
      `SELECT * FROM tasks WHERE user_id = ? AND day = ? ORDER BY sort_no, id`, [u.id, day]);
  }
  const ck = await db.queryOne('SELECT * FROM checkins WHERE user_id = ? AND day = ?', [u.id, day]);
  const done = tasks.filter((t) => t.status === 'done').length;
  const rules = await points.loadRules();
  // 「现在签一下能拿多少分」必须由服务端算好再给前端，别让前端自己去拼
  // （之前 /today 没这个字段，签到卡上直接印出 +undefined 分）
  const ladder = points.parseLadder(rules.streak_bonus.val_text, []);
  const streakNow = ck ? Number(ck.streak_after) : await points.effectiveStreak(u.id, day);
  const streakIfCheckin = ck ? streakNow : streakNow + 1;
  const checkinPreview = Math.round(rules.checkin_base.val_num) + (streakIfCheckin >= 2
    ? ladder[Math.min(streakIfCheckin - 1, ladder.length - 1)] || 0 : 0);
  ok(res, { day, tasks, checkin: ck, total: tasks.length, done,
    allClear: tasks.length > 0 && done === tasks.length,
    dayBonus: Math.round(rules.day_bonus.val_num),
    streakNow, streakIfCheckin, checkinPreview });
}));

router.post('/checkin', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
  const r = await points.checkin(u.id, {
    day: (req.body && req.body.day) || undefined,
    ip, device: (req.body && req.body.device) || ('WEB-' + chain.sha256(String(ip) + (req.headers['user-agent'] || '')).slice(0, 8).toUpperCase()),
  });
  if (r.already) return ok(res, { already: true, checkin: r.checkin });
  await db.exec(`INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, ip, txid) VALUES (?,?,?,?,?,?,?)`,
    [u.id, u.role, '每日签到', 'checkins', `连续第 ${r.streak} 天，得 ${r.total} 分`, ip, r.txid]);
  ok(res, { already: false, ...r });
}));

router.get('/checkins', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const days = Math.min(180, Number(req.query.days) || 42);
  const rows = await db.query(
    `SELECT * FROM checkins WHERE user_id = ? ORDER BY day DESC LIMIT ?`, [u.id, days]);
  ok(res, { list: rows });
}));

/** 签到热力图：近 N 天的签到/完成情况，前端画格子 */
router.get('/heatmap', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const days = Math.min(180, Number(req.query.days) || 84);
  const rows = await db.query(
    `SELECT c.day, c.total_points, c.streak_after,
            (SELECT COUNT(*) FROM tasks t WHERE t.user_id = c.user_id AND t.day = c.day) AS task_total,
            (SELECT COUNT(*) FROM tasks t WHERE t.user_id = c.user_id AND t.day = c.day AND t.status='done') AS task_done
       FROM checkins c WHERE c.user_id = ? AND c.day > DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY c.day ASC`, [u.id, days]);
  ok(res, { days, list: rows });
}));

/* ============================ 任务 ============================ */

router.get('/tasks', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { p, size, offset } = page(req.query);
  const where = ['user_id = ?']; const args = [u.id];
  if (req.query.day) { where.push('day = ?'); args.push(req.query.day); }
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  const total = Number(await db.scalar(`SELECT COUNT(*) AS c FROM tasks WHERE ${where.join(' AND ')}`, args));
  const list = await db.query(
    `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY day DESC, sort_no ASC LIMIT ? OFFSET ?`,
    [...args, size, offset]);
  ok(res, { list, total, page: p, size });
}));

router.post('/tasks', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { title, category, est_min } = req.body || {};
  if (!title || String(title).trim().length < 2) return bad(res, '任务名称太短');
  const day = (req.body && req.body.day) || points.dayOf();
  const sort = Number(await db.scalar(
    'SELECT COALESCE(MAX(sort_no),0) + 1 AS s FROM tasks WHERE user_id = ? AND day = ?', [u.id, day]));
  const r = await db.exec(
    `INSERT INTO tasks (user_id, day, title, category, est_min, points, status, sort_no) VALUES (?,?,?,?,?,?, 'todo', ?)`,
    [u.id, day, String(title).trim().slice(0, 60), category || 'other', Number(est_min) || 25, 1, sort]);
  await db.exec(`INSERT INTO task_logs (task_id, user_id, action) VALUES (?,?,?)`, [r.insertId, u.id, 'create']);
  ok(res, { id: r.insertId });
}));

router.post('/tasks/:id/done', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const r = await points.completeTask(Number(req.params.id), u.id);
  ok(res, r);
}));

router.post('/tasks/:id/undo', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, await points.undoTask(Number(req.params.id), u.id));
}));

router.post('/tasks/:id/skip', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, await points.skipTask(Number(req.params.id), u.id));
}));

router.post('/tasks/:id/delete', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const t = await db.queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [Number(req.params.id), u.id]);
  if (!t) return bad(res, '任务不存在');
  if (t.status === 'done') return bad(res, '已完成的任务不能删（先取消完成，积分会追回）');
  await db.exec('DELETE FROM tasks WHERE id = ?', [t.id]);
  ok(res, {});
}));

/* ============================ 模板 ============================ */

router.get('/templates', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, { list: await db.query('SELECT * FROM task_templates WHERE user_id = ? ORDER BY id DESC', [u.id]) });
}));

router.post('/templates', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { title, category, detail, est_min, repeat_type, weekly_day, remind_at } = req.body || {};
  if (!title) return bad(res, '模板名称不能为空');
  const r = await db.exec(
    `INSERT INTO task_templates (user_id, title, category, detail, est_min, points, repeat_type, weekly_day, remind_at, enabled)
     VALUES (?,?,?,?,?,1,?,?,?,1)`,
    [u.id, String(title).slice(0, 60), category || 'other', detail || '', Number(est_min) || 25,
      repeat_type || 'daily', weekly_day || null, remind_at || null]);
  ok(res, { id: r.insertId });
}));

router.post('/templates/:id/toggle', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  await db.exec('UPDATE task_templates SET enabled = 1 - enabled WHERE id = ? AND user_id = ?',
    [Number(req.params.id), u.id]);
  ok(res, {});
}));

router.post('/templates/:id/delete', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  await db.exec('DELETE FROM task_templates WHERE id = ? AND user_id = ?', [Number(req.params.id), u.id]);
  ok(res, {});
}));

/* ============================ 积分明细 ============================ */

router.get('/ledger', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { p, size, offset } = page(req.query);
  const where = ['user_id = ?']; const args = [u.id];
  if (req.query.type) { where.push('type = ?'); args.push(req.query.type); }
  if (req.query.direction) { where.push('direction = ?'); args.push(Number(req.query.direction)); }
  const total = Number(await db.scalar(`SELECT COUNT(*) AS c FROM point_ledger WHERE ${where.join(' AND ')}`, args));
  const list = await db.query(
    `SELECT * FROM point_ledger WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, size, offset]);
  const byType = await db.query(
    `SELECT type, direction, COUNT(*) AS n, SUM(amount) AS amt FROM point_ledger
      WHERE user_id = ? GROUP BY type, direction ORDER BY amt DESC`, [u.id]);
  ok(res, { list, total, page: p, size, byType });
}));

/** 对账：把「流水 / 汇总 / 链上」三条路径的余额摆在一起给用户看 */
router.get('/reconcile', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, { ...(await points.reconcile(u.id)) });
}));

/* ============================ 徽章 ============================ */

router.get('/badges', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  const list = await db.query('SELECT * FROM badges ORDER BY category, cond_value ASC');
  let mine = [];
  if (u) {
    mine = await db.query('SELECT badge_id, serial, verify_code, txid, block_height, status, claimed_at FROM badge_claims WHERE user_id = ?', [u.id]);
  }
  const ownedIds = new Set(mine.map((m) => Number(m.badge_id)));
  const out = [];
  for (const b of list) {
    const el = u ? await points.badgeEligible(u.id, b) : { ok: false, why: '登录后可查看进度' };
    out.push({ ...b, owned: ownedIds.has(Number(b.id)),
      claim: mine.find((m) => Number(m.badge_id) === Number(b.id)) || null,
      eligible: el.ok, why: el.why,
      claimed_count: Number(await db.scalar('SELECT COUNT(*) AS c FROM badge_claims WHERE badge_id = ?', [b.id])) });
  }
  ok(res, { list: out, owned: mine.length,
    balance: u ? Number(u.balance || 0) : 0 });
}));

router.post('/badges/:id/claim', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const r = await points.claimBadge(u.id, Number(req.params.id));
  await db.exec(`INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, txid) VALUES (?,?,?,?,?,?)`,
    [u.id, u.role, '铸造成就徽章', 'badge_claims', `凭证号 ${r.serial}`, r.txid]);
  ok(res, r);
}));

router.get('/claims', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, { list: await db.query(
    `SELECT c.*, b.name AS badge_name, b.icon, b.color, b.level, b.cond_text, blk.hash AS block_hash
       FROM badge_claims c JOIN badges b ON b.id = c.badge_id
       LEFT JOIN blocks blk ON blk.height = c.block_height
      WHERE c.user_id = ? ORDER BY c.id DESC`, [u.id]) });
}));

/* ============================ 商城 ============================ */

router.get('/rewards', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  const where = ['status = 1']; const args = [];
  if (req.query.category) { where.push('category = ?'); args.push(req.query.category); }
  const list = await db.query(`SELECT * FROM rewards WHERE ${where.join(' AND ')} ORDER BY cost ASC`, args);
  let quota = {};
  if (u) {
    const rows = await db.query(
      `SELECT reward_id, COALESCE(SUM(qty),0) AS n FROM redemptions
        WHERE user_id = ? AND status <> 'cancel' GROUP BY reward_id`, [u.id]);
    rows.forEach((r) => { quota[r.reward_id] = Number(r.n); });
  }
  ok(res, { list: list.map((r) => ({ ...r, my_qty: quota[r.id] || 0 })),
    balance: u ? Number(u.balance || 0) : 0 });
}));

router.post('/rewards/:id/redeem', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const r = await points.redeem(u.id, Number(req.params.id), (req.body && req.body.qty) || 1);
  await db.exec(`INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, txid) VALUES (?,?,?,?,?,?)`,
    [u.id, u.role, '兑换商品', 'redemptions', `订单 ${r.orderNo} 消耗 ${r.cost} 分`, r.txid]);
  ok(res, r);
}));

router.get('/redemptions', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, { list: await db.query(
    `SELECT r.*, w.name AS reward_name, w.category, w.cover_color, blk.hash AS block_hash
       FROM redemptions r JOIN rewards w ON w.id = r.reward_id
       LEFT JOIN blocks blk ON blk.height = r.block_height
      WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 50`, [u.id]) });
}));

/* ============================ 公益 ============================ */

router.get('/donations', wrap(async (req, res) => {
  const list = await db.query(
    `SELECT d.*, u.nickname, blk.hash AS block_hash FROM donations d
       JOIN users u ON u.id = d.user_id LEFT JOIN blocks blk ON blk.height = d.block_height
      ORDER BY d.id DESC LIMIT 40`);
  const byTopic = await db.query(
    'SELECT topic, COUNT(*) AS n, SUM(amount) AS amt FROM donations GROUP BY topic ORDER BY amt DESC');
  const total = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt, COALESCE(SUM(match_amount),0) AS match_amt FROM donations');
  ok(res, { list, byTopic, total });
}));

router.post('/donations', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { topic, amount, message } = req.body || {};
  if (!topic) return bad(res, '请选择捐赠方向');
  ok(res, await points.donate(u.id, String(topic).slice(0, 60), Number(amount) || 0, message || ''));
}));

/* ============================ 押注 ============================ */

router.get('/stakes', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  ok(res, { list: await db.query('SELECT * FROM stakes WHERE user_id = ? ORDER BY id DESC', [u.id]) });
}));

router.post('/stakes', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { title, amount, odds, days, needCount, startDay } = req.body || {};
  if (!title) return bad(res, '请写下你要押的目标');
  ok(res, await points.createStake(u.id, { title: String(title).slice(0, 80), amount: Number(amount) || 0,
    odds: Number(odds) || 2, days: Number(days) || 7, needCount: Number(needCount) || 5, startDay }));
}));

router.post('/stakes/:id/bump', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const s = await db.queryOne('SELECT * FROM stakes WHERE id = ? AND user_id = ?', [Number(req.params.id), u.id]);
  if (!s || s.status !== 'running') return bad(res, '这笔押注不在进行中');
  await points.bumpStake(s.id, 1);
  ok(res, { done_count: Number(s.done_count) + 1 });
}));

router.post('/stakes/:id/settle', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const s = await db.queryOne('SELECT * FROM stakes WHERE id = ? AND user_id = ?', [Number(req.params.id), u.id]);
  if (!s) return bad(res, '押注不存在');
  if (s.status !== 'running') return bad(res, '这笔已经结算过了');
  ok(res, await points.settleStake(s.id));
}));

/* ============================ 自习室 ============================ */

router.get('/teams', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  const list = await db.query(
    `SELECT t.*, u.nickname AS owner_name,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members
       FROM teams t JOIN users u ON u.id = t.owner_id
      ORDER BY t.total_points DESC LIMIT 60`);
  let mine = [];
  if (u) mine = (await db.query('SELECT team_id, role FROM team_members WHERE user_id = ?', [u.id])).map((r) => Number(r.team_id));
  ok(res, { list: list.map((t) => ({ ...t, joined: mine.includes(Number(t.id)) })) });
}));

router.get('/teams/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const t = await db.queryOne(
    `SELECT t.*, u.nickname AS owner_name FROM teams t JOIN users u ON u.id = t.owner_id WHERE t.id = ?`, [id]);
  if (!t) return bad(res, '自习室不存在', 404);
  const members = await db.query(
    `SELECT m.*, u.nickname, u.addr, s.balance, s.streak, s.badge_count, s.level,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = m.user_id AND c.day = CURDATE()) AS checked_today
       FROM team_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN user_stats s ON s.user_id = m.user_id
      WHERE m.team_id = ? ORDER BY s.balance DESC`, [id]);
  ok(res, { team: t, members });
}));

router.post('/teams', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const { name, slogan, goal } = req.body || {};
  if (!name) return bad(res, '自习室需要一个名字');
  const code = chain.sha256(String(Date.now()) + u.id).slice(0, 6).toUpperCase();
  const r = await db.exec(
    `INSERT INTO teams (name, owner_id, slogan, goal, join_code, max_member, member_count) VALUES (?,?,?,?,?,20,1)`,
    [String(name).slice(0, 40), u.id, slogan || '', goal || '', code]);
  await db.exec(`INSERT INTO team_members (team_id, user_id, role) VALUES (?,?, 'owner')`, [r.insertId, u.id]);
  ok(res, { id: r.insertId, join_code: code });
}));

router.post('/teams/join', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const code = String((req.body && req.body.code) || '').toUpperCase().trim();
  const t = await db.queryOne('SELECT * FROM teams WHERE join_code = ?', [code]);
  if (!t) return bad(res, '邀请码不对');
  const had = await db.queryOne('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?', [t.id, u.id]);
  if (had) return bad(res, '你已经在这个自习室里了');
  const n = Number(await db.scalar('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?', [t.id]));
  if (n >= Number(t.max_member)) return bad(res, '自习室满了');
  await db.exec(`INSERT INTO team_members (team_id, user_id, role) VALUES (?,?, 'member')`, [t.id, u.id]);
  await db.exec('UPDATE teams SET member_count = member_count + 1 WHERE id = ?', [t.id]);
  ok(res, { id: t.id, name: t.name });
}));

/* ============================ 榜单 / 公告 / 统计 ============================ */

router.get('/leaderboard', wrap(async (req, res) => {
  const type = req.query.type || 'points';
  const order = type === 'streak' ? 's.max_streak DESC, s.streak DESC'
    : type === 'tasks' ? 's.task_done DESC' : type === 'badges' ? 's.badge_count DESC'
      : 's.balance DESC';
  const list = await db.query(
    `SELECT u.id, u.nickname, u.city, u.addr, u.goal,
            s.balance, s.streak, s.max_streak, s.task_done, s.badge_count, s.level, s.checkin_days
       FROM users u JOIN user_stats s ON s.user_id = u.id
      WHERE u.status = 1 AND u.role = 'user'
      ORDER BY ${order} LIMIT 20`);
  ok(res, { type, list });
}));

router.get('/announcements', wrap(async (req, res) => {
  const list = await db.query(
    `SELECT a.*, u.nickname AS author FROM announcements a
       LEFT JOIN users u ON u.id = a.author_id WHERE a.status = 1
      ORDER BY a.pinned DESC, a.id DESC LIMIT 30`);
  ok(res, { list });
}));

/** 个人看板：近 14 天曲线 + 积分构成 + 完成率 */
router.get('/stats/summary', wrap(async (req, res) => {
  const u = await auth.currentUser(req);
  if (!u) return bad(res, '请先登录', 401);
  const curve = await db.query(
    `SELECT DATE(created_at) AS day,
            SUM(CASE WHEN direction = 1 THEN amount ELSE 0 END) AS inflow,
            SUM(CASE WHEN direction = -1 THEN amount ELSE 0 END) AS outflow,
            COUNT(*) AS n
       FROM point_ledger WHERE user_id = ? AND created_at > DATE_SUB(CURDATE(), INTERVAL 14 DAY)
      GROUP BY DATE(created_at) ORDER BY day ASC`, [u.id]);
  const byType = await db.query(
    `SELECT type, COUNT(*) AS n, SUM(amount) AS amt FROM point_ledger
      WHERE user_id = ? AND direction = 1 GROUP BY type ORDER BY amt DESC`, [u.id]);
  const spend = await db.query(
    `SELECT type, COUNT(*) AS n, SUM(amount) AS amt FROM point_ledger
      WHERE user_id = ? AND direction = -1 GROUP BY type ORDER BY amt DESC`, [u.id]);
  const tasks = await db.queryOne(
    `SELECT COUNT(*) AS total, SUM(status='done') AS done, SUM(status='skip') AS skipped
       FROM tasks WHERE user_id = ? AND day > DATE_SUB(CURDATE(), INTERVAL 14 DAY)`, [u.id]);
  const best = await db.queryOne(
    `SELECT day, COUNT(*) AS n FROM tasks WHERE user_id = ? AND status='done'
      GROUP BY day ORDER BY n DESC LIMIT 1`, [u.id]);
  const worst = await db.queryOne(
    `SELECT day, COUNT(*) AS total, SUM(status='done') AS done FROM tasks
      WHERE user_id = ? AND day > DATE_SUB(CURDATE(), INTERVAL 14 DAY)
      GROUP BY day ORDER BY (SUM(status='done') / GREATEST(COUNT(*),1)) ASC LIMIT 1`, [u.id]);
  ok(res, { curve, byType, spend, tasks, best, worst,
    rate: tasks.total ? Math.round(Number(tasks.done) / Number(tasks.total) * 100) : 0 });
}));

/* ============================ 凭证验真（公开） ============================ */

/**
 * 演示用的「拿几个真凭证号」。验真页是公开的，老师/同学直接打开通常手里没有凭证号，
 * 这里给三个真实存在、状态不同的凭证，点一下就能看到验真结果。
 * 注意：必须放在 /verify/:code 前面，否则 '/verify/samples' 会被当成 code='samples'。
 */
router.get('/verify/samples', wrap(async (req, res) => {
  const list = await db.query(
    `SELECT c.verify_code, c.serial, c.status, c.revoke_reason, b.name AS badge_name, b.level, b.color, b.icon,
            u.nickname, c.block_height
       FROM badge_claims c JOIN badges b ON b.id = c.badge_id JOIN users u ON u.id = c.user_id
      WHERE c.verify_code IS NOT NULL AND c.block_height IS NOT NULL
      ORDER BY c.status = 'revoked' DESC, c.id DESC LIMIT 5`);
  const total = Number(await db.scalar('SELECT COUNT(*) AS c FROM badge_claims WHERE block_height IS NOT NULL')) || 0;
  const revokedTotal = Number(await db.scalar(
    "SELECT COUNT(*) AS c FROM badge_claims WHERE status = 'revoked'")) || 0;
  ok(res, { list, total, revokedTotal });
}));

router.get('/verify/:code', wrap(async (req, res) => {
  const r = await points.verifyClaim(req.params.code, { src: 'web',
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '') });
  ok(res, r);
}));

router.post('/verify', wrap(async (req, res) => {
  const r = await points.verifyClaim((req.body && req.body.code) || '', { src: 'api',
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '') });
  ok(res, r);
}));

/**
 * 验真二维码（服务端生成 SVG，不依赖任何外部二维码服务）。
 * 不做一个通用的「传文本生成二维码」接口 —— 那等于开了个任人调用的生成器；
 * 这里只允许编码本平台的验真链接，参数就是凭证号本身。
 */
router.get('/verify/:code/qr.svg', wrap(async (req, res) => {
  const QR = require('qrcode');
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${req.headers.host}`;
  const svg = await QR.toString(`${base}/verify?code=${encodeURIComponent(code)}`,
    { type: 'svg', margin: 1, width: 220, color: { dark: '#14172A', light: '#FFFFFF' } });
  res.type('image/svg+xml').send(svg);
}));

/** 首页/未登录也能看的公开数据 */
router.get('/public', wrap(async (req, res) => {
  const chainStat = await store.stats();
  const rec = await points.reconcileAll();
  const users = Number(await db.scalar('SELECT COUNT(*) AS c FROM users WHERE role = "user"')) || 0;
  const checkins = Number(await db.scalar('SELECT COUNT(*) AS c FROM checkins')) || 0;
  const tasksDone = Number(await db.scalar(`SELECT COUNT(*) AS c FROM tasks WHERE status='done'`)) || 0;
  const badges = Number(await db.scalar('SELECT COUNT(*) AS c FROM badge_claims')) || 0;
  const hot = await db.query(
    `SELECT u.nickname, u.city, s.balance, s.streak, s.badge_count FROM users u
       JOIN user_stats s ON s.user_id = u.id WHERE u.role='user' ORDER BY s.balance DESC LIMIT 8`);
  ok(res, { chain: chainStat, issued: rec.issued, burned: rec.burned, pool: rec.poolBal,
    users, checkins, tasksDone, badges, hot,
    chainOk: rec.ok });
}));

module.exports = router;
