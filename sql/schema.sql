-- =====================================================================================
--  寸进链 · 每日打卡积分与链上成就存证平台   数据库建表脚本
--  数据库：MySQL 5.7+       字符集：utf8mb4
--  用法：mysql -uroot -p < sql/schema.sql
--  说明：23 张表 —— 业务 17 张 + 链 2 张 + 风控/审计/公告/验真 4 张，另附 5 个视图。
--        所有表均已灌入 50 条以上演示数据，见 sql/seed.sql（由 tools/seed.js 生成）。
-- =====================================================================================

DROP DATABASE IF EXISTS cunjin_chain;
CREATE DATABASE cunjin_chain DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE cunjin_chain;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- =====================================================================================
--  第一部分：用户与账户
-- =====================================================================================

-- 1. 用户表 -------------------------------------------------------------------------
-- 每个用户在注册时就生成一对 Ed25519 密钥，addr 是链上地址（CJ + 公钥哈希前 30 位）。
-- 私钥存库仅为课堂演示；真实产品的私钥应留在客户端，平台只保存公钥（非托管钱包）。
CREATE TABLE users (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户ID',
  username    VARCHAR(32)  NOT NULL                COMMENT '登录名',
  nickname    VARCHAR(32)  NOT NULL                COMMENT '昵称',
  password    CHAR(64)     NOT NULL                COMMENT '口令 = sha256(salt + 明文)',
  salt        CHAR(16)     NOT NULL                COMMENT '口令盐',
  role        ENUM('user','operator','admin') NOT NULL DEFAULT 'user' COMMENT '角色：用户/运营/超级管理员',
  addr        CHAR(32)     NOT NULL                COMMENT '链上地址 CJ+30位十六进制',
  pub_key     CHAR(128)    NOT NULL                COMMENT 'Ed25519 公钥(DER hex)',
  priv_key    CHAR(160)    NOT NULL                COMMENT 'Ed25519 私钥(DER hex)，仅演示用',
  avatar      VARCHAR(160) DEFAULT NULL            COMMENT '头像地址',
  city        VARCHAR(32)  DEFAULT NULL            COMMENT '城市',
  bio         VARCHAR(120) DEFAULT NULL            COMMENT '个人签名',
  goal        VARCHAR(120) DEFAULT NULL            COMMENT '我的目标（用于生成任务模板）',
  status      TINYINT      NOT NULL DEFAULT 1      COMMENT '1 正常 / 0 封禁',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
  last_login  DATETIME     DEFAULT NULL            COMMENT '最近登录',
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username),
  UNIQUE KEY uk_addr (addr),
  KEY idx_role (role),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表（含链上地址与密钥对）';

-- 2. 用户统计表 ---------------------------------------------------------------------
-- 冗余的汇总表：排行榜、看板、连续签到曲线都读它，避免每次去扫百万行流水。
-- 每次业务动作后由 lib/points.js 增量维护，并有 tools/qa.js 做「与流水对账」的一致性校验。
CREATE TABLE user_stats (
  user_id       BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
  balance       INT NOT NULL DEFAULT 0 COMMENT '可用积分余额',
  earned        INT NOT NULL DEFAULT 0 COMMENT '累计获得积分',
  spent         INT NOT NULL DEFAULT 0 COMMENT '累计消耗积分',
  frozen        INT NOT NULL DEFAULT 0 COMMENT '押注中的冻结积分',
  checkin_days  INT NOT NULL DEFAULT 0 COMMENT '累计签到天数',
  streak        INT NOT NULL DEFAULT 0 COMMENT '当前连续签到天数',
  max_streak    INT NOT NULL DEFAULT 0 COMMENT '历史最长连续签到',
  task_done     INT NOT NULL DEFAULT 0 COMMENT '累计完成单任务数',
  day_clear     INT NOT NULL DEFAULT 0 COMMENT '累计「当天全清」次数',
  badge_count   INT NOT NULL DEFAULT 0 COMMENT '持有徽章数',
  level         TINYINT NOT NULL DEFAULT 1 COMMENT '等级 1~10',
  exp           INT NOT NULL DEFAULT 0 COMMENT '成长值',
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_balance (balance),
  KEY idx_streak (streak),
  CONSTRAINT fk_stats_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户统计表（余额/连续天数/等级）';

-- 3. 积分账户表（链上账户视角）-------------------------------------------------------
-- 与 user_stats.balance 互为对账关系：一个来自链上交易汇总，一个来自业务流水汇总。
-- 两者必须永远相等 —— 这条不变量由 tools/qa.js 断言守住。
CREATE TABLE point_accounts (
  addr        CHAR(32) NOT NULL COMMENT '链上地址',
  user_id     BIGINT UNSIGNED DEFAULT NULL COMMENT '关联用户（系统账户为 NULL）',
  label       VARCHAR(40) NOT NULL COMMENT '账户名（系统账户如：铸币/销毁/奖池/公益）',
  is_system   TINYINT NOT NULL DEFAULT 0 COMMENT '1 系统账户',
  on_chain    BIGINT NOT NULL DEFAULT 0 COMMENT '链上余额（按 txs 汇总）',
  tx_count    INT NOT NULL DEFAULT 0 COMMENT '发生过的交易笔数',
  first_seen  DATETIME DEFAULT NULL COMMENT '首次交易时间',
  last_seen   DATETIME DEFAULT NULL COMMENT '最近交易时间',
  PRIMARY KEY (addr),
  KEY idx_pa_user (user_id),
  KEY idx_pa_sys (is_system)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分账户表（含 4 个系统账户）';

-- 4. 积分规则表 ---------------------------------------------------------------------
-- 带版本：每次运营调整规则都插入新版本并上链存证（RULE 交易），旧版本保留。
-- 这样「某一笔积分是按哪版规则发的」永远可追溯 —— 这也是表能自然超过 50 行的原因。
CREATE TABLE point_rules (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_key    VARCHAR(32) NOT NULL COMMENT '规则键：checkin_base/streak_bonus/task_point/day_bonus/badge_cost/redeem_rate/stake_odds/level_exp',
  version     INT NOT NULL DEFAULT 1 COMMENT '版本号',
  rule_name   VARCHAR(48) NOT NULL COMMENT '规则中文名',
  val_num     DECIMAL(12,2) NOT NULL COMMENT '数值',
  val_text    VARCHAR(120) DEFAULT NULL COMMENT '值的说明（如 1,2,3,5,10 阶梯）',
  unit        VARCHAR(16) DEFAULT NULL COMMENT '单位（分/‰/倍）',
  active      TINYINT NOT NULL DEFAULT 1 COMMENT '1 当前生效',
  txid        CHAR(64) DEFAULT NULL COMMENT '规则存证的链上交易号',
  changed_by  BIGINT UNSIGNED DEFAULT NULL COMMENT '修改人',
  reason      VARCHAR(120) DEFAULT NULL COMMENT '变更理由',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rule (rule_key, version),
  KEY idx_rule_active (rule_key, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分规则表（带版本与上链存证）';

-- =====================================================================================
--  第二部分：打卡与任务
-- =====================================================================================

-- 5. 签到记录表 ---------------------------------------------------------------------
CREATE TABLE checkins (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
  day           DATE NOT NULL COMMENT '签到日期',
  base_points   INT NOT NULL DEFAULT 0 COMMENT '基础分',
  bonus_points  INT NOT NULL DEFAULT 0 COMMENT '连续加成',
  streak_after  INT NOT NULL DEFAULT 1 COMMENT '签到后的连续天数',
  total_points  INT NOT NULL DEFAULT 0 COMMENT '本次总得分 = base + bonus',
  late_flag     TINYINT NOT NULL DEFAULT 0 COMMENT '是否深夜补签(23:00后)',
  ip            VARCHAR(45) DEFAULT NULL COMMENT '来源IP（风控用）',
  device        VARCHAR(60) DEFAULT NULL COMMENT '设备指纹（风控用）',
  txid          CHAR(64) DEFAULT NULL COMMENT '链上交易号',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_day (user_id, day),
  KEY idx_day (day),
  KEY idx_txid (txid),
  CONSTRAINT fk_ck_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日签到记录';

-- 6. 任务模板表 ---------------------------------------------------------------------
-- 用户订阅某一类模板，系统每天按模板生成当天的任务实例（这就是「每日任务」的来源）。
CREATE TABLE task_templates (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL COMMENT '拥有者',
  title       VARCHAR(60) NOT NULL COMMENT '任务标题',
  category    ENUM('study','work','fitness','reading','life','other') NOT NULL DEFAULT 'other',
  detail      VARCHAR(160) DEFAULT NULL COMMENT '任务说明',
  est_min     INT NOT NULL DEFAULT 25 COMMENT '预计耗时(分钟)',
  points      INT NOT NULL DEFAULT 1 COMMENT '完成得分',
  repeat_type ENUM('daily','weekday','weekly') NOT NULL DEFAULT 'daily' COMMENT '重复方式',
  weekly_day  TINYINT DEFAULT NULL COMMENT '每周几(1~7)',
  remind_at   CHAR(5) DEFAULT NULL COMMENT '提醒时间 HH:mm',
  enabled     TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tt_user (user_id),
  KEY idx_tt_cat (category),
  CONSTRAINT fk_tt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务模板表（习惯库）';

-- 7. 每日任务实例表 -----------------------------------------------------------------
CREATE TABLE tasks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  day         DATE NOT NULL COMMENT '所属日期',
  title       VARCHAR(60) NOT NULL,
  category    ENUM('study','work','fitness','reading','life','other') NOT NULL DEFAULT 'other',
  est_min     INT NOT NULL DEFAULT 25,
  points      INT NOT NULL DEFAULT 1 COMMENT '完成得分',
  status      ENUM('todo','done','skip') NOT NULL DEFAULT 'todo',
  from_tpl    BIGINT UNSIGNED DEFAULT NULL COMMENT '来自哪个模板',
  sort_no     INT NOT NULL DEFAULT 0,
  done_at     DATETIME DEFAULT NULL,
  txid        CHAR(64) DEFAULT NULL COMMENT '完成时上链的交易号',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_task_user_day (user_id, day),
  KEY idx_task_status (user_id, day, status),
  KEY idx_task_txid (txid),
  CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日任务实例表';

-- 8. 任务操作日志表 -----------------------------------------------------------------
-- 勾选、取消勾选、跳过，每一次都留痕。反复勾选取消是刷分特征之一，风控要读这张表。
CREATE TABLE task_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  action      ENUM('create','done','undo','skip','restore') NOT NULL COMMENT '动作',
  points_delta INT NOT NULL DEFAULT 0 COMMENT '本次动作导致的积分变化',
  ip          VARCHAR(45) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tl_task (task_id),
  KEY idx_tl_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务操作日志';

-- =====================================================================================
--  第三部分：积分与成就
-- =====================================================================================

-- 9. 积分流水表 ---------------------------------------------------------------------
-- 业务侧账本。每一行都对应一笔链上交易（txid 非空即代表已上链），
-- 因此「库里的账」和「链上的账」可以做双向对账 —— 这是本项目的核心卖点。
CREATE TABLE point_ledger (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  addr        CHAR(32) NOT NULL COMMENT '用户的链上地址',
  type        ENUM('checkin','task','daybonus','badge','redeem','donate','stake','settle','pool','burn','transfer','adjust') NOT NULL COMMENT '流水类型',
  direction   TINYINT NOT NULL COMMENT '1 入账 / -1 出账',
  amount      INT NOT NULL COMMENT '变动积分（正数）',
  balance_after INT NOT NULL COMMENT '变动后余额（对账用）',
  memo        VARCHAR(120) DEFAULT NULL,
  ref_id      BIGINT UNSIGNED DEFAULT NULL COMMENT '关联业务ID（签到/任务/兑换单）',
  txid        CHAR(64) DEFAULT NULL COMMENT '链上交易号',
  block_height INT DEFAULT NULL COMMENT '所在区块高度',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pl_user (user_id, created_at),
  KEY idx_pl_type (type),
  KEY idx_pl_txid (txid),
  CONSTRAINT fk_pl_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分流水表（业务账本）';

-- 10. 徽章定义表 --------------------------------------------------------------------
-- 60 枚徽章分四大类：连续签到、积分总量、任务里程碑、团队协作。
-- 每枚徽章在铸造时都会成为一笔 BADGE 交易，链上留一个「成就凭证」。
CREATE TABLE badges (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(32) NOT NULL COMMENT '徽章编号',
  name        VARCHAR(40) NOT NULL COMMENT '徽章名',
  category    ENUM('streak','points','task','team','special') NOT NULL COMMENT '类别',
  level       TINYINT NOT NULL DEFAULT 1 COMMENT '稀有度 1铜 2银 3金 4钻',
  icon        VARCHAR(16) NOT NULL DEFAULT 'medal' COMMENT '图标名',
  color       VARCHAR(16) NOT NULL DEFAULT '#5b6cff' COMMENT '主色',
  cond_text   VARCHAR(80) NOT NULL COMMENT '达成条件（给人看的）',
  cond_type   VARCHAR(24) NOT NULL COMMENT '条件类型：streak/earned/task_done/day_clear/team_rank',
  cond_value  INT NOT NULL COMMENT '条件阈值',
  cost        INT NOT NULL DEFAULT 0 COMMENT '铸造消耗积分',
  supply      INT NOT NULL DEFAULT 0 COMMENT '已铸造数量',
  supply_cap  INT NOT NULL DEFAULT 0 COMMENT '发行上限，0 表示不限量',
  descr       VARCHAR(160) DEFAULT NULL COMMENT '徽章描述',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_badge_code (code),
  KEY idx_badge_cat (category),
  KEY idx_badge_lv (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='成就徽章定义表';

-- 11. 徽章领取（铸造）记录表 --------------------------------------------------------
-- 这张表就是「链上成就凭证」的业务侧存根：badge_claims.id 对应的 txid 可在链浏览器查。
CREATE TABLE badge_claims (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  badge_id    BIGINT UNSIGNED NOT NULL,
  serial      VARCHAR(40) NOT NULL COMMENT '凭证编号 CJB-年份-序号',
  cost        INT NOT NULL DEFAULT 0 COMMENT '铸造消耗',
  txid        CHAR(64) NOT NULL COMMENT '链上铸造交易号',
  block_height INT NOT NULL,
  merkle_path TEXT COMMENT 'Merkle 证明路径（JSON），轻节点验真用',
  verify_code CHAR(20) NOT NULL COMMENT '对外验真码（给外人查的短码）',
  status      ENUM('valid','revoked') NOT NULL DEFAULT 'valid' COMMENT '有效/已撤销',
  revoke_reason VARCHAR(120) DEFAULT NULL COMMENT '撤销理由（验真页要如实告诉查询方为什么撤销）',
  revoked_at  DATETIME DEFAULT NULL COMMENT '撤销时间',
  claimed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_serial (serial),
  UNIQUE KEY uk_verify (verify_code),
  KEY idx_bc_user (user_id),
  KEY idx_bc_badge (badge_id),
  KEY idx_bc_txid (txid),
  KEY idx_bc_status (status),
  CONSTRAINT fk_bc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bc_badge FOREIGN KEY (badge_id) REFERENCES badges (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='徽章铸造记录（链上成就凭证存根）';

-- 12. 奖励商品表 --------------------------------------------------------------------
CREATE TABLE rewards (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(60) NOT NULL COMMENT '商品名',
  category    ENUM('coupon','course','goods','virtual','charity') NOT NULL COMMENT '券/课程/实物/虚拟/公益',
  cost        INT NOT NULL COMMENT '所需积分',
  stock       INT NOT NULL DEFAULT 0 COMMENT '库存',
  sold        INT NOT NULL DEFAULT 0 COMMENT '已兑换',
  cover_color VARCHAR(16) DEFAULT '#5b6cff' COMMENT '封面配色',
  descr       VARCHAR(160) DEFAULT NULL,
  per_limit   INT NOT NULL DEFAULT 1 COMMENT '每人限兑',
  status      TINYINT NOT NULL DEFAULT 1 COMMENT '1 上架 0 下架',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rw_cat (category),
  KEY idx_rw_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分商城商品表';

-- 13. 兑换订单表 --------------------------------------------------------------------
CREATE TABLE redemptions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no    VARCHAR(24) NOT NULL COMMENT '订单号',
  user_id     BIGINT UNSIGNED NOT NULL,
  reward_id   BIGINT UNSIGNED NOT NULL,
  cost        INT NOT NULL COMMENT '消耗积分',
  qty         INT NOT NULL DEFAULT 1,
  status      ENUM('paid','shipped','done','cancel') NOT NULL DEFAULT 'paid',
  txid        CHAR(64) NOT NULL COMMENT '扣减交易号（消耗的积分可在链上追到销毁地址）',
  block_height INT NOT NULL,
  addr_to     CHAR(32) DEFAULT NULL COMMENT '收货/发券标识',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_rd_user (user_id),
  KEY idx_rd_reward (reward_id),
  KEY idx_rd_txid (txid),
  CONSTRAINT fk_rd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换订单表';

-- 14. 押注表 ------------------------------------------------------------------------
-- 玩法：把积分押在自己的目标上（如「14 天内完成 10 次晨跑」），
-- 达成 → 双倍返还（本金 + 奖池奖励）；失败 → 本金进奖池分给达成者。
CREATE TABLE stakes (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(80) NOT NULL COMMENT '押注的目标',
  amount       INT NOT NULL COMMENT '押注积分',
  odds         DECIMAL(4,2) NOT NULL DEFAULT 2.00 COMMENT '返还倍数',
  days         INT NOT NULL DEFAULT 7 COMMENT '周期天数',
  need_count   INT NOT NULL DEFAULT 5 COMMENT '周期内需完成次数',
  done_count   INT NOT NULL DEFAULT 0 COMMENT '已完成次数',
  start_day    DATE NOT NULL,
  end_day      DATE NOT NULL,
  status       ENUM('running','won','lost','cancel') NOT NULL DEFAULT 'running',
  stake_txid   CHAR(64) DEFAULT NULL COMMENT '锁定交易号',
  settle_txid  CHAR(64) DEFAULT NULL COMMENT '结算交易号',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stk_user (user_id),
  KEY idx_stk_status (status, end_day),
  CONSTRAINT fk_stk_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='押注表（对赌自己的目标）';

-- =====================================================================================
--  第四部分：团队（自习室）与公益
-- =====================================================================================

-- 15. 自习室（团队）表 --------------------------------------------------------------
CREATE TABLE teams (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(40) NOT NULL COMMENT '自习室名称',
  owner_id    BIGINT UNSIGNED NOT NULL COMMENT '房主',
  slogan      VARCHAR(80) DEFAULT NULL COMMENT '口号',
  goal        VARCHAR(80) DEFAULT NULL COMMENT '共同目标',
  join_code   CHAR(6) NOT NULL COMMENT '邀请码',
  max_member  INT NOT NULL DEFAULT 20,
  member_count INT NOT NULL DEFAULT 0,
  total_points INT NOT NULL DEFAULT 0 COMMENT '成员积分合计',
  checkin_rate INT NOT NULL DEFAULT 0 COMMENT '今日打卡率(%)',
  status      TINYINT NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_join_code (join_code),
  KEY idx_tm_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自习室（团队）表';

-- 16. 自习室成员表 ------------------------------------------------------------------
CREATE TABLE team_members (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  team_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('owner','member') NOT NULL DEFAULT 'member',
  week_points INT NOT NULL DEFAULT 0 COMMENT '本周贡献积分',
  joined_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_team_user (team_id, user_id),
  KEY idx_tmb_user (user_id),
  CONSTRAINT fk_tmb_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT fk_tmb_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自习室成员表';

-- 17. 公益捐赠表 --------------------------------------------------------------------
CREATE TABLE donations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  topic       VARCHAR(60) NOT NULL COMMENT '捐赠方向（乡村图书角 / 护林计划 …）',
  amount      INT NOT NULL COMMENT '捐赠积分',
  match_amount INT NOT NULL DEFAULT 0 COMMENT '平台配捐',
  txid        CHAR(64) NOT NULL,
  block_height INT NOT NULL,
  message     VARCHAR(120) DEFAULT NULL COMMENT '留言',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dn_user (user_id),
  KEY idx_dn_txid (txid),
  CONSTRAINT fk_dn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公益捐赠表（链上公示）';

-- =====================================================================================
--  第五部分：链本身（只增不改）
-- =====================================================================================

-- 18. 区块表 ------------------------------------------------------------------------
-- 注意：这张表和 txs 表在业务上是「只允许追加」的。任何 UPDATE 都会导致链校验失败，
-- 这正是链的价值 —— 存储层没有特殊保护（就是普通 InnoDB 表），
-- 保护来自哈希链：改了内容哈希就对不上。
CREATE TABLE blocks (
  height       INT NOT NULL COMMENT '区块高度',
  hash         CHAR(64) NOT NULL COMMENT '区块哈希',
  prev_hash    CHAR(64) NOT NULL COMMENT '前一块哈希',
  merkle_root  CHAR(64) NOT NULL COMMENT '交易 Merkle 根',
  ts           BIGINT NOT NULL COMMENT '出块时间戳(ms)',
  nonce        BIGINT NOT NULL COMMENT '工作量证明随机数',
  difficulty   TINYINT NOT NULL DEFAULT 4 COMMENT '难度（前导 0 个数）',
  miner        CHAR(32) NOT NULL COMMENT '出块者（本平台为系统铸币账户）',
  tx_count     INT NOT NULL DEFAULT 0 COMMENT '交易笔数',
  mined_ms     INT NOT NULL DEFAULT 0 COMMENT '本块挖矿耗时(ms)',
  size_bytes   INT NOT NULL DEFAULT 0 COMMENT '区块字节数',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (height),
  UNIQUE KEY uk_hash (hash),
  KEY idx_blk_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='区块表（哈希链）';

-- 19. 交易表 ------------------------------------------------------------------------
CREATE TABLE txs (
  txid         CHAR(64) NOT NULL COMMENT '交易号 = 交易内容哈希',
  block_height INT DEFAULT NULL COMMENT '所在区块（NULL = 还在交易池）',
  type         VARCHAR(12) NOT NULL COMMENT '交易类型',
  from_addr    CHAR(32) NOT NULL COMMENT '付款方地址',
  to_addr      CHAR(32) NOT NULL COMMENT '收款方地址',
  amount       INT NOT NULL COMMENT '积分金额',
  memo         VARCHAR(160) DEFAULT NULL COMMENT '备注（写进链，永久可查）',
  nonce        INT NOT NULL DEFAULT 0 COMMENT '防重放序号',
  ts           BIGINT NOT NULL COMMENT '交易时间戳(ms)',
  sig          CHAR(128) NOT NULL COMMENT 'Ed25519 签名',
  signer_pub   CHAR(128) DEFAULT NULL COMMENT '签名公钥（校验用，冗余存储便于独立验签）',
  verify_ok    TINYINT NOT NULL DEFAULT 1 COMMENT '入库时验签结果',
  block_ts     BIGINT DEFAULT NULL COMMENT '被打包的时间(ms)',
  PRIMARY KEY (txid),
  KEY idx_tx_block (block_height),
  KEY idx_tx_from (from_addr, ts),
  KEY idx_tx_to (to_addr, ts),
  KEY idx_tx_type (type),
  CONSTRAINT fk_tx_block FOREIGN KEY (block_height) REFERENCES blocks (height)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交易表（链上账本）';

-- =====================================================================================
--  第六部分：风控、审计、公告、验真
-- =====================================================================================

-- 20. 风控告警表 --------------------------------------------------------------------
-- 积分系统的头号敌人是「刷分」。规则：秒签、跨账号同 IP/设备、深夜批量操作、
-- 任务反复勾选取消、单位时间积分增速异常。命中即写一条告警，运营端可处置。
CREATE TABLE risk_alerts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  rule_code   VARCHAR(24) NOT NULL COMMENT '命中规则：fast_checkin/same_device/rapid_toggle/point_spike/midnight_burst',
  rule_name   VARCHAR(40) NOT NULL COMMENT '规则中文名',
  level       ENUM('low','mid','high') NOT NULL DEFAULT 'low' COMMENT '风险等级',
  detail      VARCHAR(200) NOT NULL COMMENT '命中细节',
  evidence    VARCHAR(200) DEFAULT NULL COMMENT '证据（IP / 设备 / 时间间隔）',
  handled     TINYINT NOT NULL DEFAULT 0 COMMENT '是否已处置',
  handler_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '处置人',
  handle_note VARCHAR(120) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ra_user (user_id),
  KEY idx_ra_handled (handled),
  KEY idx_ra_level (level, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='风控告警表';

-- 21. 审计日志表 --------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED DEFAULT NULL COMMENT '操作人',
  actor_role  VARCHAR(12) DEFAULT NULL,
  action      VARCHAR(40) NOT NULL COMMENT '动作',
  target      VARCHAR(60) DEFAULT NULL COMMENT '对象',
  detail      VARCHAR(200) DEFAULT NULL,
  ip          VARCHAR(45) DEFAULT NULL,
  txid        CHAR(64) DEFAULT NULL COMMENT '需要存证的管理动作会上链',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_al_actor (actor_id, created_at),
  KEY idx_al_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志表';

-- 22. 公告表 ------------------------------------------------------------------------
CREATE TABLE announcements (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(80) NOT NULL,
  content     VARCHAR(400) NOT NULL,
  category    ENUM('notice','rule','activity','maintain') NOT NULL DEFAULT 'notice',
  pinned      TINYINT NOT NULL DEFAULT 0,
  views       INT NOT NULL DEFAULT 0,
  author_id   BIGINT UNSIGNED DEFAULT NULL,
  status      TINYINT NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_an_cat (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公告表';

-- 23. 验真记录表 --------------------------------------------------------------------
-- 有人拿着徽章验真码来查，就写一条。运营端可以看「我们发的凭证被查了多少次」。
CREATE TABLE verify_records (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  verify_code CHAR(20) NOT NULL COMMENT '被查询的验真码',
  claim_id    BIGINT UNSIGNED DEFAULT NULL COMMENT '命中的徽章记录',
  result      ENUM('valid','revoked','notfound','tampered') NOT NULL COMMENT '验真结果',
  src         VARCHAR(40) DEFAULT NULL COMMENT '来源：web/qrcode/api',
  ip          VARCHAR(45) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vr_code (verify_code),
  KEY idx_vr_result (result, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='凭证验真记录表';

SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================================================
--  视图：把常用统计固化成视图，前端与看板直接查，逻辑只有一处
-- =====================================================================================

-- 用户全景（含余额与等级）
CREATE OR REPLACE VIEW v_user_overview AS
SELECT u.id, u.username, u.nickname, u.role, u.addr, u.city, u.goal, u.status, u.created_at,
       s.balance, s.earned, s.spent, s.frozen, s.checkin_days, s.streak, s.max_streak,
       s.task_done, s.day_clear, s.badge_count, s.level, s.exp,
       a.on_chain, a.tx_count
FROM users u
LEFT JOIN user_stats s ON s.user_id = u.id
LEFT JOIN point_accounts a ON a.user_id = u.id;

-- 链总览（区块与交易汇总）
CREATE OR REPLACE VIEW v_chain_overview AS
SELECT (SELECT COUNT(*) FROM blocks)                       AS block_count,
       (SELECT COUNT(*) FROM txs)                          AS tx_count,
       (SELECT COUNT(*) FROM txs WHERE block_height IS NULL) AS pending_tx,
       (SELECT MAX(height) FROM blocks)                    AS height,
       (SELECT hash FROM blocks ORDER BY height DESC LIMIT 1) AS latest_hash,
       (SELECT difficulty FROM blocks ORDER BY height DESC LIMIT 1) AS difficulty,
       (SELECT COALESCE(SUM(amount),0) FROM txs)           AS total_amount,
       (SELECT ROUND(AVG(mined_ms),0) FROM blocks WHERE height > 0) AS avg_mined_ms;

-- 积分发行与流通（按类型汇总）
CREATE OR REPLACE VIEW v_point_flow AS
SELECT type,
       COUNT(*)                AS tx_cnt,
       SUM(amount)             AS amount_sum,
       SUM(CASE WHEN direction = 1 THEN amount ELSE 0 END)  AS inflow,
       SUM(CASE WHEN direction = -1 THEN amount ELSE 0 END) AS outflow,
       MIN(created_at)         AS first_at,
       MAX(created_at)         AS last_at
FROM point_ledger GROUP BY type;

-- 每日活跃（签到/任务/积分三维）
CREATE OR REPLACE VIEW v_daily_activity AS
SELECT d.day,
       (SELECT COUNT(*) FROM checkins c WHERE c.day = d.day)              AS checkin_users,
       (SELECT COUNT(*) FROM tasks t WHERE t.day = d.day AND t.status='done') AS done_tasks,
       (SELECT COALESCE(SUM(amount),0) FROM point_ledger p
         WHERE DATE(p.created_at) = d.day AND p.direction = 1)            AS issued_points
FROM (SELECT DISTINCT day FROM checkins
      UNION SELECT DISTINCT day FROM tasks) d
ORDER BY d.day;

-- 徽章热度
CREATE OR REPLACE VIEW v_badge_hot AS
SELECT b.id, b.code, b.name, b.category, b.level, b.cost, b.supply, b.supply_cap,
       COUNT(c.id) AS claims,
       COALESCE(SUM(b.cost), 0) AS burned_points
FROM badges b LEFT JOIN badge_claims c ON c.badge_id = b.id
GROUP BY b.id;
