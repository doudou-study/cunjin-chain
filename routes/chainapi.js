'use strict';
/**
 * 链浏览器 API（公开，不需要登录）
 * ==========================================================================
 * 这个路由承载了项目的「技术看点」：
 *   · 区块 / 交易 / 地址 三个视角的浏览器
 *   · Merkle 证明下发（前端用 WebCrypto 自己算一遍，做真正的轻节点校验）
 *   · 全链校验：一键验证哈希链、Merkle 根、PoW、签名
 *   · 篡改实验室：把「改数据库里的账」这件事当场演示出来，看链怎么抓住它
 *
 * 篡改实验室默认**只在内存里改一份副本**，不碰数据库 —— 演示完数据还是好的。
 * 如果勾了 apply，会先备份原行到 data/tamper-backup.json，随时可一键还原。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const store = require('../lib/chainstore');
const auth = require('../lib/auth');
const chain = require('../lib/chain');

const router = express.Router();
const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, msg });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[chain]', req.method, req.originalUrl, e.message);
  bad(res, e.message || '服务器错误', 500);
});
const page = (q) => {
  const p = Math.max(1, Number(q.page) || 1);
  const size = Math.min(100, Math.max(1, Number(q.size) || 20));
  return { p, size, offset: (p - 1) * size };
};

const BACKUP = path.join(__dirname, '..', 'data', 'tamper-backup.json');

/* ============================ 概览 ============================ */

router.get('/stats', wrap(async (req, res) => {
  const s = await store.stats();
  const rec = await db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN direction=1 THEN amount ELSE 0 END),0) AS issued,
            COALESCE(SUM(CASE WHEN direction=-1 THEN amount ELSE 0 END),0) AS spent,
            COUNT(*) AS rows_cnt FROM point_ledger`);
  const systems = await db.query(
    'SELECT * FROM point_accounts WHERE is_system = 1 OR user_id IS NULL ORDER BY addr');
  const types = await db.query(
    `SELECT type, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM txs GROUP BY type ORDER BY n DESC`);
  ok(res, { ...s, ledger: rec, systems, types,
    typeCN: chain.TYPE_CN, hasBackup: fs.existsSync(BACKUP) });
}));

/* ============================ 区块 ============================ */

router.get('/blocks', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const total = Number(await db.scalar('SELECT COUNT(*) AS c FROM blocks'));
  const list = await store.blocks(size, offset);
  ok(res, { list: list.map((b) => ({ ...b,
    age_s: Math.round((Date.now() - Number(b.ts)) / 1000) })), total, page: p, size });
}));

router.get('/block/:height', wrap(async (req, res) => {
  const b = await store.block(Number(req.params.height));
  if (!b) return bad(res, '区块不存在', 404);
  const txs = b.txs.map((t) => {
    // 给每一笔交易算出它在块内的 Merkle 证明，前端可以逐笔验证
    const p = chain.merkleProof(b.txs.map((x) => x.txid), b.txs.findIndex((x) => x.txid === t.txid));
    return { ...t, typeCN: chain.TYPE_CN[t.type] || t.type, proof: p };
  });
  const back = b.height > 0
    ? await db.queryOne('SELECT height, hash FROM blocks WHERE height = ?', [b.height - 1]) : null;
  const next = await db.queryOne('SELECT height, hash FROM blocks WHERE height = ?', [b.height + 1]);
  ok(res, { block: { ...b, txs }, prev: back, next,
    computed: {
      hash: chain.blockHash({ height: Number(b.height), prevHash: b.prev_hash, merkleRoot: b.merkle_root,
        ts: Number(b.ts), nonce: Number(b.nonce), difficulty: Number(b.difficulty), miner: b.miner }),
      merkleRoot: chain.merkleRoot(b.txs.map((t) => t.txid)),
      powOk: chain.meetsTarget(b.hash, Number(b.difficulty)),
      headSelfOk: chain.blockHash({ height: Number(b.height), prevHash: b.prev_hash,
        merkleRoot: b.merkle_root, ts: Number(b.ts), nonce: Number(b.nonce),
        difficulty: Number(b.difficulty), miner: b.miner }) === b.hash,
    } });
}));

/* ============================ 交易 ============================ */

router.get('/txs', wrap(async (req, res) => {
  const { p, size, offset } = page(req.query);
  const where = []; const args = [];
  if (req.query.type) { where.push('type = ?'); args.push(req.query.type); }
  if (req.query.q) {
    where.push('(txid LIKE ? OR from_addr LIKE ? OR to_addr LIKE ? OR memo LIKE ?)');
    const like = '%' + req.query.q + '%';
    args.push(like, like, like, like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(await db.scalar(`SELECT COUNT(*) AS c FROM txs ${w}`, args));
  const list = await db.query(
    `SELECT t.*, b.ts AS block_time FROM txs t LEFT JOIN blocks b ON b.height = t.block_height
      ${w} ORDER BY COALESCE(t.block_height, 999999999) DESC, t.ts DESC LIMIT ? OFFSET ?`,
    [...args, size, offset]);
  ok(res, { list: list.map((t) => ({ ...t, typeCN: chain.TYPE_CN[t.type] || t.type })), total, page: p, size });
}));

router.get('/tx/:txid', wrap(async (req, res) => {
  const t = await store.tx(req.params.txid);
  if (!t) return bad(res, '交易不存在', 404);
  const pub = t.signer_pub;
  const check = chain.checkTx({ type: t.type, from: t.from_addr, to: t.to_addr, amount: Number(t.amount),
    memo: t.memo || '', ts: Number(t.ts), nonce: Number(t.nonce), txid: t.txid, sig: t.sig }, pub);
  const recomputed = chain.txId({ type: t.type, from: t.from_addr, to: t.to_addr, amount: Number(t.amount),
    memo: t.memo || '', ts: Number(t.ts), nonce: Number(t.nonce) });
  ok(res, { tx: { ...t, typeCN: chain.TYPE_CN[t.type] || t.type },
    verify: { signatureOk: check.ok, reason: check.reason,
      txidSelfOk: recomputed === t.txid, recomputed } });
}));

/* ============================ 交易池 ============================ */

router.get('/pool', wrap(async (req, res) => {
  const list = await store.pool(60);
  const cfg = require('../lib/config');
  ok(res, { list: list.map((t) => ({ ...t, typeCN: chain.TYPE_CN[t.type] || t.type })),
    maxTxPerBlock: cfg.chain.maxTxPerBlock, intervalMs: cfg.chain.blockIntervalMs,
    difficulty: store.getDifficulty() });
}));

/* ============================ 地址 ============================ */

router.get('/address/:addr', wrap(async (req, res) => {
  const addr = req.params.addr;
  const sum = await store.addrSummary(addr);
  const txs = await store.addrTxs(addr, 60);
  const label = sum.label || null;
  const u = await db.queryOne(
    `SELECT u.nickname, u.city, u.goal, u.created_at, s.level, s.streak, s.checkin_days, s.badge_count
       FROM users u LEFT JOIN user_stats s ON s.user_id = u.id WHERE u.addr = ?`, [addr]);
  const claims = await db.query(
    `SELECT c.serial, c.verify_code, c.txid, c.status, c.claimed_at, b.name AS badge_name, b.icon, b.color, b.level
       FROM badge_claims c JOIN badges b ON b.id = c.badge_id WHERE c.user_id = (SELECT id FROM users WHERE addr = ?)`,
    [addr]);
  ok(res, { addr, summary: sum, label, user: u || null, txs: txs.map((t) => ({ ...t,
    typeCN: chain.TYPE_CN[t.type] || t.type })), claims });
}));

/* ============================ Merkle 证明（轻节点） ============================ */

router.get('/proof/:txid', wrap(async (req, res) => {
  const p = await store.merkleProofOf(req.params.txid);
  if (!p) return bad(res, '这笔交易还没被打包，暂时没有证明', 404);
  // 服务端先自验一遍，前端拿到之后会用自己的实现再算一次（两边独立）
  const verified = chain.verifyMerkleProof(p.leaf, p.path, p.root);
  ok(res, { ...p, serverVerified: verified, algorithm: 'sha256(left+right)，奇数节点复制最后一个' });
}));

/* ============================ 全链校验 ============================ */

router.get('/validate', wrap(async (req, res) => {
  const t0 = Date.now();
  const r = await store.validate();
  ok(res, { ...r, elapsedMs: Date.now() - t0 });
}));

/* ============================ 难度与出块 ============================ */

router.get('/difficulty', wrap(async (req, res) => {
  ok(res, await store.suggestDifficulty());
}));

/* ============================ 篡改实验室 ============================ */

const TAMPERS = [
  { kind: 'block_ts', name: '伪造存证时间', desc: '把某个区块的时间戳改成别的值 —— 想让「这笔记分是什么时候记的」变成另一个时间。',
    target: 'blocks.ts', detect: '区块头哈希不匹配' },
  { kind: 'block_nonce', name: '伪造工作量', desc: '只改 nonce 不重新挖 —— 假装这块是挖出来的。',
    target: 'blocks.nonce', detect: '区块不满足难度目标 / 区块头哈希不匹配' },
  { kind: 'tx_amount', name: '给某笔积分改金额', desc: '把一笔「+5 分」改成「+5000 分」—— 后台偷偷给自己发分。',
    target: 'txs.amount', detect: '交易内容哈希与 txid 对不上' },
  { kind: 'tx_memo', name: '改交易备注', desc: '改写链上备注（比如把「撤销」改成「奖励」）。',
    target: 'txs.memo', detect: '交易内容哈希与 txid 对不上' },
  { kind: 'drop_block', name: '删掉一个区块', desc: '抹掉一段历史，让某几笔积分「从未发生」。',
    target: 'blocks', detect: '高度不连续 / 前哈希对不上' },
  { kind: 'reorder_tx', name: '调换块内交易顺序', desc: '把块内两笔交易换个位置 —— 金额、签名全都没错，只是顺序变了。',
    target: 'txs 顺序', detect: 'Merkle 根变化，与块头记录的对不上（真改库时会先撞上「交易内容哈希与 txid 不符」）' },
];

router.get('/tamper/options', wrap(async (req, res) => {
  const blocks = await db.query('SELECT height, hash, ts FROM blocks ORDER BY height DESC LIMIT 30');
  const txs = await db.query(
    `SELECT txid, block_height, type, amount, memo FROM txs WHERE block_height IS NOT NULL
      ORDER BY block_height DESC LIMIT 30`);
  ok(res, { options: TAMPERS, blocks, txs, hasBackup: fs.existsSync(BACKUP),
    backupInfo: fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')).info : null });
}));

/**
 * 执行篡改。
 * body: { kind, height, txid, value, apply }
 *   apply=false（默认）：只在内存里改一份副本，跑校验给你看结果，数据库毫发无损
 *   apply=true：真改数据库（需要 operator/admin 权限），并备份原行以便还原
 */
router.post('/tamper', wrap(async (req, res) => {
  const { kind, height, txid, value } = req.body || {};
  const apply = !!(req.body && req.body.apply);
  const opt = TAMPERS.find((t) => t.kind === kind);
  if (!opt) return bad(res, '未知的篡改方式');

  let actor = null;
  if (apply) {
    actor = await auth.currentUser(req);
    if (!actor || (actor.role !== 'operator' && actor.role !== 'admin')) {
      return bad(res, '真改数据库需要「运营」或「管理员」权限。不登录也可以选「只在内存里试」。', 403);
    }
  }

  // 先把当前链完整读出来（校验用），再构造一份被篡改的副本
  const before = await store.validate();

  // 备份 & 落库
  let backup = null;
  if (apply) {
    if (kind === 'drop_block') {
      backup = { info: { kind, height: Number(height), at: new Date().toISOString() },
        block: await db.queryOne('SELECT * FROM blocks WHERE height = ?', [Number(height)]),
        txs: await db.query('SELECT txid, block_height FROM txs WHERE block_height = ?', [Number(height)]) };
    } else if (kind === 'block_ts' || kind === 'block_nonce') {
      const col = kind === 'block_ts' ? 'ts' : 'nonce';
      backup = { info: { kind, height: Number(height), at: new Date().toISOString() },
        block: await db.queryOne('SELECT * FROM blocks WHERE height = ?', [Number(height)]) };
      const v = kind === 'block_ts' ? Number(value) : Number(value);
      await db.exec(`UPDATE blocks SET ${col} = ? WHERE height = ?`, [v, Number(height)]);
    } else if (kind === 'tx_amount' || kind === 'tx_memo') {
      const row = await db.queryOne('SELECT * FROM txs WHERE txid = ?', [txid]);
      if (!row) return bad(res, '没找到这笔交易');
      backup = { info: { kind, txid, at: new Date().toISOString() }, tx: row };
      const col = kind === 'tx_amount' ? 'amount' : 'memo';
      await db.exec(`UPDATE txs SET ${col} = ? WHERE txid = ?`,
        [kind === 'tx_amount' ? Number(value) : String(value), txid]);
    } else if (kind === 'reorder_tx') {
      const list = await db.query(
        'SELECT txid, ts FROM txs WHERE block_height = ? ORDER BY ts ASC, txid ASC', [Number(height)]);
      if (list.length < 2) return bad(res, '这个区块交易太少，换一个');
      // 备份必须记下**原始 ts**。只记顺序、还原时另给一个 ts，那些交易的 txid 就永久变了，
      // 链会一直坏着 —— 演示完留下一堆烂数据最坑人。
      backup = { info: { kind, height: Number(height), at: new Date().toISOString() },
        order: list.map((x) => ({ txid: x.txid, ts: Number(x.ts) })) };
      // 用 ts 的微调制造顺序变化（ts 参与块内排序，也决定 Merkle 叶子顺序）
      await db.exec('UPDATE txs SET ts = ts + 1 WHERE txid = ?', [list[0].txid]);
      await db.exec('UPDATE txs SET ts = ts - 1 WHERE txid = ?', [list[1].txid]);
    }
    if (backup) fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
    await db.exec(`INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, ip) VALUES (?,?,?,?,?,?)`,
      [actor.id, actor.role, '链篡改实验', 'blocks', `${opt.name}（${kind}，真改库）`,
        (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '')]);
  }

  // 重新校验：如果没落库，这里仍然是干净的 —— 所以再单独构造一次内存篡改来演示
  const after = await store.validate();
  let memory = null;
  if (!apply) memory = await simulate(kind, { height, txid, value });

  ok(res, {
    kind, name: opt.name, apply,
    before: { ok: before.ok, reason: before.reason },
    after: { ok: after.ok, badHeight: after.badHeight, reason: after.reason },
    memory,
    hint: apply
      ? (after.ok ? '居然没被抓住？这属于异常情况，请把它记下来。' : '看，链当场就把这一块指出来了。点「还原」可以把数据改回去。')
      : '这是内存副本的篡改结果，数据库没有被动过。想看真改库请用「运营/管理员」账号登录后再试。',
  });
}));

/** 内存篡改模拟：只读数据库，构造副本后跑校验，绝不写库 */
async function simulate(kind, { height, txid, value }) {
  const blocks = (await db.query('SELECT * FROM blocks ORDER BY height ASC')).map((b) => ({
    height: Number(b.height), hash: b.hash, prevHash: b.prev_hash, merkleRoot: b.merkle_root,
    ts: Number(b.ts), nonce: Number(b.nonce), difficulty: Number(b.difficulty),
    miner: b.miner, txCount: Number(b.tx_count),
  }));
  // ⚠️ 顺序必须跟出块时一致（ts ASC, txid ASC），否则重算 Merkle 根会「假报警」
  const allTx = await db.query(
    'SELECT * FROM txs WHERE block_height IS NOT NULL ORDER BY ts ASC, txid ASC');
  const norm = (t) => ({ type: t.type, from: t.from_addr, to: t.to_addr, amount: Number(t.amount),
    memo: t.memo || '', ts: Number(t.ts), nonce: Number(t.nonce), txid: t.txid, sig: t.sig });
  const byH = new Map();
  for (const t of allTx) {
    const h = Number(t.block_height);
    if (!byH.has(h)) byH.set(h, []);
    byH.get(h).push(norm(t));
  }
  const userPubMap = {};
  for (const u of await db.query('SELECT addr, pub_key FROM users')) userPubMap[u.addr] = u.pub_key;
  const pubOf = require('../lib/keys').pubOfFactory(userPubMap);

  let target = null;
  if (kind === 'block_ts' || kind === 'block_nonce') {
    const b = blocks.find((x) => x.height === Number(height));
    if (!b) return { error: '区块不存在' };
    if (kind === 'block_ts') {
      const oldTs = b.ts;
      b.ts = Number(value) || (b.ts + 86400000);
      target = { what: '区块 #' + b.height, field: '时间戳',
        from: new Date(oldTs).toLocaleString('zh-CN'), to: new Date(b.ts).toLocaleString('zh-CN') };
    } else {
      const oldNonce = b.nonce;
      b.nonce = Number(value) || (b.nonce + 1);
      target = { what: '区块 #' + b.height, field: 'nonce', from: oldNonce, to: b.nonce };
    }
  } else if (kind === 'tx_amount' || kind === 'tx_memo') {
    for (const list of byH.values()) {
      const t = list.find((x) => x.txid === txid);
      if (t) {
        const old = kind === 'tx_amount' ? t.amount : t.memo;
        if (kind === 'tx_amount') t.amount = Number(value) || t.amount * 1000;
        else t.memo = String(value || '（被改过的备注）');
        target = { what: '交易 ' + txid.slice(0, 16) + '…', field: kind === 'tx_amount' ? '金额' : '备注',
          from: old, to: kind === 'tx_amount' ? t.amount : t.memo };
        break;
      }
    }
    if (!target) return { error: '交易不存在或未打包' };
  } else if (kind === 'drop_block') {
    const i = blocks.findIndex((x) => x.height === Number(height));
    if (i < 0) return { error: '区块不存在' };
    const [gone] = blocks.splice(i, 1);
    byH.delete(Number(height));
    target = { what: '区块 #' + gone.height, field: '整块删除', from: gone.hash.slice(0, 16) + '…', to: '（不存在）' };
  } else if (kind === 'reorder_tx') {
    const list = byH.get(Number(height));
    if (!list || list.length < 2) return { error: '这个区块交易太少' };
    const a = list[0]; list[0] = list[1]; list[1] = a;
    target = { what: '区块 #' + Number(height), field: '块内交易顺序',
      from: 'A→B', to: 'B→A（金额都没变）' };
  }

  const r = chain.validateChain(blocks, (h) => byH.get(h) || [], pubOf);
  return { tampered: target, result: { ok: r.ok, badHeight: r.badHeight, reason: r.reason } };
}

/** 还原：把上次真改的那一行写回去 */
router.post('/tamper/restore', wrap(async (req, res) => {
  if (!fs.existsSync(BACKUP)) return bad(res, '没有需要还原的备份');
  const b = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  const k = b.info.kind;
  if (k === 'block_ts' || k === 'block_nonce') {
    await db.exec('UPDATE blocks SET ts = ?, nonce = ?, hash = ? WHERE height = ?',
      [b.block.ts, b.block.nonce, b.block.hash, b.block.height]);
    await db.exec('UPDATE txs SET block_ts = ? WHERE block_height = ?', [b.block.ts, b.block.height]);
  } else if (k === 'tx_amount' || k === 'tx_memo') {
    await db.exec('UPDATE txs SET amount = ?, memo = ? WHERE txid = ?', [b.tx.amount, b.tx.memo, b.tx.txid]);
  } else if (k === 'drop_block') {
    await db.exec(
      `INSERT INTO blocks (height, hash, prev_hash, merkle_root, ts, nonce, difficulty, miner, tx_count, mined_ms, size_bytes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [b.block.height, b.block.hash, b.block.prev_hash, b.block.merkle_root, b.block.ts, b.block.nonce,
        b.block.difficulty, b.block.miner, b.block.tx_count, b.block.mined_ms, b.block.size_bytes]);
    for (const t of b.txs) {
      await db.exec('UPDATE txs SET block_height = ? WHERE txid = ?', [t.block_height, t.txid]);
    }
  } else if (k === 'reorder_tx') {
    // 按备份里的原始 ts 逐笔写回，序号一个都不能差
    for (const row of b.order) {
      await db.exec('UPDATE txs SET ts = ? WHERE txid = ?', [Number(row.ts), row.txid]);
    }
  }
  fs.unlinkSync(BACKUP);
  const v = await store.validate();
  ok(res, { restored: k, validate: { ok: v.ok, reason: v.reason } });
}));

module.exports = router;
