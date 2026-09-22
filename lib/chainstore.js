'use strict';
/**
 * 链的持久化层（MySQL 版）。
 * ---------------------------------------------------------------
 * 只干三件事：
 *   ① 把交易丢进交易池（txs.block_height = NULL）
 *   ② 攒够了就打包挖矿，落一个区块，并把块内交易的 block_height 回填
 *   ③ 校验整条链，或给某笔交易出 Merkle 证明
 *
 * 「回填」是个容易漏的坑：区块是后生成的，而流水账（point_ledger、checkins…）
 * 在交易创建时就已经写好了，那时还不知道会被打进第几块。
 * 所以出块后必须回头把这些表里的 block_height 补齐 —— 否则链浏览器上
 * 「这笔积分在第几块」永远查不到，对账也做不完整。
 */
const db = require('./db');
const cfg = require('./config');
const chain = require('./chain');
const keys = require('./keys');

// 运行时难度：默认取配置，运维端可以现场调，用来演示「难度一变，出块速度立刻变」
let runtimeDifficulty = cfg.chain.difficulty;
function getDifficulty() { return runtimeDifficulty; }
function setDifficulty(d) { runtimeDifficulty = Math.max(1, Math.min(6, Number(d) || runtimeDifficulty)); return runtimeDifficulty; }

/**
 * 批量模式：灌历史数据时打开。
 * 打开后出块不再逐个区块重算账户余额（那会对 txs 做上万次聚合扫描），
 * 由调用方在最后统一调 recomputeAccounts() —— 实测能把灌数据时间压掉一大半。
 */
let bulkMode = false;
function setBulkMode(v) { bulkMode = !!v; return bulkMode; }
function isBulk() { return bulkMode; }

/** 出块后需要回填 block_height 的表（凡是存了 txid 的都要补） */
const BACKFILL = [
  ['point_ledger', 'txid'],
  ['checkins', 'txid'],
  ['tasks', 'txid'],
  ['badge_claims', 'txid'],
  ['redemptions', 'txid'],
  ['donations', 'txid'],
  ['stakes', 'stake_txid'],
  ['stakes', 'settle_txid'],
];

/** 启动时确保创世块在库里；没有就现挖一个 */
async function init() {
  const h = await db.scalar('SELECT COUNT(*) AS c FROM blocks');
  if (Number(h) > 0) return { created: false, height: await latestHeight() };
  const g = chain.genesisBlock(Date.now(), keys.platform().priv);
  await db.exec(
    `INSERT INTO blocks (height, hash, prev_hash, merkle_root, ts, nonce, difficulty, miner, tx_count, mined_ms, size_bytes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [0, g.block.hash, g.block.prevHash, g.block.merkleRoot, g.block.ts, g.block.nonce,
      g.block.difficulty, g.block.miner, g.txs.length, 0, JSON.stringify(g.txs).length]);
  const t = g.txs[0];
  await db.exec(
    `INSERT INTO txs (txid, block_height, type, from_addr, to_addr, amount, memo, nonce, ts, sig, signer_pub, verify_ok, block_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.txid, 0, t.type, t.from, t.to, t.amount, t.memo, t.nonce, t.ts, t.sig, keys.platform().pub, 1, g.block.ts]);
  await ensureAccount('CJMINT', null, '系统铸币账户（积分发行总源头）', 1);
  await db.exec('UPDATE point_accounts SET on_chain = on_chain + 0, tx_count = tx_count + 1, first_seen = NOW(), last_seen = NOW() WHERE addr = ?', ['CJMINT']);
  return { created: true, height: 0 };
}

async function latestHeight() {
  const v = await db.scalar('SELECT MAX(height) AS h FROM blocks');
  return v === null ? -1 : Number(v);
}

async function latestBlock() {
  return db.queryOne('SELECT * FROM blocks ORDER BY height DESC LIMIT 1');
}

async function ensureAccount(addr, userId, label, isSystem) {
  await db.exec(
    `INSERT INTO point_accounts (addr, user_id, label, is_system, first_seen)
     VALUES (?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
    [addr, userId || null, label, isSystem ? 1 : 0]);
}

/* ------------------------------ 交易池 ------------------------------ */

/**
 * 造一笔已签名的交易并丢进交易池。
 * @param {{type,from,to,amount,memo,ts,nonce}} t
 * @param {string} priv  签名私钥（系统交易传平台私钥，用户交易传用户私钥）
 * @param {{fromLabel,toLabel,fromUser,toUser}} labels 账户名，用于首次建账户
 */
async function submit(t, priv, labels = {}) {
  const tx = chain.sealTx(chain.makeTx(t), priv);
  // 签名当场验一遍：如果私钥和地址对不上，这里立刻炸，而不是等到全链校验时才发现
  const pub = chain.pubFromPriv(priv);
  const expect = keys.expectedPubFor(tx.from);
  if (expect && expect !== pub) {
    throw new Error(`签名密钥与付款地址不匹配：${tx.from}`);
  }
  const check = chain.checkTx(tx, pub);
  if (!check.ok) throw new Error('交易不合法：' + check.reason);

  if (labels.fromUser || labels.fromLabel) {
    await ensureAccount(tx.from, labels.fromUser, labels.fromLabel || tx.from, keys.isSystem(tx.from));
  }
  if (labels.toUser || labels.toLabel) {
    await ensureAccount(tx.to, labels.toUser, labels.toLabel || tx.to, keys.isSystem(tx.to));
  }

  await db.exec(
    `INSERT INTO txs (txid, block_height, type, from_addr, to_addr, amount, memo, nonce, ts, sig, signer_pub, verify_ok)
     VALUES (?,NULL,?,?,?,?,?,?,?,?,?,1)`,
    [tx.txid, tx.type, tx.from, tx.to, tx.amount, tx.memo || '', tx.nonce, tx.ts, tx.sig, pub]);
  return tx;
}

/** 交易池里待打包的笔数 */
async function poolSize() {
  return Number(await db.scalar('SELECT COUNT(*) AS c FROM txs WHERE block_height IS NULL')) || 0;
}

/** 交易池里最老那笔的时间戳（定时出块的超时兜底用） */
async function oldestPendingTs() {
  const v = await db.scalar('SELECT MIN(ts) AS t FROM txs WHERE block_height IS NULL');
  return v === null ? null : Number(v);
}

/* ------------------------------ 打包出块 ------------------------------ */

/**
 * 出块。
 * @param {object} opt
 *   force      true = 不管池子够不够都出（定时器用）
 *   ts         指定出块时间戳（灌历史数据时用来还原真实时间线）
 *   difficulty 指定难度，默认用运行时难度
 *   maxTx      单块最多打包多少笔
 * @returns 区块对象，或 null（池子空且非强制）
 */
async function mineBlock(opt = {}) {
  const pending = await db.query(
    'SELECT * FROM txs WHERE block_height IS NULL ORDER BY ts ASC, txid ASC LIMIT ?',
    [opt.maxTx || cfg.chain.maxTxPerBlock]);
  if (!pending.length) return null;

  const prev = await latestBlock();
  const height = prev ? Number(prev.height) + 1 : 0;
  const ts = opt.ts || Math.max(Date.now(), ...pending.map((t) => Number(t.ts)), Number(prev ? prev.ts : 0) + 1);
  const difficulty = opt.difficulty || runtimeDifficulty;
  const root = chain.merkleRoot(pending.map((t) => t.txid));

  const t0 = Date.now();
  const mined = chain.mine({
    height, prevHash: prev ? prev.hash : chain.GENESIS_PREV, merkleRoot: root,
    ts, miner: 'CJMINT', txCount: pending.length,
  }, difficulty);
  const cost = Date.now() - t0;

  await db.exec(
    `INSERT INTO blocks (height, hash, prev_hash, merkle_root, ts, nonce, difficulty, miner, tx_count, mined_ms, size_bytes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [height, mined.hash, mined.prevHash, mined.merkleRoot, ts, mined.nonce, difficulty,
      'CJMINT', pending.length, cost, JSON.stringify(pending).length]);

  const ids = pending.map((t) => t.txid);
  await db.query(
    `UPDATE txs SET block_height = ?, block_ts = ? WHERE txid IN (${ids.map(() => '?').join(',')})`,
    [height, Date.now(), ...ids]);

  // 回填业务表的 block_height —— 不做这一步，链浏览器上「这笔积分属于哪一块」就是空白
  for (const [table, col] of BACKFILL) {
    try {
      await db.query(
        `UPDATE ${table} SET block_height = ? WHERE ${col} IN (${ids.map(() => '?').join(',')}) AND block_height IS NULL`,
        [height, ...ids]);
    } catch (e) { /* 该表不存在该列等，忽略 */ }
  }

  // 链上账户余额与交易笔数（系统账户也在内）。
  // 灌历史数据时可以传 skipRecompute 跳过，最后用 recomputeAccounts() 一次性算完 ——
  // 逐个区块重算会对 txs 做上万次聚合扫描，实测能把灌数据从 4 分钟拖到 20 分钟。
  if (!opt.skipRecompute) await recomputeAccounts([...new Set(pending.flatMap((t) => [t.from_addr, t.to_addr]))]);

  return { ...mined, mined_ms: cost, pending: pending.length };
}

/** 按链上交易重算账户余额（不传 addrs 就全量） */
async function recomputeAccounts(addrs) {
  const list = addrs && addrs.length ? addrs
    : (await db.query('SELECT addr FROM point_accounts')).map((r) => r.addr);
  for (const addr of list) {
    const on = Number(await db.scalar(
      `SELECT COALESCE(SUM(CASE WHEN to_addr = ? THEN amount ELSE 0 END),0)
            - COALESCE(SUM(CASE WHEN from_addr = ? THEN amount ELSE 0 END),0) AS v
       FROM txs WHERE (from_addr = ? OR to_addr = ?) AND block_height IS NOT NULL`,
      [addr, addr, addr, addr])) || 0;
    const cnt = Number(await db.scalar(
      'SELECT COUNT(*) AS c FROM txs WHERE (from_addr = ? OR to_addr = ?) AND block_height IS NOT NULL',
      [addr, addr])) || 0;
    await db.exec(
      `UPDATE point_accounts SET on_chain = ?, tx_count = ?, last_seen = NOW(),
         first_seen = COALESCE(first_seen, NOW()) WHERE addr = ?`, [on, cnt, addr]);
  }
  return list.length;
}

/** 池子够了就自动出块（每次业务动作后调用一次，攒批而非一交易一块） */
async function autoMine(force = false) {
  const n = await poolSize();
  if (!force && n < cfg.chain.maxTxPerBlock) return null;
  return mineBlock({ skipRecompute: bulkMode });
}

/* ------------------------------ 查询 ------------------------------ */

async function blocks(limit = 20, offset = 0) {
  return db.query('SELECT * FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?', [Number(limit), Number(offset)]);
}

async function block(height) {
  const b = await db.queryOne('SELECT * FROM blocks WHERE height = ?', [Number(height)]);
  if (!b) return null;
  const txs = await db.query(
    `SELECT * FROM txs WHERE block_height = ? ${TX_ORDER}`, [Number(height)]);
  return { ...b, txs };
}

async function tx(txid) {
  const t = await db.queryOne('SELECT * FROM txs WHERE txid = ?', [txid]);
  if (!t) return null;
  let proof = null;
  if (t.block_height !== null) proof = await merkleProofOf(txid);
  return { ...t, proof };
}

async function pool(limit = 50) {
  return db.query('SELECT * FROM txs WHERE block_height IS NULL ORDER BY ts DESC LIMIT ?', [Number(limit)]);
}

async function addrTxs(addr, limit = 50) {
  return db.query(
    `SELECT * FROM txs WHERE from_addr = ? OR to_addr = ? ORDER BY ts DESC, block_height DESC LIMIT ?`,
    [addr, addr, Number(limit)]);
}

async function addrSummary(addr) {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) AS tx_count,
       COALESCE(SUM(CASE WHEN to_addr=? THEN amount ELSE 0 END),0) AS inflow,
       COALESCE(SUM(CASE WHEN from_addr=? THEN amount ELSE 0 END),0) AS outflow,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
     FROM txs WHERE (from_addr = ? OR to_addr = ?) AND block_height IS NOT NULL`,
    [addr, addr, addr, addr]);
  const acc = await db.queryOne('SELECT * FROM point_accounts WHERE addr = ?', [addr]);
  const byType = await db.query(
    `SELECT type, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM txs
      WHERE (from_addr = ? OR to_addr = ?) GROUP BY type ORDER BY n DESC`, [addr, addr]);
  return { ...row, balance: acc ? Number(acc.on_chain) : 0,
    label: acc ? acc.label : '', isSystem: acc ? !!acc.is_system : false, byType };
}

/** 给某笔交易出 Merkle 证明（轻节点验真用） */
async function merkleProofOf(txid) {
  const t = await db.queryOne('SELECT block_height FROM txs WHERE txid = ?', [txid]);
  if (!t || t.block_height === null) return null;
  const list = await db.query('SELECT txid FROM txs WHERE block_height = ? ORDER BY ts ASC, txid ASC',
    [t.block_height]);
  const ids = list.map((x) => x.txid);
  const idx = ids.indexOf(txid);
  if (idx < 0) return null;
  const p = chain.merkleProof(ids, idx);
  return { index: idx, total: ids.length, path: p.path, root: p.root, leaf: txid };
}

/** 全链校验：把「库里的链」全部读出来重新算一遍 */
/**
 * 全链校验。
 * ⚠️ 块内交易的顺序必须和出块时**逐字一致**，否则重算出来的 Merkle 根对不上，
 * 会误报成「Merkle 根不匹配」——那看起来像链被篡改了，其实只是排序不一致。
 * 出块用的排序是 `ts ASC, txid ASC`（txid 做同秒兜底），这里必须跟着用同一套。
 */
const TX_ORDER = 'ORDER BY ts ASC, txid ASC';

async function validate() {
  const all = await db.query('SELECT * FROM blocks ORDER BY height ASC');
  const allTx = await db.query(`SELECT * FROM txs WHERE block_height IS NOT NULL ${TX_ORDER}`);
  const byHeight = new Map();
  for (const t of allTx) {
    if (t.block_height === null) continue;
    const h = Number(t.block_height);
    if (!byHeight.has(h)) byHeight.set(h, []);
    byHeight.get(h).push(t);
  }
  const userPubMap = {};
  for (const u of await db.query('SELECT addr, pub_key FROM users')) userPubMap[u.addr] = u.pub_key;
  const norm = (t) => ({ type: t.type, from: t.from_addr, to: t.to_addr, amount: Number(t.amount),
    memo: t.memo || '', ts: Number(t.ts), nonce: Number(t.nonce), txid: t.txid, sig: t.sig });
  const blocksNorm = all.map((b) => ({ height: Number(b.height), hash: b.hash, prevHash: b.prev_hash,
    merkleRoot: b.merkle_root, ts: Number(b.ts), nonce: Number(b.nonce),
    difficulty: Number(b.difficulty), miner: b.miner, txCount: Number(b.tx_count) }));
  const r = chain.validateChain(blocksNorm,
    (h) => (byHeight.get(h) || []).map(norm), keys.pubOfFactory(userPubMap));
  const pending = Number(await db.scalar('SELECT COUNT(*) AS c FROM txs WHERE block_height IS NULL')) || 0;
  return { ...r, blocks: blocksNorm.length, txs: allTx.length + pending, pending };
}

/** 链总览（看板用） */
async function stats() {
  const row = await db.queryOne(
    `SELECT (SELECT COUNT(*) FROM blocks) AS block_count,
            (SELECT MAX(height) FROM blocks) AS height,
            (SELECT COUNT(*) FROM txs) AS tx_count,
            (SELECT COUNT(*) FROM txs WHERE block_height IS NULL) AS pending,
            (SELECT COALESCE(SUM(amount),0) FROM txs WHERE block_height IS NOT NULL) AS total_amount,
            (SELECT ROUND(AVG(mined_ms),0) FROM blocks WHERE height > 0) AS avg_mined_ms,
            (SELECT MAX(ts) FROM blocks) AS last_ts,
            (SELECT difficulty FROM blocks ORDER BY height DESC LIMIT 1) AS difficulty`);
  const byType = await db.query(
    'SELECT type, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM txs GROUP BY type ORDER BY n DESC');
  // 出块间隔原本想用窗口函数 LAG() OVER 一把算出来，但那是 MySQL 8+ 才有的语法，
  // 本项目的运行环境是 5.7，所以取回最近 20 块后在 JS 里算。
  const recentRaw = await db.query(
    'SELECT height, ts, difficulty, tx_count, mined_ms FROM blocks ORDER BY height DESC LIMIT 20');
  const recent = recentRaw.map((b, i) => {
    const prev = recentRaw[i + 1]; // DESC 排列，下一个就是上一块（更早的）
    return { ...b,
      gap_s: prev ? Number(((Number(b.ts) - Number(prev.ts)) / 1000).toFixed(1)) : null };
  });
  return { ...row, byType, recent, runtimeDifficulty };
}

/** 难度建议：只看最近 20 块的实测间隔（纯建议，不自动改，运维端可一键采用） */
async function suggestDifficulty() {
  const rows = await db.query('SELECT height, ts, difficulty FROM blocks ORDER BY height DESC LIMIT 21');
  const asc = rows.reverse();
  const r = chain.nextDifficulty(asc, cfg.chain.targetMs, 20);
  return { suggest: r, current: runtimeDifficulty, targetMs: cfg.chain.targetMs };
}

module.exports = {
  init, submit, poolSize, oldestPendingTs, mineBlock, autoMine, recomputeAccounts, setBulkMode, isBulk,
  blocks, block, tx, pool, addrTxs, addrSummary, merkleProofOf,
  validate, stats, suggestDifficulty, latestBlock, latestHeight,
  getDifficulty, setDifficulty, ensureAccount,
};
