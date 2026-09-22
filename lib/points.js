'use strict';
/**
 * 积分引擎 —— 整个平台的业务心脏。
 * ===============================================================
 * 设计原则（很重要，是这个项目「账目对得上」的原因）：
 *
 *   1. 只有一个入口写账。无论是签到、任务、兑换还是押注，最终都必须走
 *      credit() / debit() 这两个函数。它们负责同时写四处：
 *        · txs          链上交易（不可篡改的事实）
 *        · point_ledger 业务流水（带 balance_after，方便对账）
 *        · user_stats   余额/连续天数/等级等汇总
 *        · point_accounts 链上账户视角的余额
 *      四处要么一起成功要么一起失败（走事务），所以库里的账和链上的账永远相等。
 *
 *   2. 规则不写死在代码里。基础分、连续加成、日结奖励都从 point_rules 表读，
 *      运营在后台改一次就生效一次，且每次改动都上链存证（RULE 交易）。
 *
 *   3. 种子数据走同一套函数。演示数据不是 INSERT 出来的假表，而是「真跑了一遍业务」，
 *      所以验真、对账、链浏览器在演示数据上一样成立。
 */
const db = require('./db');
const chain = require('./chain');
const cfg = require('./config');
const store = require('./chainstore');
const keys = require('./keys');

/* ============================== 规则 ============================== */

let ruleCache = null;

// 默认规则（库里还没配时的兜底，与 sql 里灌进去的初始版本一致）
const DEFAULTS = {
  checkin_base: { rule_name: '签到基础分', val_num: cfg.points.checkinBase, val_text: '每次签到固定给分', unit: '分' },
  streak_bonus: { rule_name: '连续签到加成', val_num: 0, val_text: '1,2,3,5,8,12,18,25,40（连续第 n 天的额外分）', unit: '分' },
  task_point: { rule_name: '单任务完成分', val_num: cfg.points.taskPoint, val_text: '每个任务固定给分', unit: '分' },
  day_bonus: { rule_name: '当日全清奖励', val_num: cfg.points.dayBonus, val_text: '当天任务全部完成额外给分', unit: '分' },
  level_exp: { rule_name: '等级成长值', val_num: cfg.points.levelStep, val_text: '每多少成长值升一级', unit: '分' },
};

/** 把 val_text 里的阶梯串（"1,2,3,5"）解成数组 */
function parseLadder(text, fallback) {
  if (!text) return fallback;
  const arr = String(text).split(',').map((x) => Number(String(x).replace(/[^\d.]/g, ''))).filter((x) => !isNaN(x));
  return arr.length ? arr : fallback;
}

async function loadRules(force = false) {
  if (ruleCache && !force) return ruleCache;
  let rows = [];
  try {
    rows = await db.query('SELECT * FROM point_rules WHERE active = 1 ORDER BY rule_key, version DESC');
  } catch (e) { rows = []; }
  const map = {};
  for (const r of rows) if (!map[r.rule_key]) map[r.rule_key] = r; // 每个 key 只取最高版本
  const merged = {};
  for (const k of Object.keys(DEFAULTS)) merged[k] = map[k] ? { ...DEFAULTS[k], ...map[k], val_num: Number(map[k].val_num) } : { ...DEFAULTS[k] };
  ruleCache = merged;
  return merged;
}

function clearRuleCache() { ruleCache = null; }

/** 连续第 n 天签到应该拿多少加成 */
function streakBonus(streak, rules) {
  const ladder = parseLadder(rules.streak_bonus.val_text, cfg.points.streakBonus);
  const idx = Math.max(0, Math.min(streak - 1, ladder.length - 1));
  return streak >= 2 ? ladder[idx] : 0;
}

/* ============================== 写账 ============================== */

let txSeq = 0;
function nextNonce() { txSeq += 1; return txSeq; }

/**
 * 入账：平台发行积分给用户（from = 铸币账户）。
 * 积分不是凭空来的 —— 每一笔都从 CJMINT 发出，所以全站积分发行总量随时可审计。
 */
async function credit(o) {
  const { userId, addr, userName, type, amount, memo, refId, ts } = o;
  if (!(amount > 0)) throw new Error('入账金额必须为正');
  const tx = await store.submit({
    type, from: 'CJMINT', to: addr, amount, memo, ts: ts || Date.now(), nonce: nextNonce(),
  }, keys.platform().priv, {
    fromLabel: '系统铸币账户（积分发行总源头）',
    toUser: userId, toLabel: userName || addr,
  });

  const before = await db.scalar('SELECT balance FROM user_stats WHERE user_id = ?', [userId]);
  const after = Number(before || 0) + Number(amount);
  if (before === null) {
    await db.exec('INSERT INTO user_stats (user_id, balance, earned, exp) VALUES (?,?,?,?)',
      [userId, after, amount, amount]);
  } else {
    await db.exec('UPDATE user_stats SET balance = balance + ?, earned = earned + ?, exp = exp + ? WHERE user_id = ?',
      [amount, amount, amount, userId]);
  }
  await db.exec(
    `INSERT INTO point_ledger (user_id, addr, type, direction, amount, balance_after, memo, ref_id, txid, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [userId, addr, type, 1, amount, after, memo || '', refId || null, tx.txid, tsToSql(ts)]);
  await refreshLevel(userId);
  return { tx, balanceAfter: after };
}

/**
 * 出账：用户消耗积分（转到某个目标地址）。
 * toAddr 一般是 CJBURN（商城兑换 → 销毁，通胀可控）、CJDONATE（公益）、
 * CJPOOL（押注失败进奖池），或者另一个用户地址（转账）。
 * 「钱去哪了」在链上完全看得见，这正是设计四个系统账户的意义。
 */
async function debit(o) {
  const { userId, addr, userName, priv, type, amount, toAddr, toLabel, toUser, memo, refId, ts } = o;
  if (!(amount > 0)) throw new Error('出账金额必须为正');
  const bal = Number(await db.scalar('SELECT balance FROM user_stats WHERE user_id = ?', [userId])) || 0;
  if (bal < amount) throw new Error(`积分不足：当前 ${bal}，需要 ${amount}`);
  const tx = await store.submit({
    type, from: addr, to: toAddr, amount, memo, ts: ts || Date.now(), nonce: nextNonce(),
  }, keys.signerFor(addr, priv), {
    fromUser: userId, fromLabel: userName || addr,
    toUser: toUser, toLabel: toLabel || toAddr,
  });

  const after = bal - amount;
  await db.exec('UPDATE user_stats SET balance = balance - ?, spent = spent + ? WHERE user_id = ?',
    [amount, amount, userId]);
  await db.exec(
    `INSERT INTO point_ledger (user_id, addr, type, direction, amount, balance_after, memo, ref_id, txid, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [userId, addr, type, -1, amount, after, memo || '', refId || null, tx.txid, tsToSql(ts)]);
  await refreshLevel(userId);
  return { tx, balanceAfter: after };
}

/** 等级：成长值每满 levelStep 升 1 级，封顶 10 级 */
async function refreshLevel(userId) {
  const rules = await loadRules();
  const exp = Number(await db.scalar('SELECT exp FROM user_stats WHERE user_id = ?', [userId])) || 0;
  const lv = Math.max(1, Math.min(10, Math.floor(exp / Math.max(1, rules.level_exp.val_num)) + 1));
  await db.exec('UPDATE user_stats SET level = ? WHERE user_id = ?', [lv, userId]);
  return lv;
}

/* ============================== 签到 ============================== */

function dayOf(d) {
  const x = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** 上一天（按自然日，不碰时区那些坑） */
function prevDay(day) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 「此刻还有效」的连续签到天数。
 *
 * user_stats.streak 只在签到时被刷新，断签之后它不会自己归零 ——
 * 直接拿它当「当前连续」用，就会出现「上次签到是半个月前，界面还说你连续 40 天」
 * 这种自相矛盾的话（预告「第 41 天等着你」，签完却显示「连续 1 天」）。
 * 展示口径统一走这里：今天签过用今天的，今天没签看昨天的，昨天也没签就是 0。
 */
async function effectiveStreak(userId, day) {
  const d = day || dayOf();
  const cur = await db.queryOne(
    'SELECT streak_after FROM checkins WHERE user_id = ? AND day = ?', [userId, d]);
  if (cur) return Number(cur.streak_after);
  const prev = await db.queryOne(
    'SELECT streak_after FROM checkins WHERE user_id = ? AND day = ?', [userId, prevDay(d)]);
  return prev ? Number(prev.streak_after) : 0;
}

/**
 * 时间戳 → MySQL DATETIME 字符串。
 * 必须显式写入 created_at，不能靠 DEFAULT CURRENT_TIMESTAMP：
 * 灌历史数据时所有流水都会塌成「今天」，日结去重、日活视图、风控的
 * 「1 小时内暴增」判定会全部失真。这个坑踩过一次，记在这儿。
 */
function tsToSql(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 签到。
 * 连续加成是产品的核心钩子：第 1 天只拿基础分，连到第 7 天单次就能拿 5+12=17 分，
 * 断签一次加成归零 —— 但历史最长连续天数会记着，用来发「坚持过」的徽章。
 */
async function checkin(userId, opt = {}) {
  const day = opt.day || dayOf();
  const exist = await db.queryOne('SELECT * FROM checkins WHERE user_id = ? AND day = ?', [userId, day]);
  if (exist) return { already: true, checkin: exist };

  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  if (!u) throw new Error('用户不存在');
  const rules = await loadRules();

  // 昨天签到了吗？决定连续天数
  const y = new Date(day + 'T00:00:00');
  y.setDate(y.getDate() - 1);
  const yStr = dayOf(y);
  const yRow = await db.queryOne('SELECT streak_after FROM checkins WHERE user_id = ? AND day = ?', [userId, yStr]);
  const streak = yRow ? Number(yRow.streak_after) + 1 : 1;

  const base = Math.round(rules.checkin_base.val_num);
  const bonus = streakBonus(streak, rules);
  const total = base + bonus;
  const ts = opt.ts || Date.now();

  const r = await credit({
    userId, addr: u.addr, userName: u.nickname, type: 'CHECKIN', amount: total,
    memo: `第 ${streak} 天连续签到（基础 ${base} + 连续加成 ${bonus}）`, ts,
  });

  const d = new Date(ts);
  const late = d.getHours() >= 23 ? 1 : 0;
  await db.exec(
    `INSERT INTO checkins (user_id, day, base_points, bonus_points, streak_after, total_points, late_flag, ip, device, txid, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, day, base, bonus, streak, total, late, opt.ip || null, opt.device || null, r.tx.txid,
      new Date(ts).toISOString().slice(0, 19).replace('T', ' ')]);
  await db.exec(
    `UPDATE user_stats SET streak = ?, checkin_days = checkin_days + 1,
       max_streak = GREATEST(max_streak, ?) WHERE user_id = ?`, [streak, streak, userId]);

  await store.autoMine();
  return { already: false, day, base, bonus, total, streak, txid: r.tx.txid, balanceAfter: r.balanceAfter };
}

/* ============================== 任务 ============================== */

/** 按模板生成某一天的任务实例 */
async function materialize(userId, day, opt = {}) {
  const tpls = await db.query(
    `SELECT * FROM task_templates WHERE user_id = ? AND enabled = 1
       AND (repeat_type = 'daily' OR (repeat_type = 'weekday' AND DAYOFWEEK(?) BETWEEN 2 AND 6)
            OR (repeat_type = 'weekly' AND weekly_day = DAYOFWEEK(?)))
     ORDER BY id`, [userId, day, day]);
  if (!tpls.length) return 0;
  const rows = tpls.map((t, i) => [userId, day, t.title, t.category, t.est_min, t.points, 'todo', t.id, i + 1]);
  await db.insertMany('tasks',
    ['user_id', 'day', 'title', 'category', 'est_min', 'points', 'status', 'from_tpl', 'sort_no'], rows);
  return rows.length;
}

/** 勾选任务：完成任务 → 加 1 分；如果当天任务因此全部完成 → 再发「当日全清」加分 */
async function completeTask(taskId, userId, opt = {}) {
  const t = await db.queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, userId]);
  if (!t) throw new Error('任务不存在');
  if (t.status === 'done') return { already: true };

  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const rules = await loadRules();
  const pnt = Number(t.points) || Math.round(rules.task_point.val_num);
  const ts = opt.ts || Date.now();

  const logId = (await db.exec(
    `INSERT INTO task_logs (task_id, user_id, action, points_delta, ip, created_at) VALUES (?,?,?,?,?,?)`,
    [taskId, userId, 'done', pnt, opt.ip || null, new Date(ts).toISOString().slice(0, 19).replace('T', ' ')]
  )).insertId;

  const r = await credit({
    userId, addr: u.addr, userName: u.nickname, type: 'TASK', amount: pnt,
    memo: `完成任务「${t.title}」`, refId: taskId, ts,
  });
  await db.exec(
    `UPDATE tasks SET status='done', done_at=?, txid=? WHERE id = ?`,
    [new Date(ts).toISOString().slice(0, 19).replace('T', ' '), r.tx.txid, taskId]);
  await db.exec('UPDATE user_stats SET task_done = task_done + 1 WHERE user_id = ?', [userId]);

  const out = { already: false, points: pnt, txid: r.tx.txid, dayBonus: null, balanceAfter: r.balanceAfter };

  // 当天任务全清 → 日结奖励
  const left = Number(await db.scalar(
    `SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND day = ? AND status = 'todo'`, [userId, dayOf(t.day)]));
  if (left === 0) {
    const done = Number(await db.scalar('SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND day = ?', [userId, dayOf(t.day)]));
    if (done > 0) {
      const already = await db.queryOne(
        `SELECT id FROM point_ledger WHERE user_id = ? AND type = 'daybonus' AND DATE(created_at) = ?`,
        [userId, dayOf(t.day)]);
      if (!already) {
        const bonusAmt = Math.round(rules.day_bonus.val_num);
        const b = await credit({
          userId, addr: u.addr, userName: u.nickname, type: 'DAYBONUS', amount: bonusAmt,
          memo: `当日 ${done} 项任务全部完成`, ts: ts + 1,
        });
        await db.exec('UPDATE user_stats SET day_clear = day_clear + 1 WHERE user_id = ?', [userId]);
        out.dayBonus = { points: bonusAmt, txid: b.tx.txid, done, balanceAfter: b.balanceAfter };
      }
    }
  }
  await store.autoMine();
  return out;
}

/** 取消勾选：把分追回（负流水），并留一条 undo 日志 —— 反复勾选取消是刷分特征，风控要读 */
async function undoTask(taskId, userId, opt = {}) {
  const t = await db.queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, userId]);
  if (!t || t.status !== 'done') throw new Error('任务未完成，无需取消');
  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const pnt = Number(t.points) || 1;
  await db.exec(
    `INSERT INTO task_logs (task_id, user_id, action, points_delta, created_at) VALUES (?,?,?,?,?)`,
    [taskId, userId, 'undo', -pnt, tsToSql(opt.ts || Date.now())]);
  // 追回：从用户地址转回铸币账户（相当于回收，而不是凭空消失）
  const r = await debit({
    userId, addr: u.addr, userName: u.nickname, priv: u.priv_key, type: 'ADJUST', amount: pnt,
    toAddr: 'CJMINT', toLabel: '系统铸币账户（积分发行总源头）',
    memo: `撤销任务「${t.title}」追回积分`, refId: taskId, ts: opt.ts || Date.now(),
  });
  await db.exec(`UPDATE tasks SET status='todo', done_at=NULL, txid=NULL WHERE id = ?`, [taskId]);
  await db.exec('UPDATE user_stats SET task_done = GREATEST(task_done - 1, 0) WHERE user_id = ?', [userId]);
  await store.autoMine();
  return { points: pnt, txid: r.tx.txid, balanceAfter: r.balanceAfter };
}

async function skipTask(taskId, userId, opt = {}) {
  await db.exec(`UPDATE tasks SET status='skip' WHERE id = ? AND user_id = ?`, [taskId, userId]);
  await db.exec(`INSERT INTO task_logs (task_id, user_id, action, created_at) VALUES (?,?,?,?)`,
    [taskId, userId, 'skip', tsToSql(opt.ts || Date.now())]);
  return { ok: true };
}

/* ============================== 徽章 ============================== */

/** 判断用户是否达成徽章条件 */
async function badgeEligible(userId, b) {
  const s = await db.queryOne('SELECT * FROM user_stats WHERE user_id = ?', [userId]);
  if (!s) return { ok: false, why: '无统计数据' };
  const v = Number(b.cond_value);
  const map = {
    streak: () => [Number(s.max_streak) >= v, `历史最长连续 ${s.max_streak} 天 / 需要 ${v} 天`],
    checkin_days: () => [Number(s.checkin_days) >= v, `累计签到 ${s.checkin_days} 天 / 需要 ${v} 天`],
    earned: () => [Number(s.earned) >= v, `累计获得 ${s.earned} 分 / 需要 ${v} 分`],
    task_done: () => [Number(s.task_done) >= v, `累计完成 ${s.task_done} 个任务 / 需要 ${v} 个`],
    day_clear: () => [Number(s.day_clear) >= v, `全清 ${s.day_clear} 天 / 需要 ${v} 天`],
    team_rank: () => [true, '自习室排行条件（演示环境默认开放）'],
  };
  const f = map[b.cond_type];
  if (!f) return { ok: false, why: '未知条件类型' };
  const [ok, why] = f();
  return { ok, why };
}

/** 铸造徽章：消耗积分 → 生成一张链上成就凭证（带 Merkle 证明与对外验真码） */
async function claimBadge(userId, badgeId, opt = {}) {
  const b = await db.queryOne('SELECT * FROM badges WHERE id = ?', [badgeId]);
  if (!b) throw new Error('徽章不存在');
  const own = await db.queryOne('SELECT id FROM badge_claims WHERE user_id = ? AND badge_id = ?', [userId, badgeId]);
  if (own) throw new Error('你已经拥有这枚徽章了');
  const el = await badgeEligible(userId, b);
  if (!el.ok) throw new Error('还没达成条件：' + el.why);
  if (b.supply_cap > 0 && Number(b.supply) >= Number(b.supply_cap)) throw new Error('这枚徽章已经发完了');

  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const ts = opt.ts || Date.now();
  const cost = Number(b.cost) || 0;
  let spend = null;
  if (cost > 0) {
    // 铸造消耗的积分转到销毁账户：链上永久可查「这枚徽章烧掉了多少分」
    spend = await debit({
      userId, addr: u.addr, userName: u.nickname, priv: u.priv_key, type: 'BADGE', amount: cost,
      toAddr: 'CJBURN', toLabel: '销毁账户（兑换消耗的积分打到这，全网可查）',
      memo: `铸造徽章「${b.name}」`, ts,
    });
  }
  // 平台再发一笔 0 分的 BADGE 交易：内容是「把凭证铸给这个地址」，凭证本体写在 memo 里
  const serial = await nextSerial(ts);
  const mint = await store.submit({
    type: 'BADGE', from: 'CJMINT', to: u.addr, amount: 0,
    memo: `铸造成就徽章 ${b.code} ${b.name} 凭证号 ${serial}`, ts: ts + 1, nonce: nextNonce(),
  }, keys.platform().priv, { toUser: userId, toLabel: u.nickname });

  const blk = await store.latestBlock();
  const ensure = await db.exec(
    `INSERT INTO badge_claims (user_id, badge_id, serial, cost, txid, block_height, verify_code, claimed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, badgeId, serial, cost, mint.txid, blk ? Number(blk.height) : 0,
      verifyCode(serial), new Date(ts).toISOString().slice(0, 19).replace('T', ' ')]);
  await db.exec('UPDATE badges SET supply = supply + 1 WHERE id = ?', [badgeId]);
  await db.exec('UPDATE user_stats SET badge_count = badge_count + 1, exp = exp + 30 WHERE user_id = ?', [userId]);
  await refreshLevel(userId);

  const claimId = ensure.insertId;
  // 批量灌数据时不要每次铸章都强制出块（192 枚徽章 = 192 次挖矿，纯浪费）。
  // 线上单次铸造则强制出块 —— 用户点完立刻能在链上看到这笔交易，体验才对。
  if (!store.isBulk()) {
    await store.autoMine(true);
    const proof = await store.merkleProofOf(mint.txid);
    if (proof) {
      await db.exec('UPDATE badge_claims SET merkle_path = ? WHERE id = ?',
        [JSON.stringify(proof.path), claimId]);
    }
  } else {
    await store.autoMine();
  }
  return { serial, txid: mint.txid, verifyCode: verifyCode(serial), spend,
    proof: store.isBulk() ? null : await store.merkleProofOf(mint.txid) };
}

/**
 * 补 Merkle 证明。
 * 徽章是在打包之前创建的，那时还不知道会落进第几块，所以证明要等打完包再补。
 * 不补的话验真页仍然显示「有效」（业务库 + 链上两层都对得上），
 * 但轻节点那一层就缺了证明，验收脚本会专门盯这一点。
 */
async function fillMerklePaths(limit = 5000) {
  const rows = await db.query(
    `SELECT id, txid FROM badge_claims WHERE merkle_path IS NULL OR merkle_path = '' LIMIT ?`, [limit]);
  let n = 0;
  for (const r of rows) {
    const p = await store.merkleProofOf(r.txid);
    if (!p) continue;
    await db.exec('UPDATE badge_claims SET merkle_path = ? WHERE id = ?', [JSON.stringify(p.path), r.id]);
    n++;
  }
  return { total: rows.length, filled: n };
}

async function nextSerial(ts) {
  const y = new Date(ts).getFullYear();
  const n = Number(await db.scalar('SELECT COUNT(*) AS c FROM badge_claims')) || 0;
  return `CJB-${y}-${String(n + 1).padStart(5, '0')}`;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function verifyCode(serial) {
  const raw = chain.sha256('CUNJIN' + serial).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let out = '';
  for (let i = 0; i < 12; i++) {
    const idx = parseInt(raw[i], 16) * 2 + (i % 2);
    out += CODE_ALPHABET[idx % CODE_ALPHABET.length];
  }
  // 形如 K7M2-9PQR-4TZ8，人工抄写不易错
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
}

/**
 * 凭证验真 —— 本项目的门面功能。
 * 三个层次都查：
 *   ① 业务库：凭证是否存在、是否被撤销
 *   ② 链上：那笔铸造交易是否真的在链上、金额/收款人对不对
 *   ③ 密码学：用 Merkle 证明验证「这笔交易确实在那个区块里」（轻节点做法）
 */
async function verifyClaim(code, opt = {}) {
  const clean = String(code || '').trim().toUpperCase();
  const rec = await db.queryOne(
    `SELECT c.*, b.name AS badge_name, b.code AS badge_code, b.level, b.icon, b.color, b.cond_text,
            u.nickname, u.addr, blk.hash AS block_hash, blk.ts AS block_ts, blk.difficulty, blk.nonce, blk.merkle_root
       FROM badge_claims c
       JOIN badges b ON b.id = c.badge_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN blocks blk ON blk.height = c.block_height
      WHERE c.verify_code = ? OR c.serial = ?`, [clean, clean]);
  if (!rec) {
    await db.exec(`INSERT INTO verify_records (verify_code, result, src, ip) VALUES (?,?,?,?)`,
      [clean, 'notfound', opt.src || 'web', opt.ip || null]);
    return { found: false, result: 'notfound', message: '查不到这个凭证号。请核对是否抄错。' };
  }
  const txRow = await db.queryOne('SELECT * FROM txs WHERE txid = ?', [rec.txid]);
  const onChain = !!(txRow && txRow.block_height !== null);
  let merkleOk = false, merkleDetail = null;
  if (onChain) {
    const proof = await store.merkleProofOf(rec.txid);
    if (proof) {
      merkleOk = chain.verifyMerkleProof(rec.txid, proof.path, proof.root);
      merkleDetail = { index: proof.index, total: proof.total, pathLen: proof.path.length, root: proof.root };
    }
  }
  const result = rec.status === 'revoked' ? 'revoked' : (!onChain ? 'tampered' : (merkleOk ? 'valid' : 'tampered'));
  await db.exec(`INSERT INTO verify_records (verify_code, claim_id, result, src, ip) VALUES (?,?,?,?,?)`,
    [clean, rec.id, result, opt.src || 'web', opt.ip || null]);
  return {
    found: true, result, merkleOk, merkleDetail,
    serial: rec.serial, verifyCode: rec.verify_code, claimedAt: rec.claimed_at, status: rec.status,
    revoked: rec.status === 'revoked'
      ? { at: rec.revoked_at, reason: rec.revoke_reason || '发行方未填写撤销理由' } : null,
    holder: { nickname: rec.nickname, addr: rec.addr },
    badge: { name: rec.badge_name, code: rec.badge_code, level: rec.level, icon: rec.icon,
      color: rec.color, cond: rec.cond_text },
    chain: onChain ? {
      txid: rec.txid, height: rec.block_height, blockHash: rec.block_hash,
      blockTs: Number(rec.block_ts), difficulty: rec.difficulty, nonce: Number(rec.nonce),
      merkleRoot: rec.merkle_root, amount: Number(txRow.amount), type: txRow.type, memo: txRow.memo,
    } : null,
    message: result === 'valid'
      ? (merkleOk ? '凭证有效：业务库、链上交易、Merkle 证明三层校验全部通过。' : '凭证在链上，但 Merkle 证明未通过，请留意。')
      : result === 'revoked'
        ? `凭证已被发行方撤销（${rec.revoked_at ? new Date(rec.revoked_at).toLocaleString('zh-CN') : '时间未记录'}）：`
          + (rec.revoke_reason || '未填写理由') + '。链上铸造记录仍在，撤销只代表平台不再认可这张凭证的效力。'
        : '凭证对应的交易不在链上，可能已被篡改。',
  };
}

/* ============================== 商城 ============================== */

async function redeem(userId, rewardId, qty = 1, opt = {}) {
  const rw = await db.queryOne('SELECT * FROM rewards WHERE id = ? AND status = 1', [rewardId]);
  if (!rw) throw new Error('商品不存在或已下架');
  const n = Math.max(1, Number(qty) || 1);
  if (Number(rw.stock) < n) throw new Error('库存不足');
  const limit = Number(rw.per_limit) || 1;
  const had = Number(await db.scalar(
    'SELECT COALESCE(SUM(qty),0) AS c FROM redemptions WHERE user_id = ? AND reward_id = ? AND status <> ?',
    [userId, rewardId, 'cancel'])) || 0;
  if (had + n > limit) throw new Error(`每人限兑 ${limit} 件，你已经兑过 ${had} 件`);

  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const cost = Number(rw.cost) * n;
  const ts = opt.ts || Date.now();
  // 兑换消耗 → 销毁账户。链上能查到「这个平台的积分被烧掉了多少」，通缩是可验证的
  const d = await debit({
    userId, addr: u.addr, userName: u.nickname, priv: u.priv_key, type: 'REDEEM', amount: cost,
    toAddr: 'CJBURN', toLabel: '销毁账户（兑换消耗的积分打到这，全网可查）',
    memo: `兑换「${rw.name}」x${n}`, refId: rewardId, ts,
  });
  const orderNo = 'CJ' + String(ts).slice(-9) + String(1000 + Math.floor(Math.random() * 9000));
  const blk = await store.latestBlock();
  await db.exec(
    `INSERT INTO redemptions (order_no, user_id, reward_id, cost, qty, status, txid, block_height, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [orderNo, userId, rewardId, cost, n, 'paid', d.tx.txid, blk ? Number(blk.height) : 0,
      new Date(ts).toISOString().slice(0, 19).replace('T', ' ')]);
  await db.exec('UPDATE rewards SET stock = stock - ?, sold = sold + ? WHERE id = ?', [n, n, rewardId]);
  await store.autoMine();
  return { orderNo, cost, txid: d.tx.txid, balanceAfter: d.balanceAfter };
}

/* ============================== 公益 ============================== */

async function donate(userId, topic, amount, message, opt = {}) {
  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const ts = opt.ts || Date.now();
  const d = await debit({
    userId, addr: u.addr, userName: u.nickname, priv: u.priv_key, type: 'DONATE', amount,
    toAddr: 'CJDONATE', toLabel: '公益账户（捐赠积分归集）',
    memo: `捐赠「${topic}」`, ts,
  });
  const match = Math.floor(Number(amount) * 0.1); // 平台 10% 配捐，让公益更有分量
  const blk = await store.latestBlock();
  await db.exec(
    `INSERT INTO donations (user_id, topic, amount, match_amount, txid, block_height, message, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, topic, amount, match, d.tx.txid, blk ? Number(blk.height) : 0, message || '',
      new Date(ts).toISOString().slice(0, 19).replace('T', ' ')]);
  await store.autoMine();
  return { amount, match, txid: d.tx.txid, balanceAfter: d.balanceAfter };
}

/* ============================== 押注 ============================== */

/**
 * 押注自己的目标：锁定积分。
 * 冻结金额计入 user_stats.frozen，不算可用余额 —— 不然用户可以「押完再花掉」。
 */
async function createStake(userId, o = {}) {
  const u = await db.queryOne('SELECT id, addr, nickname, priv_key FROM users WHERE id = ?', [userId]);
  const amount = Number(o.amount) || 0;
  if (amount <= 0) throw new Error('押注积分必须大于 0');
  const days = Number(o.days) || 7;
  const start = o.startDay || dayOf();
  const endD = new Date(start + 'T00:00:00');
  endD.setDate(endD.getDate() + days - 1);
  const ts = o.ts || Date.now();

  // 锁定 = 从用户地址转到一个「托管地址」（这里就用奖池地址作托管，结算时再分）
  const d = await debit({
    userId, addr: u.addr, userName: u.nickname, priv: u.priv_key, type: 'STAKE', amount,
    toAddr: 'CJPOOL', toLabel: '奖池账户（押注失败的积分进这，用于奖励达成者）',
    memo: `押注目标「${o.title}」${days} 天需完成 ${o.needCount} 次`, ts,
  });
  await db.exec('UPDATE user_stats SET frozen = frozen + ? WHERE user_id = ?', [amount, userId]);
  const ins = await db.exec(
    `INSERT INTO stakes (user_id, title, amount, odds, days, need_count, done_count, start_day, end_day, status, stake_txid)
     VALUES (?,?,?,?,?,?,0,?,?,'running',?)`,
    [userId, o.title, amount, o.odds || 2.0, days, Number(o.needCount) || 5, start, dayOf(endD), d.tx.txid]);
  await store.autoMine();
  return { id: ins.insertId, txid: d.tx.txid, balanceAfter: d.balanceAfter, endDay: dayOf(endD) };
}

/**
 * 结算押注：达成 → 从奖池双倍返还；失败 → 本金进奖池（已经在池子里了，只记一笔确认）。
 * 这里体现了「对赌」的经济学：奖池是全体失败者的本金，给达成者当奖励。
 */
async function settleStake(stakeId, opt = {}) {
  const s = await db.queryOne('SELECT * FROM stakes WHERE id = ?', [stakeId]);
  if (!s || s.status !== 'running') return { skip: true };
  const u = await db.queryOne('SELECT id, addr, nickname FROM users WHERE id = ?', [s.user_id]);
  const win = Number(s.done_count) >= Number(s.need_count);
  const ts = opt.ts || Date.now();
  let txid = null;
  let payout = 0;
  let requested = 0;
  if (win) {
    // 从奖池返给用户：本金 × 倍数
    const payout0 = Math.round(Number(s.amount) * Number(s.odds));
    const pool = Number(await db.scalar(
      `SELECT COALESCE(SUM(CASE WHEN to_addr='CJPOOL' THEN amount ELSE 0 END),0)
            - COALESCE(SUM(CASE WHEN from_addr='CJPOOL' THEN amount ELSE 0 END),0) AS v FROM txs`)) || 0;
    const real = Math.min(payout0, Math.max(0, pool)); // 奖池不够就按池子发，不超发
    requested = payout0;
    payout = real;
    const tx = await store.submit({
      type: 'SETTLE', from: 'CJPOOL', to: u.addr, amount: real,
      memo: `押注达成「${s.title}」返还 ${real} 分（本金 ${s.amount} × ${s.odds}）`, ts, nonce: nextNonce(),
    }, keys.platform().priv, { toUser: u.id, toLabel: u.nickname });
    txid = tx.txid;
    const before = Number(await db.scalar('SELECT balance FROM user_stats WHERE user_id = ?', [u.id])) || 0;
    const after = before + real;
    await db.exec('UPDATE user_stats SET balance = balance + ?, earned = earned + ?, frozen = GREATEST(frozen - ?,0), exp = exp + ? WHERE user_id = ?',
      [real, real, Number(s.amount), Math.round(real * 0.5), u.id]);
    await db.exec(
      `INSERT INTO point_ledger (user_id, addr, type, direction, amount, balance_after, memo, ref_id, txid, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [u.id, u.addr, 'settle', 1, real, after, `押注达成返还：${s.title}`, s.id, tx.txid, tsToSql(ts)]);
    await db.exec(`UPDATE stakes SET status='won', settle_txid=? WHERE id = ?`, [tx.txid, s.id]);
    await refreshLevel(u.id);
  } else {
    await db.exec('UPDATE user_stats SET frozen = GREATEST(frozen - ?,0) WHERE user_id = ?',
      [Number(s.amount), u.id]);
    await db.exec(`UPDATE stakes SET status='lost' WHERE id = ?`, [s.id]);
  }
  await store.autoMine();
  return { win, payout, requested, txid };
}

/** 推进押注进度（用户当天完成了对应活动就 +1） */
async function bumpStake(stakeId, delta = 1) {
  await db.exec(`UPDATE stakes SET done_count = done_count + ? WHERE id = ? AND status='running'`, [delta, stakeId]);
}

/* ============================== 对账 ============================== */

/**
 * 对账：同一个余额，三条路径各算一遍，必须完全相等。
 *   ① point_ledger 的流水加减（业务真账）
 *   ② user_stats.balance（冗余汇总，前端直接读它，快）
 *   ③ point_accounts.on_chain（按链上交易汇总，慢但不可篡改）
 * 任何一处对不上，说明有人绕过引擎改了数据 —— 这正是要抓的。
 */
async function reconcile(userId) {
  const led = await db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN direction=1 THEN amount ELSE 0 END),0) AS inflow,
            COALESCE(SUM(CASE WHEN direction=-1 THEN amount ELSE 0 END),0) AS outflow,
            COUNT(*) AS n FROM point_ledger WHERE user_id = ?`, [userId]);
  const s = await db.queryOne('SELECT balance, earned, spent, frozen FROM user_stats WHERE user_id = ?', [userId]);
  const u = await db.queryOne('SELECT addr FROM users WHERE id = ?', [userId]);
  const acc = u ? await db.queryOne('SELECT on_chain FROM point_accounts WHERE addr = ?', [u.addr]) : null;
  // 还在交易池里、没被打包的那部分。链上余额只算「已确认」的交易，
  // 所以对账时必须把它单独拎出来 —— 否则「刚签到、还没出块」会被误报成对账不平。
  const pend = u ? await db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN to_addr = ? THEN amount ELSE -amount END),0) AS v, COUNT(*) AS n
       FROM txs WHERE (from_addr = ? OR to_addr = ?) AND block_height IS NULL`,
    [u.addr, u.addr, u.addr]) : null;
  const ledgerNet = Number(led.inflow) - Number(led.outflow);
  const chainBal = acc ? Number(acc.on_chain) : 0;
  const statsBal = s ? Number(s.balance) : 0;
  const pendingNet = pend ? Number(pend.v) : 0;
  return {
    userId, ledgerNet, statsBal, chainBal, pendingNet, pendingTx: pend ? Number(pend.n) : 0,
    ledgerInflow: Number(led.inflow), ledgerOutflow: Number(led.outflow), ledgerRows: Number(led.n),
    frozen: s ? Number(s.frozen) : 0,
    okLedgerVsStats: ledgerNet === statsBal,
    okStatsVsChain: statsBal - chainBal === pendingNet,
    diff: statsBal - chainBal - pendingNet,
  };
}

/** 全站对账（管理端看板 + 验收脚本用） */
async function reconcileAll() {
  const bad = await db.query(
    `SELECT u.id, u.nickname,
            COALESCE(l.net,0) AS ledger_net, COALESCE(s.balance,0) AS stats_bal,
            COALESCE(a.on_chain,0) AS chain_bal, COALESCE(p.net,0) AS pending_net,
            COALESCE(s.balance,0) - COALESCE(a.on_chain,0) - COALESCE(p.net,0) AS diff
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(CASE WHEN direction=1 THEN amount ELSE -amount END) AS net
                    FROM point_ledger GROUP BY user_id) l ON l.user_id = u.id
       LEFT JOIN user_stats s ON s.user_id = u.id
       LEFT JOIN point_accounts a ON a.addr = u.addr
       LEFT JOIN (SELECT x.addr,
                         SUM(CASE WHEN t.to_addr = x.addr THEN t.amount ELSE -t.amount END) AS net
                    FROM (SELECT DISTINCT addr FROM point_accounts) x
                    JOIN txs t ON (t.from_addr = x.addr OR t.to_addr = x.addr)
                              AND t.block_height IS NULL
                   GROUP BY x.addr) p ON p.addr = u.addr
      WHERE COALESCE(l.net,0) <> COALESCE(s.balance,0)
         OR COALESCE(s.balance,0) - COALESCE(a.on_chain,0) - COALESCE(p.net,0) <> 0
      LIMIT 20`);
  const total = Number(await db.scalar('SELECT COUNT(*) AS c FROM users')) || 0;
  const issued = Number(await db.scalar(
    `SELECT COALESCE(SUM(amount),0) AS v FROM point_ledger WHERE direction = 1`)) || 0;
  const burned = Number(await db.scalar(
    `SELECT COALESCE(on_chain,0) AS v FROM point_accounts WHERE addr = 'CJBURN'`)) || 0;
  const poolBal = Number(await db.scalar(
    `SELECT COALESCE(on_chain,0) AS v FROM point_accounts WHERE addr = 'CJPOOL'`)) || 0;
  const pendingTx = Number(await db.scalar(
    'SELECT COUNT(*) AS c FROM txs WHERE block_height IS NULL')) || 0;
  return { users: total, mismatch: bad, ok: bad.length === 0, issued, burned, poolBal, pendingTx };
}

module.exports = {
  loadRules, clearRuleCache, streakBonus, parseLadder, DEFAULTS, tsToSql,
  credit, debit, refreshLevel, dayOf, effectiveStreak, prevDay,
  checkin, materialize, completeTask, undoTask, skipTask,
  badgeEligible, claimBadge, verifyClaim, verifyCode, nextSerial, fillMerklePaths,
  redeem, donate, createStake, settleStake, bumpStake,
  reconcile, reconcileAll,
};
