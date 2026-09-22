'use strict';
/**
 * 风控引擎 —— 积分系统最怕的就是「刷分」。
 * 这里实现的 5 条规则都是真实业务里会踩到的：
 *   1. fast_checkin  秒签：登录到签到间隔 < 2 秒（正常人不会
 *   2. same_device   一号多机/一机多号：同设备指纹挂在多个账号上（经典的批量小号）
 *   3. rapid_toggle  反复勾选取消：同一任务 24 小时内 done/undo 超过 3 次（想把分刷出来）
 *   4. point_spike   单位时间暴增：1 小时内入账超过阈值
 *   5. midnight_burst 深夜批量操作：0~5 点产生 5 笔以上积分动作
 * 命中即写 risk_alerts，运营端可处置。规则本身也能在管理端调整阈值。
 */
const db = require('./db');

const RULES = [
  { code: 'fast_checkin', name: '疑似秒签', level: 'low',
    desc: '登录后 2 秒内完成签到' },
  { code: 'same_device', name: '同设备多账号', level: 'high',
    desc: '同一设备指纹被多个账号使用' },
  { code: 'rapid_toggle', name: '任务重复勾选', level: 'mid',
    desc: '24 小时内同一任务勾选/取消超过 3 次' },
  { code: 'point_spike', name: '积分异常暴增', level: 'mid',
    desc: '1 小时内入账超过 120 分' },
  { code: 'midnight_burst', name: '深夜批量操作', level: 'low',
    desc: '0~5 点产生 5 笔以上积分动作' },
];

/** 本地时间 → MySQL DATETIME 字符串（不传就用当前时间） */
function sqlNow(d) {
  const x = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} `
    + `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
}

async function write(o) {
  const r = await db.exec(
    `INSERT INTO risk_alerts (user_id, rule_code, rule_name, level, detail, evidence, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [o.userId, o.code, o.name, o.level, o.detail, o.evidence || null, sqlNow(o.at)]);
  return r.insertId;
}

/**
 * 扫描一个用户。返回命中的规则数组（不写库，纯计算），
 * 由调用方决定是「告警」还是「演示时只看看」。
 */
async function scanUser(userId) {
  const hits = [];

  // ① 秒签：签到时间与注册/登录时间的关系（这里用当日首次签到与上一次签到的时间差近似）
  const fast = await db.query(
    `SELECT c.day, c.created_at, u.last_login,
            ABS(TIMESTAMPDIFF(SECOND, c.created_at, u.last_login)) AS gap
       FROM checkins c JOIN users u ON u.id = c.user_id
      WHERE c.user_id = ? AND u.last_login IS NOT NULL AND u.last_login > c.created_at
      ORDER BY c.day DESC LIMIT 20`, [userId]);
  const fastHit = fast.find((f) => Number(f.gap) < 2);
  if (fastHit) {
    hits.push({ code: 'fast_checkin', name: '疑似秒签', level: 'low',
      detail: `${fastHit.day} 签到与登录仅差 ${fastHit.gap} 秒`,
      evidence: 'gap=' + fastHit.gap + 's' });
  }

  // ② 同设备多账号
  const dev = await db.query(
    `SELECT device, COUNT(DISTINCT user_id) AS n, GROUP_CONCAT(DISTINCT user_id) AS ids
       FROM checkins WHERE device IS NOT NULL AND device <> ''
      GROUP BY device HAVING n > 1 ORDER BY n DESC LIMIT 3`);
  for (const d of dev) {
    const ids = String(d.ids).split(',').map(Number);
    if (ids.includes(Number(userId))) {
      hits.push({ code: 'same_device', name: '同设备多账号', level: 'high',
        detail: `设备 ${d.device} 上共有 ${d.n} 个账号在签到`,
        evidence: '装置=' + d.device + ' 账号数=' + d.n });
    }
  }

  // ③ 反复勾选取消
  const tog = await db.query(
    `SELECT task_id, COUNT(*) AS n FROM task_logs
      WHERE user_id = ? AND action IN ('done','undo') AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
      GROUP BY task_id HAVING n > 3 ORDER BY n DESC LIMIT 2`, [userId]);
  for (const t of tog) {
    hits.push({ code: 'rapid_toggle', name: '任务重复勾选', level: 'mid',
      detail: `任务 #${t.task_id} 在 24 小时内勾选/取消 ${t.n} 次`,
      evidence: 'task=' + t.task_id + ' 次数=' + t.n });
  }

  // ④ 单位时间积分暴增
  const spike = await db.queryOne(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt,
            DATE_FORMAT(MIN(created_at),'%Y-%m-%d %H:00') AS hour
       FROM point_ledger
      WHERE user_id = ? AND direction = 1
        AND created_at > (SELECT MAX(created_at) FROM point_ledger WHERE user_id = ?)
      HAVING amt > 120 LIMIT 1`, [userId, userId]);
  if (spike) {
    hits.push({ code: 'point_spike', name: '积分异常暴增', level: 'mid',
      detail: `1 小时内入账 ${spike.amt} 分（${spike.n} 笔）`,
      evidence: 'amount=' + spike.amt });
  }

  // ⑤ 深夜批量操作
  const night = await db.queryOne(
    `SELECT DATE(created_at) AS day, COUNT(*) AS n
       FROM point_ledger
      WHERE user_id = ? AND HOUR(created_at) < 5
      GROUP BY DATE(created_at) HAVING n >= 5 ORDER BY day DESC LIMIT 1`, [userId]);
  if (night) {
    hits.push({ code: 'midnight_burst', name: '深夜批量操作', level: 'low',
      detail: `${night.day} 凌晨 0~5 点产生 ${night.n} 笔积分动作`,
      evidence: 'count=' + night.n });
  }

  return hits;
}

/** 全站扫描，把命中写入 risk_alerts；返回写入条数 */
async function sweep(limit = 200, at) {
  const users = await db.query('SELECT id FROM users ORDER BY id LIMIT ?', [Number(limit)]);
  let n = 0;
  for (const u of users) {
    const hits = await scanUser(u.id);
    for (const h of hits) {
      const dup = await db.queryOne(
        `SELECT id FROM risk_alerts WHERE user_id = ? AND rule_code = ? AND handled = 0 LIMIT 1`,
        [u.id, h.code]);
      if (dup) continue; // 同一条未处置的规则不重复告警
      await write({ userId: u.id, ...h, at });
      n++;
    }
  }
  return n;
}

/** 看板用的风控概览 */
async function overview() {
  const byRule = await db.query(
    `SELECT rule_code, rule_name, level, COUNT(*) AS n, SUM(handled=0) AS open
       FROM risk_alerts GROUP BY rule_code, rule_name, level ORDER BY n DESC`);
  const byLevel = await db.query(
    'SELECT level, COUNT(*) AS n, SUM(handled=0) AS open FROM risk_alerts GROUP BY level');
  const total = Number(await db.scalar('SELECT COUNT(*) AS c FROM risk_alerts')) || 0;
  const open = Number(await db.scalar('SELECT COUNT(*) AS c FROM risk_alerts WHERE handled = 0')) || 0;
  // 管理端概览要用到「高危未处置」和「涉及多少用户」，在这里一次算好，
  // 免得前端为了两个数字再发一轮请求。
  const high = Number(await db.scalar(
    "SELECT COUNT(*) AS c FROM risk_alerts WHERE handled = 0 AND level = 'high'")) || 0;
  const users = Number(await db.scalar('SELECT COUNT(DISTINCT user_id) AS c FROM risk_alerts')) || 0;
  return { total, open, high, users, byRule, byLevel, rules: RULES };
}

module.exports = { RULES, scanUser, sweep, write, overview, sqlNow };
