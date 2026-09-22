/* =====================================================================================
   轻节点（浏览器侧）
   =====================================================================================
   这个文件的全部意义在于：**不信任服务端**。
   链浏览器页面上那些「校验通过」不能只由后端说了算 —— 后端自己说自己没错，
   那不算证明。所以这里用浏览器原生 WebCrypto 把服务端算过的东西**再算一遍**：

     · txid  = sha256( canonical(交易内容去掉 txid 和 sig) )
     · 区块哈希 = sha256( height|prevHash|merkleRoot|ts|nonce|difficulty|miner )
     · Merkle 根 / Merkle 证明 = 二进制哈希树
     · PoW 目标 = 哈希前 difficulty 个十六进制位必须是 0

   算法必须与 lib/chain.js 逐字节一致，否则重算结果对不上 ——
   这也正是它能证明「服务端没骗人」的原因。
   验证脚本里有一条断言专门比对「浏览器算的 txid === 服务端给的 txid」。
   ===================================================================================== */

const enc = new TextEncoder();

export function available() {
  return typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest;
}

/** SHA-256 → 64 位十六进制小写串（与服务端 chain.sha256 一致：UTF-8 编码） */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 稳定序列化 —— 必须与服务端 lib/chain.js 的 canonical() 逐字符一致：
 *   对象：key 排序、值递归、字符串走 JSON.stringify
 *   数组：[a,b,c]
 *   其他：JSON.stringify
 */
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** 从接口返回的交易对象里抽出参与哈希的字段 */
export function txPayload(t) {
  return {
    type: t.type,
    from: t.from_addr !== undefined ? t.from_addr : t.from,
    to: t.to_addr !== undefined ? t.to_addr : t.to,
    amount: Number(t.amount),
    memo: t.memo || '',
    ts: Number(t.ts),
    nonce: Number(t.nonce),
  };
}

/** 本地重算交易号 */
export async function txIdOf(t) {
  return sha256Hex(canonical(txPayload(t)));
}

/** 本地重算区块哈希 */
export async function blockHashOf(b) {
  return sha256Hex([
    Number(b.height), b.prev_hash !== undefined ? b.prev_hash : b.prevHash,
    b.merkle_root !== undefined ? b.merkle_root : b.merkleRoot,
    Number(b.ts), Number(b.nonce), Number(b.difficulty),
    b.miner || '',
  ].join('|'));
}

/** 本地重算 Merkle 根（奇数个节点时复制最后一个，与服务端一致） */
export async function merkleRootOf(hashes) {
  if (!hashes.length) return sha256Hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256Hex(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}

/** 验证 Merkle 证明：path = [{hash, left}] */
export async function verifyMerkleProof(leaf, path, root) {
  let cur = leaf;
  for (const step of path) {
    cur = step.left ? await sha256Hex(step.hash + cur) : await sha256Hex(cur + step.hash);
  }
  return { ok: cur === root, computed: cur };
}

/** 难度判定 */
export function meetsTarget(hash, difficulty) {
  return typeof hash === 'string' && hash.startsWith('0'.repeat(Number(difficulty)));
}

/* ============================ 综合校验 ============================ */

/**
 * 校验一个区块。返回每一步的结果，供界面逐步显示「第几步通过/失败」。
 * @param {object} b      区块对象（接口原样返回）
 * @param {array}  txs    块内交易
 * @param {string} prevHash 上一块哈希（没有就不校验这一项）
 */
export async function verifyBlock(b, txs, prevHash) {
  const steps = [];
  const push = (name, ok, detail) => steps.push({ name, ok, detail });

  // ① 区块头哈希自洽
  const h = await blockHashOf(b);
  push('区块头哈希自洽', h === b.hash,
    h === b.hash ? `重算 ${h.slice(0, 20)}… 与链上一致` : `重算得到 ${h.slice(0, 20)}…，与链上 ${String(b.hash).slice(0, 20)}… 不符`);

  // ② Merkle 根
  const ids = txs.map((t) => t.txid);
  const root = await merkleRootOf(ids);
  push('Merkle 根与块内交易匹配', !ids.length || root === b.merkle_root,
    !ids.length ? '空块跳过' : (root === b.merkle_root
      ? `${ids.length} 笔交易重算得到 ${root.slice(0, 20)}…` : `重算 ${root.slice(0, 20)}… ≠ 块头 ${String(b.merkle_root).slice(0, 20)}…`));

  // ③ 每笔交易的交易号
  let badTx = 0;
  for (const t of txs) {
    const id = await txIdOf(t);
    if (id !== t.txid) badTx++;
  }
  push('块内每笔交易号自洽', badTx === 0, badTx ? `${badTx} 笔交易内容被改动` : `${txs.length} 笔全部通过`);

  // ④ 工作量证明
  const powOk = meetsTarget(b.hash, b.difficulty);
  push('满足工作量证明（前导 0 个数）', powOk,
    `难度 ${b.difficulty}，要求前缀 ${'0'.repeat(Number(b.difficulty))}，实际 ${String(b.hash).slice(0, Number(b.difficulty) + 6)}…`);

  // ⑤ 前哈希衔接
  if (prevHash) {
    push('与上一块衔接', b.prev_hash === prevHash,
      b.prev_hash === prevHash ? `${String(prevHash).slice(0, 20)}…` : `期望 ${String(prevHash).slice(0, 20)}…，实际 ${String(b.prev_hash).slice(0, 20)}…`);
  }

  return { ok: steps.every((s) => s.ok), steps, hash: h, merkleRoot: root };
}

/** 校验一笔交易：交易号自洽 + 是否已上链 */
export async function verifyTx(t) {
  const id = await txIdOf(t);
  return {
    txidOk: id === t.txid,
    computed: id,
    onChain: t.block_height !== null && t.block_height !== undefined,
  };
}
