'use strict';
/**
 * 鉴权。
 * 用「HMAC 签名的自包含 token」而不是服务端 session 表：
 *   token = base64url(payload).base64url(hmac(payload))
 * payload 里带 uid / role / 过期时间。好处是服务重启不掉登录态，
 * 而且不需要为演示再建一张 session 表（作业要求每张表 50 条以上，能不建就不建）。
 * 签名密钥持久化在 data/secret.json，重启后旧 token 依然有效。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const chain = require('./chain');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'secret.json');

function secret() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8')).secret;
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(FILE, JSON.stringify({ secret: s, createdAt: new Date().toISOString() }, null, 2));
  return s;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

const TTL = 14 * 24 * 3600 * 1000; // 两周

function makeToken(u) {
  const payload = b64(JSON.stringify({ uid: u.id, role: u.role, name: u.nickname, exp: Date.now() + TTL }));
  const sig = b64(crypto.createHmac('sha256', secret()).update(payload).digest());
  return payload + '.' + sig;
}

function readToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const want = b64(crypto.createHmac('sha256', secret()).update(payload).digest());
  // 定长比较，避免时序侧信道（虽然演示项目不至于被打，但签名验证就该这么写）
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(unb64(payload));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------------- Cookie ---------------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

const COOKIE = 'cj_token';

function setCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${TTL / 1000}; SameSite=Lax; HttpOnly`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}

/* ---------------- 口令 ---------------- */
function hashPassword(plain, salt) { return chain.sha256(salt + plain); }

function newSalt() { return crypto.randomBytes(8).toString('hex'); }

/* ---------------- 当前用户 ---------------- */
/**
 * 从请求里解析当前用户。
 * 每次都回库取一次，避免用户被改角色/封禁后 token 还有效。
 */
async function currentUser(req) {
  const p = readToken(parseCookies(req)[COOKIE]);
  if (!p) return null;
  const u = await db.queryOne(
    `SELECT u.*, s.balance, s.earned, s.spent, s.frozen, s.checkin_days, s.streak, s.max_streak,
            s.task_done, s.day_clear, s.badge_count, s.level, s.exp
       FROM users u LEFT JOIN user_stats s ON s.user_id = u.id
      WHERE u.id = ?`, [p.uid]);
  if (!u || !u.status) return null;
  delete u.priv_key; // 私钥绝不出库门
  delete u.password; delete u.salt;
  return u;
}

/** 权限守卫：Express 中间件工厂 */
function requireRole(...roles) {
  return async (req, res, next) => {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ ok: false, msg: '请先登录' });
    if (roles.length && !roles.includes(u.role)) {
      return res.status(403).json({ ok: false, msg: '没有权限（需要 ' + roles.join('/') + '）' });
    }
    req.user = u;
    next();
  };
}

/** 可选登录（链浏览器、验真这种公开页也想知道「你登录了吗」） */
async function optionalUser(req, res, next) {
  req.user = await currentUser(req);
  next();
}

module.exports = { makeToken, readToken, currentUser, parseCookies, setCookie, clearCookie,
  hashPassword, newSalt, requireRole, optionalUser, COOKIE, secret };
