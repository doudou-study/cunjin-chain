'use strict';
/**
 * 数据库访问层。用 mysql2/promise 连接池，统一封装 query / queryOne / tx 事务。
 * 所有 SQL 一律走参数化占位符，杜绝拼接注入。
 */
const mysql = require('mysql2/promise');
const cfg = require('./config');

const pool = mysql.createPool(cfg.db);

/** 取多行 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** 取一行（没有则 null） */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 取单个值（第一行第一列） */
async function scalar(sql, params = []) {
  const row = await queryOne(sql, params);
  if (!row) return null;
  return Object.values(row)[0];
}

/** 执行（INSERT/UPDATE/DELETE），返回 { insertId, affectedRows } */
async function exec(sql, params = []) {
  const [r] = await pool.execute(sql, params);
  return r;
}

/** 批量插入：values 是二维数组，列数需与 cols 一致 */
async function insertMany(table, cols, values) {
  if (!values.length) return { affectedRows: 0 };
  const marks = '(' + cols.map(() => '?').join(',') + ')';
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ` + values.map(() => marks).join(',');
  const [r] = await pool.execute(sql, values.flat());
  return r;
}

/**
 * 事务：回调里拿到的 conn 提供同样的 query/exec 接口。
 * 积分这种「流水 + 余额 + 链上交易」三处同时写的场景必须包在事务里，否则对不上账。
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  const api = {
    query: async (sql, p = []) => (await conn.execute(sql, p))[0],
    queryOne: async (sql, p = []) => {
      const rows = (await conn.execute(sql, p))[0];
      return rows.length ? rows[0] : null;
    },
    exec: async (sql, p = []) => (await conn.execute(sql, p))[0],
  };
  try {
    await conn.beginTransaction();
    const out = await fn(api);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 执行不带参数的原生 SQL（文本协议）。
 * TRUNCATE / SET / CREATE 这类语句**不能**走预编译（execute），
 * MySQL 会直接报 "This command is not supported in the prepared statement protocol"，
 * 所以凡是不需要参数、又是 DDL/DCL 的语句一律走这里。
 */
async function raw(sql) {
  const [r] = await pool.query(sql);
  return r;
}

/** 健康检查 + 版本信息，启动时打印 */
async function health() {
  const [row] = await pool.query('SELECT VERSION() AS v, DATABASE() AS db');
  const [t] = await pool.query(
    'SELECT COUNT(*) AS tables_cnt FROM information_schema.tables WHERE table_schema = ?',
    [cfg.db.database]);
  return { version: row[0].v, database: row[0].db, tables: t[0].tables_cnt };
}

async function close() { await pool.end(); }

module.exports = { pool, query, queryOne, scalar, exec, insertMany, transaction, raw, health, close };
