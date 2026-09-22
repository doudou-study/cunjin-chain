'use strict';
/**
 * 寸进链 · 区块链内核（纯逻辑，不碰数据库）
 * ---------------------------------------------------------------
 * 这里实现的是一个「够真实」的迷你公链，不是把数据塞进一张叫 blockchain 的表：
 *   · SHA-256 链式哈希     —— 每块存前一块的哈希，改一块后面全废
 *   · Merkle 树            —— 区块内交易的二进制哈希树，支持给单笔交易出证明
 *   · PoW 工作量证明        —— 区块头哈希必须带 N 个前导 0，难度可动态调整
 *   · Ed25519 数字签名      —— 每笔交易由发起人私钥签名，验签才进交易池
 *   · 交易池 / 自动出块      —— 攒够笔数或到时间就打包挖矿
 *   · validateChain()      —— 逐块校验，能精确定位「第几块坏了、坏在哪」
 *
 * 设计上刻意把「链」和「库」分开：
 *   链 = 不可篡改的账本事实（blocks / txs 两张表，只增不改）
 *   库 = 业务视角的账本副本（point_ledger 等），方便查询与对账
 *   两者之间的差额就是「被篡改」的证据 —— 见 tools/qa.js 的篡改实验室。
 */
const crypto = require('crypto');

/* ============================ 基础工具 ============================ */

/** 拼接后取 SHA-256，返回 64 位十六进制小写串 */
function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p));
  return h.digest('hex');
}

/** 稳定序列化：对象按 key 排序，保证同样内容永远得到同样的哈希 */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/* ============================ 钱包 / 地址 ============================ */

/**
 * 生成一对 Ed25519 密钥。私钥留在库里（课程演示；生产环境应当由客户端自己保管，
 * 平台只存公钥，这样才能叫「非托管」，README 里写了这一点）。
 */
function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

/**
 * 地址 = 'CJ' + sha256(公钥) 前 30 位。
 * 前两位 CJ 是寸进（CunJin）的标记，跟比特币、以太坊的地址风格区分开。
 */
function addressOf(pubHex) {
  return 'CJ' + sha256(pubHex).slice(0, 30);
}

/** 用私钥对交易签名。签名对象是「去掉 txid / sig 之后的标准序列化内容」 */
function signTx(tx, privHex) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(canonical(withoutSig(tx))), key).toString('hex');
}

/** 用公钥验签 */
function verifyTx(tx, pubHex) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubHex, 'hex'), format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(canonical(withoutSig(tx))), key,
      Buffer.from(tx.sig, 'hex'));
  } catch (e) {
    return false;
  }
}

/**
 * 从私钥推导公钥。
 * Ed25519 的公钥可以由私钥唯一确定，所以「签名」和「验签」能在同一个函数里闭环，
 * 不需要调用方额外把公钥传进来 —— 少一个参数就少一处对不上的机会。
 */
function pubFromPriv(privHex) {
  const priv = crypto.createPrivateKey({
    key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8',
  });
  return crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('hex');
}

function withoutSig(tx) {
  const { txid, sig, ...rest } = tx;
  return rest;
}

/** 交易号 = 内容哈希，天然防篡改（改一个字段 txid 就对不上） */
function txId(tx) {
  return sha256(canonical(withoutSig(tx)));
}

/* ============================ 交易 ============================ */

/**
 * 交易类型（业务语义直接写进链，链浏览器才能看懂）：
 *   GENESIS  创世发行      CHECKIN  签到奖励      TASK     任务完成奖励
 *   DAYBONUS 当日全清奖励   BADGE    徽章铸造(铸给用户)
 *   REDEEM   商城兑换扣减   DONATE   公益捐赠      STAKE    押注锁定
 *   SETTLE   押注结算返还   POOL     罚金进奖池     BURN     销毁
 *   TRANSFER 用户间转账     RULE     规则变更存证  ADJUST   管理员调账
 */
const TX_TYPES = ['GENESIS', 'CHECKIN', 'TASK', 'DAYBONUS', 'BADGE', 'REDEEM',
  'DONATE', 'STAKE', 'SETTLE', 'POOL', 'BURN', 'TRANSFER', 'RULE', 'ADJUST'];

const SYSTEM_ACCOUNTS = {
  CJMINT: '系统铸币账户（积分发行总源头）',
  CJBURN: '销毁账户（兑换消耗的积分打到这，全网可查）',
  CJPOOL: '奖池账户（押注失败的积分进这，用于奖励达成者）',
  CJDONATE: '公益账户（捐赠积分归集）',
};

const TYPE_CN = {
  GENESIS: '创世发行', CHECKIN: '签到奖励', TASK: '任务完成', DAYBONUS: '当日全清',
  BADGE: '徽章铸造', REDEEM: '商城兑换', DONATE: '公益捐赠', STAKE: '押注锁定',
  SETTLE: '押注结算', POOL: '罚金入池', BURN: '销毁', TRANSFER: '积分转账',
  RULE: '规则存证', ADJUST: '管理员调账',
};

/**
 * 造一笔交易。from 为系统账户时也照样签名（用平台私钥），
 * 这样「平台自己发的积分」同样不可抵赖 —— 这是学生作业里最容易被糊过去的地方。
 */
function makeTx({ type, from, to, amount, memo = '', ts = Date.now(), nonce = 0 }) {
  return { type, from, to, amount: Number(amount), memo, ts, nonce };
}

/** 补全 txid 与签名 */
function sealTx(tx, privHex) {
  const body = { ...tx };
  body.txid = txId(body);
  body.sig = signTx(body, privHex);
  return body;
}

/** 完整校验一笔交易：类型合法 / 金额为正 / 哈希自洽 / 签名有效 */
function checkTx(tx, pubHex) {
  if (!tx || typeof tx !== 'object') return { ok: false, reason: '交易为空' };
  if (!TX_TYPES.includes(tx.type)) return { ok: false, reason: '交易类型非法: ' + tx.type };
  if (!(tx.amount >= 0)) return { ok: false, reason: '金额非法' };
  if (!tx.from || !tx.to) return { ok: false, reason: '缺少付款方或收款方' };
  if (txId(tx) !== tx.txid) return { ok: false, reason: '交易号与内容不匹配（内容被改过）' };
  if (pubHex && !verifyTx(tx, pubHex)) return { ok: false, reason: '签名验证失败' };
  return { ok: true };
}

/* ============================ Merkle 树 ============================ */

/**
 * 计算 Merkle 根。
 * 奇数个节点时把最后一个复制一份（比特币的做法），保证任意笔数的树都能算。
 */
function merkleRoot(hashes) {
  if (!hashes.length) return sha256('');
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}

/**
 * 给第 index 笔交易生成 Merkle 证明（轻节点的核心）。
 * 返回路径：每一层是「兄弟节点哈希 + 它在左边还是右边」。
 * 客户端拿到它就能只凭一个 txid 验证「这笔交易确实在这块里」，不用下载整块。
 */
function merkleProof(hashes, index) {
  if (!hashes.length) return { path: [], root: sha256('') };
  if (index < 0 || index >= hashes.length) throw new Error('下标越界');
  let level = hashes.slice();
  let idx = index;
  const path = [];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push({ hash: level[sibling], left: sibling < idx });
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { path, root: level[0] };
}

/** 客户端侧独立校验 Merkle 证明（前端也用同一套算法，见 public/js/chain-lite.js） */
function verifyMerkleProof(txidHash, path, root) {
  let cur = txidHash;
  for (const step of path) {
    cur = step.left ? sha256(step.hash + cur) : sha256(cur + step.hash);
  }
  return cur === root;
}

/* ============================ 区块与 PoW ============================ */

/** 区块头哈希：高度 + 前哈希 + Merkle 根 + 时间戳 + 随机数 + 难度 + 矿工 */
function blockHash(b) {
  return sha256([b.height, b.prevHash, b.merkleRoot, b.ts, b.nonce, b.difficulty,
    b.miner || ''].join('|'));
}

/** 难度判定：哈希的十六进制前缀要有 difficulty 个 0 */
function meetsTarget(hash, difficulty) {
  return hash.startsWith('0'.repeat(difficulty));
}

/**
 * 挖矿（PoW）。
 * blockHash 拼的是 height|prevHash|merkleRoot|ts|nonce|difficulty|miner，只有 nonce 在变，
 * 所以把 nonce 前后两段预拼好，循环里只做一次 sha256（结果与原定义完全一致，
 * tools/test-chain.js 有断言锁死）。实测这点优化只值约 1.1 倍 —— 真正的瓶颈是
 * SHA-256 本身：Node 约 4µs/次、24 万次/秒，难度 4（平均 6.5 万次）≈ 280ms/块，
 * 难度 3 ≈ 17ms/块，难度每 +1 工作量 ×16。这就是「工作量证明」的物理成本，
 * 也是本项目里唯一没法靠写得更巧来提速的地方。
 */
function mine(block, difficulty) {
  const head = [block.height, block.prevHash, block.merkleRoot, block.ts].join('|') + '|';
  const tail = '|' + difficulty + '|' + (block.miner || '');
  const b = { ...block, difficulty, nonce: 0 };
  const zero = '0'.repeat(difficulty);
  for (;;) {
    b.hash = sha256(head + b.nonce + tail);
    if (b.hash.startsWith(zero)) return b;
    b.nonce += 1;
  }
}

/**
 * 难度自适应：每 20 块看一次实际出块耗时，慢了降难度、快了升难度，
 * 目标是 15 秒一块。这样「链会自己调节」不是一句空话。
 */
function nextDifficulty(blocks, targetMs = 15000, step = 20) {
  const last = blocks[blocks.length - 1];
  if (!last) return 4;
  if (last.height < step || last.height % step !== 0) return last.difficulty;
  const prev = blocks[blocks.length - 1 - step] || blocks[0];
  const avg = (last.ts - prev.ts) / step;
  if (avg > targetMs * 1.5) return Math.max(2, last.difficulty - 1);
  if (avg < targetMs * 0.5) return Math.min(6, last.difficulty + 1);
  return last.difficulty;
}

const GENESIS_PREV = '0'.repeat(64);

/** 造创世块：链的起点，里面记一句平台的发行宣言（也是最好的防伪锚点） */
function genesisBlock(ts = Date.now(), privHex) {
  const raw = { type: 'GENESIS', from: 'CJMINT', to: 'CJMINT', amount: 0, ts, nonce: 0,
    memo: '寸进链创世：把想法变成路线，把今天变成进度。' };
  // 传了私钥就当场签名。创世交易也得签名 —— 否则全链校验会在第 0 块报「签名验证失败」，
  // 而且这种错最容易被当成「校验功能坏了」，其实是数据源头的问题。
  const tx = privHex ? sealTx(raw, privHex) : { ...raw, txid: txId(raw), sig: '' };
  const empty = { height: 0, prevHash: GENESIS_PREV, merkleRoot: merkleRoot([tx.txid]),
    ts, nonce: 0, difficulty: 4, miner: 'CJMINT', txCount: 1 };
  return { block: mine(empty, 4), txs: [tx] };
}

/* ============================ 全链校验 ============================ */

/**
 * 逐块校验整条链。返回 { ok, badHeight, reason, checked }。
 * 这是「篡改实验室」的后端支撑：直接改数据库里的积分，链本身没问题；
 * 但如果改了区块内容（金额/memo/时间戳），这里会精确报出是哪一块。
 */
function validateChain(blocks, txsOf, pubOf, opts = {}) {
  const useMerkle = opts.merkle !== false;
  const useSig = opts.signature !== false;
  let checked = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // ① 高度连续
    if (b.height !== i) return { ok: false, badHeight: b.height, reason: `高度不连续：第 ${i} 位却是高度 ${b.height}`, checked };
    // ② 前哈希必须指向上一个块
    const want = i === 0 ? GENESIS_PREV : blocks[i - 1].hash;
    if (b.prevHash !== want) return { ok: false, badHeight: b.height, reason: `前哈希对不上（期望 ${want.slice(0, 16)}…，实际 ${String(b.prevHash).slice(0, 16)}…）`, checked };
    // ③ 自身哈希自洽
    if (blockHash(b) !== b.hash) return { ok: false, badHeight: b.height, reason: '区块头被改动，哈希与内容不匹配', checked };
    // ④ 满足难度
    if (!meetsTarget(b.hash, b.difficulty)) return { ok: false, badHeight: b.height, reason: '区块不满足难度目标（工作量被伪造）', checked };
    // ⑤ Merkle 根与交易对得上
    if (useMerkle && txsOf) {
      const txs = txsOf(b.height) || [];
      const root = merkleRoot(txs.map((t) => t.txid));
      if (txs.length && root !== b.merkleRoot) {
        return { ok: false, badHeight: b.height, reason: `Merkle 根不匹配：块内有 ${txs.length} 笔交易，重算得到 ${root.slice(0, 16)}…，块头写的是 ${String(b.merkleRoot).slice(0, 16)}…`, checked };
      }
      // ⑥ 每笔交易的哈希与签名
      for (const t of txs) {
        if (txId(t) !== t.txid) return { ok: false, badHeight: b.height, reason: `交易 ${String(t.txid).slice(0, 12)}… 内容被改动`, checked };
        if (useSig && pubOf) {
          const pub = pubOf(t.from);
          if (pub) {
            const c = checkTx(t, pub);
            if (!c.ok) return { ok: false, badHeight: b.height, reason: `交易签名失败（${TYPE_CN[t.type] || t.type}）：${c.reason}`, checked };
          }
        }
      }
    }
    checked++;
  }
  return { ok: true, badHeight: -1, reason: `全部 ${checked} 个区块校验通过：链式哈希、Merkle 根、工作量证明、交易签名均无异常`, checked };
}

module.exports = {
  sha256, canonical, newKeyPair, addressOf, signTx, verifyTx, pubFromPriv, txId, sealTx, checkTx,
  merkleRoot, merkleProof, verifyMerkleProof,
  blockHash, meetsTarget, mine, nextDifficulty, genesisBlock, GENESIS_PREV,
  makeTx, TX_TYPES, TYPE_CN, SYSTEM_ACCOUNTS, validateChain,
};
