'use strict';
/**
 * 密钥柜。
 * · 平台发行密钥：持久化在 data/platform-key.json，用来给「系统账户发起的交易」签名
 *   （铸币、日结奖励、奖池结算…）。重启后老交易的签名依然验得过，这是必须的，
 *   否则链一等就废。
 * · 用户密钥：注册时生成，存在 users.pub_key / priv_key。课堂上为了方便放在服务端，
 *   README「安全边界」一节写清了这与生产做法的差距。
 */
const fs = require('fs');
const path = require('path');
const chain = require('./chain');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'platform-key.json');

// 4 个系统账户（地址固定，用户一眼能认出来）
const SYSTEM_ADDRS = Object.keys(chain.SYSTEM_ACCOUNTS); // CJMINT / CJBURN / CJPOOL / CJDONATE

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  let kp;
  if (fs.existsSync(FILE)) {
    kp = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } else {
    const k = chain.newKeyPair();
    // 用户地址是 CJ + 30 位；系统账户地址是固定的短名，不用哈希生成，
    // 这样链浏览器上「CJMINT」一眼可辨认，不必去查地址簿。
    kp = { pub: k.pub, priv: k.priv, addr: 'CJ' + chain.sha256('PLATFORM' + k.pub).slice(0, 30),
      createdAt: new Date().toISOString() };
    fs.writeFileSync(FILE, JSON.stringify(kp, null, 2));
  }
  cache = kp;
  return kp;
}

/** 平台发行密钥对 */
function platform() { return load(); }

/** 平台自己的链上地址（平台也是一个普通持币地址，账目一样公开可查） */
function platformAddr() { return load().addr; }

/** 判断是不是系统保留地址 */
function isSystem(addr) { return SYSTEM_ADDRS.includes(addr); }

/**
 * 取某个地址对应的公钥 —— 全链校验的 pubOf 回调。
 * 系统地址 → 平台公钥；用户地址 → 库里存的公钥（由调用方预加载成 map 传入）。
 */
function pubOfFactory(userPubMap) {
  const plat = platform().pub;
  return (addr) => {
    if (isSystem(addr)) return plat;
    if (addr === platformAddr()) return plat;
    return userPubMap ? userPubMap[addr] || null : null;
  };
}

/**
 * 给一笔交易签名。
 * from 是系统地址或平台地址 → 用平台密钥；否则用该用户自己的密钥。
 */
function signerFor(from, userPriv) {
  if (isSystem(from) || from === platformAddr()) return load().priv;
  if (!userPriv) throw new Error('缺少用户私钥，无法签名：' + from);
  return userPriv;
}

/**
 * 这个地址「应该」由哪把公钥签名。
 * 系统地址与平台地址 → 平台公钥；用户地址 → null（要查库才知道，交给调用方）。
 * 有了它，签名方一旦用错密钥（比如拿别人的私钥签），在写入交易池之前就会被拦住。
 */
function expectedPubFor(addr) {
  if (isSystem(addr) || addr === platformAddr()) return load().pub;
  return null;
}

module.exports = { platform, platformAddr, isSystem, pubOfFactory, signerFor, expectedPubFor,
  SYSTEM_ADDRS, FILE };
