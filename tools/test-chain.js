'use strict';
/**
 * 区块链内核自测 —— 跑这一条就够：
 *   node tools/test-chain.js
 * 它验证的东西全都是「链能不能骗过人」的关键点，不是走过场：
 *   哈希、Merkle 证明（每个下标都验）、PoW、签名、篡改定位、难度自适应。
 */
const C = require('../lib/chain');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + '   ' + extra); }
};

console.log('\n【1】哈希与序列化');
ok('SHA-256 已知向量正确', C.sha256('abc') ===
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
ok('同样内容不同 key 顺序 → 同一个哈希（顺序无关）',
  C.canonical({ a: 1, b: 2 }) === C.canonical({ b: 2, a: 1 }));

console.log('\n【2】Merkle 树：每一笔交易都能独立证明');
{
  const hashes = ['a', 'b', 'c', 'd', 'e'].map((x) => C.sha256(x));
  const root = C.merkleRoot(hashes);
  let allOk = true;
  for (let i = 0; i < hashes.length; i++) {
    const p = C.merkleProof(hashes, i);
    if (!C.verifyMerkleProof(hashes[i], p.path, root)) allOk = false;
  }
  ok('5 笔（奇数）交易，全部 5 条证明都能验证通过', allOk, 'root=' + root.slice(0, 12) + '…');
  const p0 = C.merkleProof(hashes, 0);
  ok('把所有交易换成别的，证明立刻失效（防伪造）',
    !C.verifyMerkleProof(C.sha256('zzz'), p0.path, root));
  ok('给最后一笔（下标 4）出证明，路径不为空', C.merkleProof(hashes, 4).path.length === 3,
    '层级=' + C.merkleProof(hashes, 4).path.length);
}

console.log('\n【3】PoW 工作量证明');
{
  const t0 = Date.now();
  const b = C.mine({ height: 1, prevHash: C.GENESIS_PREV, merkleRoot: C.sha256('x'),
    ts: Date.now(), miner: 'CJTEST' }, 4);
  const cost = Date.now() - t0;
  ok('难度 4：哈希前缀 4 个 0', b.hash.startsWith('0000'), b.hash.slice(0, 20) + '…');
  ok('挖矿确实花了非零工作量', b.nonce > 0 && cost < 5000, `${b.nonce} 次尝试 / ${cost}ms`);
  // mine() 为了性能预拼了 nonce 前后两段字符串，这里锁死「与 blockHash 的定义一致」
  ok('优化后的 mine() 与 blockHash() 定义完全一致', C.blockHash(b) === b.hash,
    C.blockHash(b).slice(0, 16) + '…');
  ok('同一份区块头挖两次，nonce 不同但都合法（随机性来自问题本身）',
    (() => { const b2 = C.mine({ height: 1, prevHash: C.GENESIS_PREV, merkleRoot: C.sha256('x'),
      ts: Date.now(), miner: 'CJTEST' }, 4); return b2.hash !== b.hash && b2.hash.startsWith('0000'); })());
}

console.log('\n【4】Ed25519 签名与验签');
{
  const kp = C.newKeyPair();
  const addr = C.addressOf(kp.pub);
  ok('地址以 CJ 开头且 32 位', /^CJ[0-9a-f]{30}$/.test(addr), addr);
  const tx = C.sealTx(C.makeTx({ type: 'CHECKIN', from: addr, to: addr, amount: 5 }), kp.priv);
  ok('正常交易验签通过', C.checkTx(tx, kp.pub).ok);
  const evil = { ...tx, amount: 99999 };
  ok('把金额改成 99999 → 交易号对不上，被拦下', !C.checkTx(evil, kp.pub).ok);
  const forged = { ...tx, sig: 'ff'.repeat(64) };
  ok('伪造签名 → 验签失败', !C.checkTx(forged, kp.pub).ok);
  const other = C.newKeyPair();
  ok('换一把公钥 → 验签失败（不是谁都能替你改账）', !C.verifyTx(tx, other.pub));
}

console.log('\n【5】组链 + 全链校验');
const KP = C.newKeyPair();
const ADDR = C.addressOf(KP.pub);
function buildChain(n = 8) {
  const g = C.genesisBlock(1700000000000);
  const blocks = [g.block];
  const txIndex = { 0: g.txs };
  for (let h = 1; h <= n; h++) {
    const txs = [];
    for (let k = 0; k < 3; k++) {
      txs.push(C.sealTx(C.makeTx({
        type: k === 0 ? 'CHECKIN' : k === 1 ? 'TASK' : 'DAYBONUS',
        from: 'CJMINT', to: ADDR, amount: 1 + k,
        memo: `模拟交易 #${h}-${k}`, ts: 1700000000000 + h * 15000, nonce: h * 10 + k,
      }), KP.priv));
    }
    const prev = blocks[blocks.length - 1];
    const blk = C.mine({ height: h, prevHash: prev.hash, merkleRoot: C.merkleRoot(txs.map((t) => t.txid)),
      ts: 1700000000000 + h * 15000, miner: 'CJMINT', txCount: txs.length }, 3);
    blocks.push(blk);
    txIndex[h] = txs;
  }
  return { blocks, txIndex };
}
{
  const { blocks, txIndex } = buildChain();
  const pubOf = (a) => (a === ADDR ? KP.pub : null);
  const r = C.validateChain(blocks, (h) => txIndex[h], pubOf);
  ok('8 块 + 创世的全链校验通过', r.ok, r.reason.slice(0, 40) + '…');

  // 篡改场景一：改区块里的金额（最典型的「后台偷偷改数据」）
  const t = { ...txIndex[4][1], amount: 9999 };
  const r1 = C.validateChain(blocks, (h) => (h === 4 ? [txIndex[4][0], t, txIndex[4][2]] : txIndex[h]), pubOf);
  ok('改第 4 块里一笔交易的金额 → 被抓住且定位到高度 4', !r1.ok && r1.badHeight === 4,
    r1.reason.slice(0, 46));

  // 篡改场景二：直接改区块头的时间戳（想伪造存证时间）
  const bad = blocks.map((b) => ({ ...b }));
  bad[3].ts = bad[3].ts + 86400000;
  const r2 = C.validateChain(bad, (h) => txIndex[h], pubOf);
  ok('伪造第 3 块的时间戳 → 被抓住（区块头哈希不匹配）', !r2.ok && r2.badHeight === 3,
    r2.reason.slice(0, 40));

  // 篡改场景三：高级作弊 —— 攻击者不光改内容，还把这一块重新挖到满足难度
  // 单看第 5 块它自己完全合法，但第 6 块存的是旧哈希，链就断在那儿。
  // 这正是「改一块要重挖后面所有块」的成本来源。
  const bad2 = blocks.map((b) => ({ ...b }));
  bad2[5] = C.mine({ ...bad2[5], ts: bad2[5].ts + 60000 }, bad2[5].difficulty);
  const r3a = {
    selfHash: C.blockHash(bad2[5]) === bad2[5].hash,
    pow: C.meetsTarget(bad2[5].hash, bad2[5].difficulty),
    prevOk: bad2[5].prevHash === blocks[4].hash,
  };
  ok('单看被重挖过的第 5 块：哈希自洽、难度达标、前哈希也对',
    r3a.selfHash && r3a.pow && r3a.prevOk,
    `自洽=${r3a.selfHash} 难度=${r3a.pow} 前哈希=${r3a.prevOk}`);
  const r3 = C.validateChain(bad2, (h) => txIndex[h], pubOf);
  ok('但从整条链看，第 6 块的前哈希对不上 → 照样被抓住',
    !r3.ok && r3.badHeight === 6, r3.reason.slice(0, 40));

  // 篡改场景四：抽掉中间一块（想抹掉历史）
  const bad3 = blocks.filter((b) => b.height !== 2);
  const r4 = C.validateChain(bad3, (h) => txIndex[h], pubOf);
  ok('删掉第 2 块 → 高度不连续，被抓住', !r4.ok, r4.reason.slice(0, 34));
}

console.log('\n【6】难度自适应');
{
  const blocks = [];
  for (let i = 0; i <= 20; i++) blocks.push({ height: i, ts: 1000 + i * 30000, difficulty: 4 });
  ok('出块太慢（30 秒/块）→ 下次降难度', C.nextDifficulty(blocks) === 3,
    '得到 ' + C.nextDifficulty(blocks));
  const fast = [];
  for (let i = 0; i <= 20; i++) fast.push({ height: i, ts: 1000 + i * 3000, difficulty: 4 });
  ok('出块太快（3 秒/块）→ 下次升难度', C.nextDifficulty(fast) === 5, '得到 ' + C.nextDifficulty(fast));
}

console.log('\n【7】创世块');
{
  const g = C.genesisBlock();
  ok('创世块高度为 0、前哈希全 0', g.block.height === 0 && g.block.prevHash === C.GENESIS_PREV);
  ok('创世块满足难度 4', g.block.hash.startsWith('0000'), g.block.hash.slice(0, 20) + '…');
  ok('创世宣言内容完整', /寸进链创世/.test(g.txs[0].memo));
}

console.log(`\n================  通过 ${pass} / 失败 ${fail}  ================\n`);
process.exit(fail ? 1 : 0);
