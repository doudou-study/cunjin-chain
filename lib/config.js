'use strict';
/**
 * 全局配置。所有可调项都支持环境变量覆盖，README 里有对照表。
 * 数据库默认按本机 phpstudy 的 MySQL（端口 3307）配置，换机器改 config.json 即可。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config.json');
let fileCfg = {};
try { if (fs.existsSync(FILE)) fileCfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { fileCfg = {}; }

const pick = (envKey, fileVal, def) => {
  const v = process.env[envKey];
  if (v !== undefined && v !== '') return v;
  if (fileVal !== undefined && fileVal !== '') return fileVal;
  return def;
};

const cfg = {
  // —— Web 服务 ——
  port: Number(pick('CJ_PORT', fileCfg.port, 8901)),
  host: pick('CJ_HOST', fileCfg.host, '0.0.0.0'),

  // —— MySQL ——
  db: {
    host: pick('CJ_DB_HOST', fileCfg.db && fileCfg.db.host, '127.0.0.1'),
    port: Number(pick('CJ_DB_PORT', fileCfg.db && fileCfg.db.port, 3307)),
    user: pick('CJ_DB_USER', fileCfg.db && fileCfg.db.user, 'root'),
    password: pick('CJ_DB_PASS', fileCfg.db && fileCfg.db.password, '123456'),
    database: pick('CJ_DB_NAME', fileCfg.db && fileCfg.db.database, 'cunjin_chain'),
    charset: 'utf8mb4',
    connectionLimit: 12,
    timezone: '+08:00',
    dateStrings: ['DATE', 'DATETIME'],
    multipleStatements: true,
  },

  // —— 链参数 ——
  chain: {
    difficulty: Number(pick('CJ_DIFFICULTY', fileCfg.chain && fileCfg.chain.difficulty, 4)),
    // 交易池攒到这个笔数就出块
    maxTxPerBlock: Number(pick('CJ_MAXTX', fileCfg.chain && fileCfg.chain.maxTxPerBlock, 12)),
    // 到点强制出块（毫秒）
    blockIntervalMs: Number(pick('CJ_BLK_MS', fileCfg.chain && fileCfg.chain.blockIntervalMs, 20000)),
    // 目标出块时间，用于难度自适应
    targetMs: Number(pick('CJ_TARGET_MS', fileCfg.chain && fileCfg.chain.targetMs, 15000)),
  },

  // —— 积分规则默认值（会被数据库 point_rules 覆盖）——
  points: {
    checkinBase: 5,
    streakBonus: [0, 1, 2, 3, 5, 8, 12, 18, 25, 40], // 连续第 n 天的额外加成
    taskPoint: 1,
    dayBonus: 10,
    levelStep: 500, // 每 500 成长值升 1 级
  },
};

module.exports = cfg;
