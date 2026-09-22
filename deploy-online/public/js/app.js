/* =====================================================================================
   用户端（学习者视角）
   ===================================================================================== */
import * as A from './api.js';
import {
  $, $$, I, esc, n, pct, dt, ago, shortHash, toast, modal, confirmDlg,
  copy, bindCopy, empty, skel,
} from './ui.js';
import * as C from './charts.js';

/* ============================ 状态 ============================ */
const S = {
  user: null,
  today: null,
  heat: null,
  rules: null,
  device: null,
};

const CAT_NAME = { study: '学习', work: '工作', fitness: '运动', reading: '阅读', life: '生活', other: '其他' };
const TYPE_NAME = {
  checkin: '签到奖励', task: '任务完成', daybonus: '当日全清', badge: '徽章铸造', redeem: '商城兑换',
  donate: '公益捐赠', stake: '押注锁定', settle: '押注结算', pool: '罚金入池', burn: '销毁',
  transfer: '积分转账', adjust: '人工调账',
};
const LEVEL_NAME = { 1: '铜', 2: '银', 3: '金', 4: '钻石' };
const DIR_NAME = { coupon: '券码', course: '课程', goods: '实物', virtual: '虚拟', charity: '公益' };

/* ============================ 小工具 ============================ */
function deviceId() {
  if (S.device) return S.device;
  let d = localStorage.getItem('cj-device');
  if (!d) {
    d = 'WEB-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    localStorage.setItem('cj-device', d);
  }
  S.device = d;
  return d;
}

function txLink(txid, label) {
  return `<a class="hash" href="#/tx/${esc(txid)}" data-copy="${esc(txid)}"
    title="点开看链上详情；右键或双击复制">${I('cube', 12)}${esc(label || shortHash(txid))}</a>`;
}

/** 未登录时的引导块 */
function needLogin(what) {
  return `<div class="card pad" style="text-align:center;padding:52px 22px">
    <div style="width:58px;height:58px;border-radius:20px;margin:0 auto 16px;display:grid;place-items:center;
      background:var(--brand-soft);color:var(--brand-ink)">${I('lock', 26)}</div>
    <h3 style="font-size:17px">登录后${esc(what || '才能使用这个功能')}</h3>
    <p class="dim mt3" style="max-width:400px;margin:10px auto 20px">
      积分是从链上来的，得先有个属于你的链上地址。注册时会当场给你生成一对 Ed25519 密钥。</p>
    <div class="row" style="justify-content:center">
      <button class="btn pri lg" data-act="openLogin">登录</button>
      <button class="btn lg" data-act="openReg">注册新账号</button>
    </div>
    <div class="mt5 small dim2">演示账号：<b class="mono">cunjin001</b> / <b class="mono">123456</b></div>
  </div>`;
}

const stat = (k, v, d, cls = '') => `<div class="kpi ${cls}">
  <div class="k">${esc(k)}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

/* ============================ 今日 ============================ */
async function viewToday() {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin('才能签到和做任务'); return; }
  root.innerHTML = `<div class="grid g3">${skel(120)}${skel(120)}${skel(120)}</div>`;
  const t = await A.today();
  S.today = t;
  const u = S.user;
  const donePct = pct(t.done, t.total);
  const hour = new Date().getHours();
  const greet = hour < 6 ? '凌晨了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : hour < 23 ? '晚上好' : '夜深了';

  root.innerHTML = `
  <div class="grid g-2-1">
    <div class="col gap4" style="gap:18px">
      <!-- 签到卡 -->
      <div class="card hero">
        <div class="card-b" style="padding:24px 26px">
          <div class="row-b" style="align-items:flex-start;flex-wrap:wrap;gap:18px">
            <div class="grow" style="min-width:220px">
              <div class="row gap2 small dim2">${I('calendar', 14)} ${esc(t.day)} · ${greet}</div>
              <h1 style="font-size:26px;margin-top:8px">
                ${t.checkin ? `今天已经签到，连续 <span style="color:var(--streak)">${t.streakNow}</span> 天`
    : `连续签到第 <span style="color:var(--streak)">${t.streakIfCheckin}</span> 天等着你`}
              </h1>
              <p class="dim mt3">
                ${t.checkin
    ? `本次拿到 <b class="num" style="color:var(--ok)">+${t.checkin.total_points}</b> 分（基础 ${t.checkin.base_points} + 连续加成 ${t.checkin.bonus_points}）`
    : `现在签到可得 <b class="num" style="color:var(--ok)">+${t.checkinPreview}</b> 分`}
                ．今天任务全清还能再拿 <b class="num">+${t.dayBonus}</b> 分。
              </p>
              <div class="row gap3 mt5" style="flex-wrap:wrap">
                ${t.checkin
    ? `<button class="btn lg" disabled>${I('okc', 17)} 已签到</button>`
    : `<button class="btn pri lg" data-act="checkin">${I('flame', 17)} 立即签到</button>`}
                <button class="btn lg" data-act="openTpl">${I('layers', 16)} 习惯模板</button>
              </div>
            </div>
            <div class="col" style="align-items:center;gap:10px">
              ${C.ring(pct(t.done, t.total), { size: 124, stroke: 11, label: '今日任务',
    big: t.done + '/' + t.total, unit: '', from: '#10B981', to: '#34D399' })}
              <div class="tiny dim2">${t.allClear ? '今天全清，干得漂亮' : `还差 ${t.total - t.done} 项就全清了`}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 任务清单 -->
      <div class="card">
        <div class="card-h">
          <h3>${I('check', 16)} 今天的任务 <span class="hsub">完成一项 +1 分</span></h3>
          <div class="row gap2">
            <button class="btn sm" data-act="addTask">${I('plus', 14)} 加一条</button>
          </div>
        </div>
        <div class="card-b" style="padding:6px 20px 10px">
          ${t.tasks.length ? `<div class="tlist">${t.tasks.map((x) => `
            <div class="titem ${x.status === 'done' ? 'done' : ''}" data-tid="${x.id}">
              <div class="tck ${x.status === 'done' ? 'done' : ''}" data-act="toggleTask" data-id="${x.id}"
                role="checkbox" aria-checked="${x.status === 'done'}" tabindex="0">${I('check', 13)}</div>
              <div class="grow">
                <div class="tt">${esc(x.title)}</div>
                <div class="tsub">
                  <span class="tag ${x.category === 'study' ? 'brand' : 'line'}" style="padding:1px 7px">${esc(CAT_NAME[x.category] || '其他')}</span>
                  ${x.est_min ? ` · 约 ${x.est_min} 分钟` : ''}
                  ${x.status === 'done' && x.txid ? ` · 已上链 ${txLink(x.txid)}` : ''}
                  ${x.status === 'skip' ? ' · 已跳过' : ''}
                </div>
              </div>
              <div class="tact">
                ${x.status === 'done' ? `<button class="btn sm ghost" data-act="undoTask" data-id="${x.id}">撤销</button>`
    : `<button class="btn sm ghost" data-act="skipTask" data-id="${x.id}">跳过</button>
                     <button class="btn sm ghost" data-act="delTask" data-id="${x.id}">${I('trash', 13)}</button>`}
              </div>
            </div>`).join('')}</div>`
    : `<div class="empty">${I('layers', 38)}<b>今天还没有任务</b>
          <span class="small">点右上角「加一条」，或者用「习惯模板」批量铺一份</span>
          <div class="mt4"><button class="btn pri" data-act="openTpl">用习惯模板生成</button></div></div>`}
        </div>
      </div>

      <!-- 近 7 天 -->
      <div class="card">
        <div class="card-h"><h3>${I('chart', 16)} 最近 14 天</h3>
          <a class="small" href="#/data">看完整数据 ${I('right', 12)}</a></div>
        <div class="card-b" id="miniChart">${skel(150)}</div>
      </div>
    </div>

    <div class="col gap4" style="gap:18px">
      <!-- 积分卡 -->
      <div class="card pad">
        <div class="row-b mb3"><span class="small dim2">我的积分</span>
          <span class="tag brand">Lv.${u.level} ${LEVEL_NAME[u.level] || ''}</span></div>
        <div style="font-size:36px;font-weight:800;letter-spacing:-.035em;line-height:1.1" class="num">
          ${n(u.balance)}<em style="font-size:14px;font-weight:600;color:var(--txt-3);font-style:normal"> 分</em></div>
        <div class="mt3">${C.levelBar(u.level, u.exp, S.user.levelStep || 500)}</div>
        <div class="grid g2 mt5" style="gap:10px">
          <div><div class="tiny dim2">累计获得</div><b class="num" style="color:var(--ok)">+${n(u.earned)}</b></div>
          <div><div class="tiny dim2">累计消耗</div><b class="num" style="color:var(--streak)">−${n(u.spent)}</b></div>
          <div><div class="tiny dim2">押注冻结</div><b class="num">${n(u.frozen)}</b></div>
          <div><div class="tiny dim2">全站排名</div><b class="num">第 ${n(u.rank)} 名</b></div>
        </div>
        <div class="mt5 small dim2 row gap2">${I('link', 13)} 链上地址
          <a class="hash" href="#/addr/${esc(u.addr)}">${esc(shortHash(u.addr, 10, 6))}</a></div>
      </div>

      <!-- 连续天数 -->
      <div class="card pad" style="background:linear-gradient(150deg,#FFF9EE,#FFFDF8);border-color:#F7E3BD">
        <div class="row-b">
          <span class="small" style="color:#A15C07;font-weight:600">连续签到</span>
          ${I('flame', 20, 'style="color:#F59E0B"')}
        </div>
        <div style="font-size:42px;font-weight:800;letter-spacing:-.04em;color:#B45309;line-height:1.05" class="num">
          ${u.streak}<em style="font-size:15px;font-style:normal;font-weight:600"> 天</em></div>
        <div class="small mt2" style="color:#A15C07">历史最长 ${u.max_streak} 天 · 累计签到 ${u.checkin_days} 天</div>
        <div class="prog streak mt4" style="background:rgba(245,158,11,.18)">
          <i style="width:${Math.min(100, Math.round(u.streak / Math.max(1, u.max_streak) * 100))}%"></i></div>
        <div class="tiny mt2" style="color:#A15C07">
          ${u.streak >= u.max_streak && u.streak > 0
    ? '已经追平历史最长，别停' : `再坚持 ${u.max_streak - u.streak} 天就破纪录`}
        </div>
      </div>

      <!-- 今日公告 -->
      <div class="card">
        <div class="card-h"><h3>${I('bell', 16)} 平台公告</h3></div>
        <div class="card-b" style="padding:8px 20px" id="annoBox">${skel(60)}</div>
      </div>
    </div>
  </div>`;
  paintMini();
  loadAnnouncements();
}

async function paintMini() {
  const box = $('#miniChart');
  if (!box) return;
  try {
    const s = await A.summary();
    const days = [];
    const map = new Map(s.curve.map((r) => [String(r.day).slice(5), r]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = map.get(k);
      days.push({ x: k, a: r ? Number(r.inflow) : 0, b: r ? Number(r.outflow) : 0 });
    }
    box.innerHTML = C.area2(days, { height: 160 });
  } catch (e) { box.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; }
}

async function loadAnnouncements() {
  const box = $('#annoBox');
  if (!box) return;
  try {
    const r = await A.announcements();
    box.innerHTML = r.list.slice(0, 4).map((a) => `
      <div class="row gap3" style="padding:11px 0;border-bottom:1px solid var(--line)">
        <span class="dot ${a.pinned ? 'warn' : 'idle'}" style="margin-top:6px"></span>
        <div class="grow" style="min-width:0">
          <div class="small bold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title)}</div>
          <div class="tiny dim2">${esc(ago(a.created_at))} · ${esc(a.author || '平台')}</div>
        </div>
      </div>`).join('') || empty('暂时没有公告', '', 'bell');
  } catch (e) { box.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; }
}

/* ============================ 数据看板 ============================ */
async function viewData() {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin('才能看自己的数据'); return; }
  root.innerHTML = `<div class="grid g2">${skel(200)}${skel(200)}</div>`;
  const [hm, s, cs] = await Promise.all([A.heatmap(84), A.summary(), A.checkins(60)]);
  const u = S.user;
  const inflow = s.byType.map((x) => ({ label: TYPE_NAME[x.type] || x.type, v: Number(x.amt), color: colorOfType(x.type) }));

  root.innerHTML = `
  <div class="kgrid mb5">
    ${stat('完成率（近 14 天）', s.rate + '<em>%</em>', `完成 ${n(s.tasks.done)} / ${n(s.tasks.total)} 项`)}
    ${stat('累计签到', n(u.checkin_days) + '<em>天</em>', `历史最长连续 ${u.max_streak} 天`)}
    ${stat('累计完成', n(u.task_done) + '<em>项</em>', `全清 ${u.day_clear} 天`)}
    ${stat('持有徽章', n(u.badge_count) + '<em>枚</em>', `链上凭证可验真`)}
  </div>

  <div class="grid g-2-1">
    <div class="col gap4" style="gap:18px">
      <div class="card">
        <div class="card-h"><h3>${I('calendar', 16)} 签到热力图</h3>
          <span class="hsub">近 84 天 · 颜色越深表示当天任务完成得越满</span></div>
        <div class="card-b" style="overflow:auto">${C.heatmap(hm.list, { days: 84 })}</div>
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('chart', 16)} 积分进出（近 14 天）</h3></div>
        <div class="card-b">${s.curve.length ? C.area2(s.curve.map((r) => ({
    x: String(r.day).slice(5), a: Number(r.inflow), b: Number(r.outflow),
  })), { height: 200 }) : empty('最近没有积分流动')}</div>
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('coin', 16)} 积分来源构成</h3></div>
        <div class="card-b">${inflow.length ? C.donut(inflow, { center: n(u.earned), centerLabel: '累计获得' }) : empty('还没有积分入账')}</div>
      </div>
    </div>
    <div class="col gap4" style="gap:18px">
      <div class="card pad">
        <h3 class="mb4">${I('zap', 16)} 你最近的状态</h3>
        <div class="step-list">
          <div class="st ok"><div class="st-n">1</div><div><b class="small">做得最好的一天</b>
            <div class="small dim mt1">${s.best ? `${esc(String(s.best.day).slice(0, 10))} · 完成 ${s.best.n} 项` : '暂无数据'}</div></div></div>
          <div class="st bad"><div class="st-n">2</div><div><b class="small">最需要补的一天</b>
            <div class="small dim mt1">${s.worst && Number(s.worst.total)
    ? `${esc(String(s.worst.day).slice(0, 10))} · 只完成 ${s.worst.done}/${s.worst.total} 项` : '暂无数据'}</div></div></div>
          <div class="st"><div class="st-n">3</div><div><b class="small">消耗去向</b>
            <div class="small dim mt1">${s.spend.length
    ? s.spend.map((x) => `${TYPE_NAME[x.type] || x.type} ${n(x.amt)} 分`).join(' · ') : '还没花过积分'}</div></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('clock', 16)} 签到时间分布</h3></div>
        <div class="card-b" id="ckHours">${skel(60)}</div>
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('flame', 16)} 最近 30 次签到</h3></div>
        <div class="card-b flush"><div class="tbl-wrap" style="max-height:300px"><table class="tbl">
          <thead><tr><th>日期</th><th class="r">得分</th><th class="c">连续</th><th>交易</th></tr></thead>
          <tbody>${cs.list.slice(0, 30).map((c) => `<tr>
            <td class="t-main">${esc(String(c.day).slice(5))}</td>
            <td class="r num">+${c.total_points}</td>
            <td class="c"><span class="tag warn">${c.streak_after} 天</span></td>
            <td>${c.txid ? txLink(c.txid) : '—'}</td></tr>`).join('')}</tbody>
        </table></div></div>
      </div>
    </div>
  </div>`;
  // 签到时间分布（0-23 点）
  const hours = new Map();
  cs.list.forEach((c) => {
    const h = new Date(String(c.created_at).replace(' ', 'T')).getHours();
    hours.set(h, (hours.get(h) || 0) + 1);
  });
  const box = $('#ckHours');
  if (box) {
    box.innerHTML = C.hourHeat(Array.from({ length: 24 }, (_, h) => ({ h, n: hours.get(h) || 0 })),
      { hint: '凌晨签到少、早上多，说明这个平台的人还挺自律' });
  }
}

function colorOfType(t) {
  return { checkin: '#F59E0B', task: '#10B981', daybonus: '#5B6CFF', settle: '#8B5CF6',
    badge: '#0EA5E9', redeem: '#F43F5E', donate: '#EC4899' }[t] || '#64748B';
}

/* ============================ 积分明细 ============================ */
async function viewLedger(q = {}) {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin(); return; }
  root.innerHTML = skel(300);
  const page = Number(q.page) || 1;
  const type = q.type || '';
  const [r, rec] = await Promise.all([A.ledger({ page, size: 20, type }), A.reconcile()]);
  root.innerHTML = `
  <div class="grid g-2-1 mb5">
    <div class="card pad">
      <div class="row-b" style="flex-wrap:wrap">
        <div>
          <div class="small dim2">积分余额（业务流水汇总）</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:-.03em" class="num">${n(rec.statsBal)}
            <em style="font-size:13px;font-weight:600;color:var(--txt-3);font-style:normal">分</em></div>
        </div>
        <div class="col gap2" style="align-items:flex-end">
          <span class="tag ${rec.okStatsVsChain && rec.okLedgerVsStats ? 'ok' : 'bad'}">
            ${I(rec.okStatsVsChain && rec.okLedgerVsStats ? 'okc' : 'xc', 13)}
            ${rec.okStatsVsChain && rec.okLedgerVsStats ? '三方对账一致' : '对账存在差异'}</span>
          <span class="tiny dim2">${I('link', 11)} 链上余额 ${n(rec.chainBal)} · 待打包 ${n(rec.pendingNet)}</span>
        </div>
      </div>
      <div class="grid g3 mt5" style="gap:12px">
        <div><div class="tiny dim2">流水入账</div><b class="num" style="color:var(--ok)">+${n(rec.ledgerInflow)}</b></div>
        <div><div class="tiny dim2">流水出账</div><b class="num" style="color:var(--streak)">−${n(rec.ledgerOutflow)}</b></div>
        <div><div class="tiny dim2">流水条数</div><b class="num">${n(rec.ledgerRows)}</b></div>
      </div>
      <div class="alert info mt5" style="align-items:flex-start">${I('info', 15)}
        <div class="grow small">
          每一笔积分都对应一笔链上交易。这里看到的余额是从流水实时算出来的，
          <b>不是</b>一个可以随手改的字段 —— 有人绕过引擎改数据库，这三行数字立刻就对不上。
        </div></div>
    </div>
    <div class="card pad">
      <h3 class="mb4">${I('coins', 0) || ''}流水类型</h3>
      ${C.hbars(r.byType.filter((x) => Number(x.direction) === 1).map((x) => ({
    label: TYPE_NAME[x.type] || x.type, v: Number(x.amt), color: colorOfType(x.type),
  })), { unit: '' }) || empty('暂无')}
      <a class="btn block mt4" href="#/reconcile">${I('scale', 15)} 看完整对账</a>
    </div>
  </div>
  <div class="card">
    <div class="card-h">
      <h3>${I('layers', 16)} 积分明细</h3>
      <div class="row gap2">
        <button class="chip ${!type ? 'on' : ''}" data-act="lfilter" data-t="">全部</button>
        ${['checkin', 'task', 'daybonus', 'badge', 'redeem', 'donate', 'settle'].map((t) =>
    `<button class="chip ${type === t ? 'on' : ''}" data-act="lfilter" data-t="${t}">${TYPE_NAME[t]}</button>`).join('')}
      </div>
    </div>
    <div class="card-b flush">
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>时间</th><th>类型</th><th>说明</th><th class="r">变动</th><th class="r">余额</th><th>区块</th><th>交易号</th></tr></thead>
        <tbody>${r.list.map((x) => `<tr>
          <td class="nowrap small">${esc(dt(x.created_at))}</td>
          <td><span class="tag ${x.direction > 0 ? 'ok' : 'warn'}">${esc(TYPE_NAME[x.type] || x.type)}</span></td>
          <td class="small dim">${esc(x.memo || '—')}</td>
          <td class="r num bold" style="color:${x.direction > 0 ? 'var(--ok)' : 'var(--streak)'}">
            ${x.direction > 0 ? '+' : '−'}${n(x.amount)}</td>
          <td class="r num dim">${n(x.balance_after)}</td>
          <td>${x.block_height === null || x.block_height === undefined
    ? '<span class="tag line">待打包</span>'
    : `<a class="hash" href="#/block/${x.block_height}">#${x.block_height}</a>`}</td>
          <td>${x.txid ? txLink(x.txid, shortHash(x.txid, 8, 5)) : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="pager">
        <span>共 ${n(r.total)} 条 · 第 ${page} 页</span>
        <div class="row gap2">
          <button class="btn sm" data-act="lpage" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${I('left', 13)} 上一页</button>
          <button class="btn sm" data-act="lpage" data-p="${page + 1}" ${page * 20 >= r.total ? 'disabled' : ''}>下一页 ${I('right', 13)}</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================ 徽章 ============================ */
async function viewBadges() {
  const root = $('#view');
  const r = await A.badges();
  const mine = await (S.user ? A.claims() : Promise.resolve({ list: [] }));
  const owned = r.list.filter((b) => b.owned);
  const groups = {};
  r.list.forEach((b) => { (groups[b.category] = groups[b.category] || []).push(b); });
  const CAT = { streak: '坚持', points: '积累', task: '行动', team: '同行', special: '特别' };

  root.innerHTML = `
  <div class="kgrid mb5">
    ${stat('已获得徽章', n(r.owned) + '<em>枚</em>', `共 ${r.list.length} 枚可收集`)}
    ${stat('链上凭证', n(mine.list.length) + '<em>张</em>', '全部可在验真页查询')}
    ${stat('可铸造', n(r.list.filter((b) => b.eligible && !b.owned).length) + '<em>枚</em>', '条件已达成')}
    ${stat('我的积分', n(r.balance) + '<em>分</em>', '铸造消耗的积分会进销毁账户', 'accent')}
  </div>
  ${S.user ? '' : `<div class="alert info mb5">${I('info', 15)}<div>登录后可以看到每枚徽章的达成进度，并把它们铸造成链上凭证。</div></div>`}
  ${Object.keys(groups).map((cat) => `
    <div class="card mb5">
      <div class="card-h"><h3>${I('trophy', 16)} ${esc(CAT[cat] || cat)}徽章
        <span class="hsub">${groups[cat].filter((b) => b.owned).length} / ${groups[cat].length}</span></h3></div>
      <div class="card-b">
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:14px">
          ${groups[cat].map((b) => badgeTile(b)).join('')}
        </div>
      </div>
    </div>`).join('')}

  ${owned.length ? `<div class="card">
    <div class="card-h"><h3>${I('key', 16)} 我的成就凭证</h3>
      <span class="hsub">每张都是链上一笔交易，带 Merkle 证明</span></div>
    <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>凭证号</th><th>徽章</th><th>验真码</th><th>铸造时间</th><th>区块</th><th>交易号</th><th></th></tr></thead>
      <tbody>${mine.list.map((c) => `<tr>
        <td class="mono small">${esc(c.serial)}</td>
        <td class="t-main">${esc(c.badge_name)}</td>
        <td><span class="mono small bold" style="color:var(--brand-ink)">${esc(c.verify_code)}</span></td>
        <td class="small dim">${esc(dt(c.claimed_at))}</td>
        <td><a class="hash" href="#/block/${c.block_height}">#${c.block_height}</a></td>
        <td>${txLink(c.txid, shortHash(c.txid, 8, 5))}</td>
        <td><a class="btn sm" href="#/verify?code=${esc(c.verify_code)}" target="_blank">${I('scan', 13)} 验真</a></td>
      </tr>`).join('')}</tbody>
    </table></div></div>
  </div>` : ''}`;
}

function badgeTile(b) {
  const lvCls = b.level === 4 ? 'l4' : b.level === 3 ? 'l3' : '';
  const stars = Array.from({ length: b.level }, () => I('star', 10)).join('');
  return `<div class="badge-tile ${b.owned ? 'owned' : ''} ${b.eligible ? '' : 'locked'}" data-badge="${b.id}">
    ${b.owned ? `<div class="owned-mark tag ok">${I('okc', 11)} 已获得</div>` : ''}
    <div class="badge-ico ${lvCls}" style="background:linear-gradient(135deg,${esc(b.color)},${esc(b.color)}cc)">
      ${I(b.icon, 25)}</div>
    <div class="bn">${esc(b.name)}</div>
    <div class="bc">${esc(b.cond_text)}</div>
    <div class="row" style="justify-content:center;gap:5px">
      <span class="tag line">${LEVEL_NAME[b.level]}</span>
      <span class="lv-star" style="color:${esc(b.color)}">${stars}</span>
    </div>
    <div class="bf">
      ${b.owned
    ? `<span class="small dim2">全站已发 ${n(b.claimed_count)} 枚</span>`
    : b.eligible
      ? `<button class="btn sm pri" data-act="claim" data-id="${b.id}">${I('hammer', 13)} 铸造${b.cost ? ` · ${b.cost} 分` : ' · 免费'}</button>`
      : `<span class="small dim2" style="line-height:1.4">${esc(b.why || '')}</span>`}
    </div>
  </div>`;
}

/* ============================ 商城 ============================ */
async function viewShop(cat) {
  const root = $('#view');
  root.innerHTML = skel(300);
  const r = await A.rewards(cat);
  const CATS = [['', '全部'], ['coupon', '券码'], ['course', '课程'], ['goods', '实物'], ['virtual', '虚拟'], ['charity', '公益']];
  root.innerHTML = `
  <div class="row-b mb4" style="flex-wrap:wrap;gap:14px">
    <div class="row gap2" style="flex-wrap:wrap">
      ${CATS.map(([k, v]) => `<button class="chip ${((cat || '') === k) ? 'on' : ''}" data-act="shopcat" data-c="${k}">${v}</button>`).join('')}
    </div>
    <div class="row gap3">
      <span class="small dim2">可兑换余额</span>
      <b class="num" style="font-size:18px;color:var(--brand-ink)">${n(r.balance)} 分</b>
    </div>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:16px">
    ${r.list.map((w) => {
    const can = r.balance >= Number(w.cost) && Number(w.stock) > 0 && Number(w.my_qty) < Number(w.per_limit);
    return `<div class="rw-card">
        <div class="rw-cover" style="background:linear-gradient(135deg,${esc(w.cover_color)},${esc(w.cover_color)}aa)">
          ${esc(DIR_NAME[w.category] || '奖励')}</div>
        <div class="rw-body">
          <div class="bold" style="font-size:13.5px;line-height:1.4">${esc(w.name)}</div>
          <div class="tiny dim2">${esc(w.descr || '')}</div>
          <div class="row-b" style="margin-top:auto">
            <span class="rw-cost">${n(w.cost)}<em> 分</em></span>
            <span class="tiny ${Number(w.stock) > 10 ? 'dim2' : 'bold'}"
              style="${Number(w.stock) <= 10 ? 'color:var(--bad)' : ''}">
              剩 ${n(w.stock)}</span>
          </div>
          <button class="btn ${can ? 'pri' : ''} block sm" data-act="redeem" data-id="${w.id}" ${can ? '' : 'disabled'}>
            ${Number(w.stock) <= 0 ? '已兑完'
    : Number(w.my_qty) >= Number(w.per_limit) ? `已兑 ${w.my_qty}/${w.per_limit}`
      : r.balance < Number(w.cost) ? `还差 ${n(Number(w.cost) - r.balance)} 分` : '立即兑换'}
          </button>
        </div>
      </div>`;
  }).join('')}
  </div>
  <div class="alert info mt5">${I('info', 15)}
    <div>兑换消耗的积分会转到<b>销毁账户</b>，链上可查 —— 也就是说这个平台的积分是通缩的，
    发行了多少、烧掉了多少，任何人都能对账。</div></div>`;
  await paintOrders(root);
}

async function paintOrders(root) {
  if (!S.user) return;
  try {
    const r = await A.redemptions();
    if (!r.list.length) return;
    const box = document.createElement('div');
    box.className = 'card mt5';
    box.innerHTML = `<div class="card-h"><h3>${I('gift', 16)} 我的兑换记录</h3></div>
      <div class="card-b flush"><div class="tbl-wrap" style="max-height:340px"><table class="tbl">
        <thead><tr><th>订单号</th><th>商品</th><th class="r">消耗</th><th>状态</th><th>时间</th><th>交易号</th></tr></thead>
        <tbody>${r.list.map((x) => `<tr>
          <td class="mono small">${esc(x.order_no)}</td>
          <td class="t-main">${esc(x.reward_name)}</td>
          <td class="r num">−${n(x.cost)}</td>
          <td><span class="tag ${x.status === 'done' ? 'ok' : x.status === 'cancel' ? 'line' : 'brand'}">${
    { paid: '已支付', shipped: '已发货', done: '已完成', cancel: '已取消' }[x.status] || x.status}</span></td>
          <td class="small dim">${esc(dt(x.created_at))}</td>
          <td>${txLink(x.txid, shortHash(x.txid, 8, 5))}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
    root.appendChild(box);
  } catch (e) { /* 忽略 */ }
}

/* ============================ 押注 ============================ */
async function viewStake() {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin('才能押注'); return; }
  root.innerHTML = skel(240);
  const r = await A.stakes();
  const running = r.list.filter((s) => s.status === 'running');
  const won = r.list.filter((s) => s.status === 'won');
  root.innerHTML = `
  <div class="grid g-2-1 mb5">
    <div class="card pad">
      <h3 class="mb3">${I('target', 17)} 押注自己的目标</h3>
      <p class="small dim mb4">把积分押在一件你想做成的事上。做到了，从奖池里双倍拿回来；
      没做到，本金进奖池，分给其他做到的人。<b>这不是赌博，是把「嘴上说说」变成「有代价的承诺」。</b></p>
      <div class="grid g4" style="gap:10px">
        <div><div class="tiny dim2">进行中</div><b class="num" style="font-size:20px">${running.length}</b></div>
        <div><div class="tiny dim2">已达成</div><b class="num" style="font-size:20px;color:var(--ok)">${won.length}</b></div>
        <div><div class="tiny dim2">冻结积分</div><b class="num" style="font-size:20px">${n(S.user.frozen)}</b></div>
        <div><div class="tiny dim2">奖池余额</div><b class="num" style="font-size:20px;color:var(--brand-ink)">${n(S.pool || 0)}</b></div>
      </div>
      <button class="btn pri lg mt5" data-act="newStake">${I('plus', 16)} 新建一笔押注</button>
    </div>
    <div class="card pad" style="background:linear-gradient(150deg,#F5F3FF,#FDFCFF);border-color:#E2DDFB">
      <h3 class="mb3">${I('scale', 17)} 奖池从哪来</h3>
      <p class="small dim">押注失败的本金不会消失 —— 它留在奖池账户（CJPOOL），
      结算时发给达成目标的人。链上每一笔进出都能查到。</p>
      <a class="btn block mt4" href="#/addr/CJPOOL">${I('cube', 15)} 看奖池账户明细</a>
    </div>
  </div>
  ${r.list.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
    ${r.list.map((s) => {
    const p = pct(s.done_count, s.need_count);
    const end = new Date(String(s.end_day).slice(0, 10) + 'T23:59:59');
    const leftDays = Math.ceil((end - Date.now()) / 86400000);
    return `<div class="card pad">
      <div class="row-b mb3">
        <span class="tag ${s.status === 'won' ? 'ok' : s.status === 'lost' ? 'bad' : 'brand'}">${
      { running: '进行中', won: '已达成', lost: '未达成', cancel: '已取消' }[s.status]}</span>
        <span class="small dim2">${esc(String(s.start_day).slice(5))} → ${esc(String(s.end_day).slice(5))}</span>
      </div>
      <div class="bold" style="font-size:14.5px">${esc(s.title)}</div>
      <div class="row-b mt4 small dim">
        <span>进度 ${s.done_count} / ${s.need_count} 次</span>
        <span>押 ${n(s.amount)} 分 · ${s.odds} 倍</span>
      </div>
      <div class="prog ${s.status === 'won' ? 'ok' : s.status === 'lost' ? 'bad' : ''} mt3"><i style="width:${Math.min(100, p)}%"></i></div>
      <div class="row-b mt4">
        <span class="tiny dim2">${s.status === 'running'
      ? (leftDays > 0 ? `还剩 ${leftDays} 天` : '已到期，等结算') : (s.status === 'won'
        ? `返还 ${n(Math.round(s.amount * s.odds))} 分` : '本金已进奖池')}</span>
        <div class="row gap2">
          ${s.status === 'running'
      ? `<button class="btn sm" data-act="bumpStake" data-id="${s.id}">+1 次</button>
             <button class="btn sm pri" data-act="settleStake" data-id="${s.id}">结算</button>` : ''}
          ${s.stake_txid ? txLink(s.stake_txid, '押注') : ''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>` : empty('还没有押注', '选一件你一直想做却没做成的事，押上去', 'target')}`;
}

/* ============================ 自习室 ============================ */
async function viewTeam(id) {
  const root = $('#view');
  if (id) {
    root.innerHTML = skel(300);
    const r = await A.team(id);
    const t = r.team;
    root.innerHTML = `
    <div class="row-b mb4" style="flex-wrap:wrap;gap:12px">
      <div><h1 style="font-size:24px">${esc(t.name)}</h1>
        <div class="dim mt2 small">${esc(t.slogan || '')} · 目标「${esc(t.goal || '—')}」</div></div>
      <div class="row gap3">
        <span class="tag brand">邀请码 ${esc(t.join_code)}</span>
        <button class="btn sm" data-copy="${esc(t.join_code)}">${I('copy', 13)} 复制</button>
      </div>
    </div>
    <div class="kgrid mb5">
      ${stat('成员', t.member_count + '<em>人</em>', `上限 ${t.max_member} 人`)}
      ${stat('队伍总分', n(t.total_points) + '<em>分</em>', `房主 ${esc(t.owner_name)}`)}
      ${stat('今日打卡率', t.checkin_rate + '<em>%</em>', '队里今天签到的人占比')}
      ${stat('本周贡献', n(r.members.reduce((a, b) => a + Number(b.week_points), 0)) + '<em>分</em>', '全员合计')}
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('users', 16)} 成员排行</h3></div>
      <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th class="c">#</th><th>成员</th><th>链上地址</th><th class="r">积分</th><th class="c">连续</th>
          <th class="c">徽章</th><th class="c">本周</th><th class="c">今日</th></tr></thead>
        <tbody>${r.members.map((m, i) => `<tr>
          <td class="c"><b>${i + 1}</b></td>
          <td><span class="row gap2"><span class="ava sm">${esc(m.nickname.slice(0, 2))}</span>
            <span class="t-main">${esc(m.nickname)}</span>
            ${m.role === 'owner' ? '<span class="tag brand">房主</span>' : ''}</span></td>
          <td><a class="hash" href="#/addr/${esc(m.addr)}">${esc(shortHash(m.addr, 8, 5))}</a></td>
          <td class="r num">${n(m.balance)}</td>
          <td class="c"><span class="tag warn">${m.streak} 天</span></td>
          <td class="c num">${m.badge_count}</td>
          <td class="c num">${n(m.week_points)}</td>
          <td class="c">${Number(m.checked_today) ? `<span class="dot ok"></span>` : `<span class="dot idle"></span>`}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>
    </div>`;
    return;
  }
  root.innerHTML = skel(300);
  const r = await A.teams();
  root.innerHTML = `
  <div class="row-b mb4" style="flex-wrap:wrap;gap:12px">
    <div class="row gap2">
      <button class="btn" data-act="joinTeam">${I('key', 15)} 用邀请码加入</button>
      <button class="btn pri" data-act="newTeam">${I('plus', 15)} 建一个自习室</button>
    </div>
    <span class="small dim2">共 ${r.list.length} 个自习室 · 按队伍总分排序</span>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
    ${r.list.map((t) => `<div class="team-card" data-act="openTeam" data-id="${t.id}">
      <div class="row-b">
        <div class="bold" style="font-size:14.5px">${esc(t.name)}</div>
        ${t.joined ? '<span class="tag ok">已加入</span>' : ''}
      </div>
      <div class="small dim mt2">${esc(t.slogan || '')}</div>
      <div class="row-b mt4">
        <span class="tag line">${esc(t.goal || '—')}</span>
        <span class="small dim2">${t.member_count}/${t.max_member} 人</span>
      </div>
      <div class="row-b mt4">
        <div class="team-avas">${Array.from({ length: Math.min(5, t.member_count) }, (_, i) =>
    `<span class="ava sm" style="background:linear-gradient(135deg,hsl(${(i * 47 + 220) % 360} 70% 62%),hsl(${(i * 47 + 260) % 360} 70% 66%))">·</span>`).join('')}
        </div>
        <div style="text-align:right">
          <div class="bold num">${n(t.total_points)} 分</div>
          <div class="tiny dim2">今日打卡 ${t.checkin_rate}%</div>
        </div>
      </div>
      <div class="prog mt3" style="height:5px"><i style="width:${Math.min(100, t.checkin_rate)}%"></i></div>
    </div>`).join('')}
  </div>`;
}

/* ============================ 榜单 ============================ */
async function viewRank(type = 'points') {
  const root = $('#view');
  root.innerHTML = skel(300);
  const r = await A.leaderboard(type);
  const TYPES = [['points', '积分榜'], ['streak', '连续榜'], ['tasks', '行动榜'], ['badges', '徽章榜']];
  const medal = ['#F59E0B', '#94A3B8', '#B45309'];
  root.innerHTML = `
  <div class="row-b mb4">
    <div class="seg">${TYPES.map(([k, v]) =>
    `<button class="${type === k ? 'on' : ''}" data-act="rankType" data-t="${k}">${v}</button>`).join('')}</div>
    <span class="small dim2">数据来自链上交易汇总，不是手工维护的表</span>
  </div>
  <div class="card">
    <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th class="c" style="width:60px">名次</th><th>用户</th><th>目标</th>
        <th class="r">积分</th><th class="c">连续</th><th class="c">最长</th><th class="c">完成任务</th>
        <th class="c">徽章</th><th class="c">等级</th><th>链上地址</th></tr></thead>
      <tbody>${r.list.map((x, i) => `<tr>
        <td class="c">${i < 3
    ? `<span style="display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;
        background:${medal[i]};color:#fff;font-weight:800;font-size:12px">${i + 1}</span>`
    : `<b class="dim">${i + 1}</b>`}</td>
        <td><span class="row gap2"><span class="ava sm">${esc(x.nickname.slice(0, 2))}</span>
          <span><span class="t-main">${esc(x.nickname)}</span>
          <span class="t-sub">${esc(x.city || '')}</span></span></span></td>
        <td class="small dim">${esc(x.goal || '—')}</td>
        <td class="r num bold">${n(x.balance)}</td>
        <td class="c"><span class="tag warn">${x.streak}</span></td>
        <td class="c num dim">${x.max_streak}</td>
        <td class="c num">${n(x.task_done)}</td>
        <td class="c num">${x.badge_count}</td>
        <td class="c"><span class="tag brand">Lv.${x.level}</span></td>
        <td><a class="hash" href="#/addr/${esc(x.addr)}">${esc(shortHash(x.addr, 8, 5))}</a></td>
      </tr>`).join('')}</tbody>
    </table></div></div>
  </div>`;
}

/* ============================ 公益 ============================ */
async function viewDonate() {
  const root = $('#view');
  root.innerHTML = skel(240);
  const r = await A.donations();
  const TOPICS = ['乡村图书角', '荒漠护林计划', '山区儿童早餐', '流浪动物救助', '社区老人送餐',
    '乡村学校护眼灯', '听障儿童助听', '一小时支教课', '乡村儿童羽绒服', '城市绿化认养'];
  root.innerHTML = `
  <div class="grid g-2-1 mb5">
    <div class="card pad">
      <h3 class="mb3">${I('heart', 17)} 把积分捐出去</h3>
      <p class="small dim mb4">积分换来的东西终归会腻，捐出去不会。
      捐赠记录会写到链上，平台按 10% 配捐 —— 你捐 50 分，实际到账 55 分。</p>
      <div class="row gap2 mb4" style="flex-wrap:wrap">
        ${TOPICS.slice(0, 6).map((t) => `<button class="chip" data-act="pickTopic" data-t="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <button class="btn pri lg" data-act="donate">${I('heart', 16)} 我要捐赠</button>
    </div>
    <div class="card pad">
      <h3 class="mb3">${I('chart', 17)} 累计公益</h3>
      <div style="font-size:34px;font-weight:800;letter-spacing:-.03em" class="num">${n(r.total.amt)}
        <em style="font-size:13px;font-style:normal;font-weight:600;color:var(--txt-3)">分</em></div>
      <div class="small dim mt2">共 ${n(r.total.n)} 笔 · 平台配捐 ${n(r.total.match_amt)} 分</div>
      <div class="mt5">${r.byTopic.length ? C.hbars(r.byTopic.map((x) => ({
    label: x.topic, v: Number(x.amt), color: 'linear-gradient(90deg,#EC4899,#F472B6)',
  })), { unit: '' }) : empty('还没有捐赠')}</div>
    </div>
  </div>
  <div class="card">
    <div class="card-h"><h3>${I('layers', 16)} 捐赠公示（链上可查）</h3>
      <span class="hsub">按时间倒序，每笔都对应一笔链上交易</span></div>
    <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>捐赠人</th><th>方向</th><th class="r">捐赠</th><th class="r">配捐</th><th>留言</th><th>交易号</th></tr></thead>
      <tbody>${r.list.map((d) => `<tr>
        <td class="small nowrap">${esc(dt(d.created_at))}</td>
        <td class="t-main">${esc(d.nickname)}</td>
        <td><span class="tag" style="background:#FDF0F6;color:#BE185D">${esc(d.topic)}</span></td>
        <td class="r num">${n(d.amount)}</td>
        <td class="r num dim">+${n(d.match_amount)}</td>
        <td class="small dim">${esc(d.message || '—')}</td>
        <td>${txLink(d.txid, shortHash(d.txid, 8, 5))}</td></tr>`).join('')}</tbody>
    </table></div></div>
  </div>`;
}

/* ============================ 我的（含密钥与对账） ============================ */
async function viewMine() {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin(); return; }
  const u = S.user;
  const [rec, ck] = await Promise.all([A.reconcile(), A.checkins(60)]);
  const totalCk = ck.list.reduce((a, b) => a + Number(b.total_points), 0);
  root.innerHTML = `
  <div class="grid g-2-1">
    <div class="col gap4" style="gap:18px">
      <div class="card pad">
        <div class="row gap4" style="align-items:center;flex-wrap:wrap">
          <div class="ava lg">${esc(u.nickname.slice(0, 2))}</div>
          <div class="grow">
            <div class="row gap3"><h1 style="font-size:22px">${esc(u.nickname)}</h1>
              <span class="tag brand">Lv.${u.level}</span>
              <span class="tag ${u.role === 'user' ? 'line' : 'warn'}">${
    { user: '用户', operator: '运营', admin: '管理员' }[u.role]}</span></div>
            <div class="dim small mt2">${esc(u.bio || '这个人很低调')}</div>
            <div class="small dim2 mt2">${I('user', 12)} ${esc(u.username)} ·
              ${esc(u.city || '未填')} · 注册于 ${esc(String(u.created_at).slice(0, 10))}</div>
          </div>
        </div>
        ${u.goal ? `<div class="alert info mt5">${I('target', 15)}<div>我的目标：<b>${esc(u.goal)}</b></div></div>` : ''}
      </div>

      <div class="card">
        <div class="card-h"><h3>${I('key', 16)} 我的链上身份</h3>
          <span class="hsub">注册时生成，私钥不出服务端（见下方说明）</span></div>
        <div class="card-b">
          <div class="field"><label>链上地址</label>
            <div class="row gap2"><span class="hash block grow" style="cursor:default">${esc(u.addr)}</span>
              <button class="btn sm" data-copy="${esc(u.addr)}">${I('copy', 13)} 复制</button></div>
            <div class="help">地址 = «CJ» + sha256(公钥) 的前 30 位十六进制。CJ 是「寸进」的缩写。</div>
          </div>
          <div class="grid g3 mt4" style="gap:12px">
            <div><div class="tiny dim2">链上余额</div><b class="num">${n(u.on_chain)}</b></div>
            <div><div class="tiny dim2">链上交易笔数</div><b class="num">${n(u.tx_count)}</b></div>
            <div><div class="tiny dim2">持有凭证</div><b class="num">${n(u.badge_count)}</b></div>
          </div>
          <div class="row gap2 mt5">
            <a class="btn" href="#/addr/${esc(u.addr)}">${I('search', 14)} 在链浏览器里看我的地址</a>
          </div>
          <div class="alert warn mt5">${I('shield', 15)}
            <div class="small">课堂演示为了方便，私钥存在服务端。真实产品里私钥应当在
              <b>客户端生成并本地保存</b>，平台只拿到公钥 —— 那才叫非托管钱包。这一条在开发文档里专门写了。</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${I('scale', 16)} 三方对账</h3></div>
        <div class="card-b">
          <div class="step-list">
            <div class="st ok"><div class="st-n">A</div><div><b class="small">业务流水汇总</b>
              <div class="small dim mt1">point_ledger 逐条加减 = <b class="num">${n(rec.ledgerNet)}</b>
                （入 ${n(rec.ledgerInflow)} − 出 ${n(rec.ledgerOutflow)}，共 ${n(rec.ledgerRows)} 条）</div></div></div>
            <div class="st ${rec.okLedgerVsStats ? 'ok' : 'bad'}"><div class="st-n">B</div>
              <div><b class="small">用户汇总余额</b>
              <div class="small dim mt1">user_stats.balance = <b class="num">${n(rec.statsBal)}</b>
                ${rec.okLedgerVsStats ? '（与 A 一致）' : `<span style="color:var(--bad)">与 A 不一致！</span>`}</div></div></div>
            <div class="st ${rec.okStatsVsChain ? 'ok' : 'bad'}"><div class="st-n">C</div>
              <div><b class="small">链上账户余额</b>
              <div class="small dim mt1">point_accounts.on_chain = <b class="num">${n(rec.chainBal)}</b>
                ＋待打包 <b class="num">${n(rec.pendingNet)}</b>（${n(rec.pendingTx)} 笔未确认）
                ${rec.okStatsVsChain ? '（与 B 一致）' : `<span style="color:var(--bad)">与 B 不一致！</span>`}</div></div></div>
          </div>
          <div class="alert ${rec.diff === 0 ? 'ok' : 'bad'} mt4">${I(rec.diff === 0 ? 'okc' : 'xc', 15)}
            <div>${rec.diff === 0
    ? '三条路径算出来的余额完全相等。说明积分只可能从引擎里产生，没有人绕过它改数据。'
    : `存在 <b>${n(rec.diff)}</b> 分的差异 —— 数据被绕过引擎改动过。`}</div></div>
        </div>
      </div>
    </div>

    <div class="col gap4" style="gap:18px">
      <div class="card pad"><h3 class="mb4">${I('zap', 16)} 我的小结</h3>
        <div class="grid g2" style="gap:12px">
          <div><div class="tiny dim2">累计签到</div><b class="num" style="font-size:20px">${n(u.checkin_days)}</b></div>
          <div><div class="tiny dim2">签到总得分</div><b class="num" style="font-size:20px">${n(totalCk)}</b></div>
          <div><div class="tiny dim2">完成任务</div><b class="num" style="font-size:20px">${n(u.task_done)}</b></div>
          <div><div class="tiny dim2">全清天数</div><b class="num" style="font-size:20px">${n(u.day_clear)}</b></div>
        </div>
        <div class="mt5">${C.levelBar(u.level, u.exp, 500)}</div>
      </div>
      <div class="card pad">
        <h3 class="mb4">${I('sort', 16)} 操作</h3>
        <div class="col gap2">
          <a class="btn block" href="#/ledger">${I('layers', 15)} 积分明细</a>
          <a class="btn block" href="#/badges">${I('trophy', 15)} 我的徽章</a>
          <a class="btn block" href="#/teams">${I('users', 15)} 我的自习室</a>
          ${u.role !== 'user' ? `<a class="btn block soft" href="/admin">${I('cpu', 15)} 进入运营管理端</a>` : ''}
          <button class="btn block danger" data-act="logout">${I('logout', 15)} 退出登录</button>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('bell', 16)} 公告</h3></div>
        <div class="card-b" style="padding:8px 20px" id="annoBox">${skel(60)}</div>
      </div>
    </div>
  </div>`;
  loadAnnouncements();
}

/* ============================ 对账页 ============================ */
async function viewReconcile() {
  const root = $('#view');
  if (!S.user) { root.innerHTML = needLogin(); return; }
  root.innerHTML = skel(300);
  const rec = await A.reconcile();
  const r = await A.ledger({ page: 1, size: 200 });
  root.innerHTML = `
  <div class="ptitle"><div><h1>三方对账</h1>
    <div class="psub">同一个余额，用三条互不相干的路径各算一遍，结果必须分毫不差</div></div>
    <button class="btn" data-act="reload">${I('refresh', 15)} 重新核对</button></div>

  <div class="grid g3 mb5">
    <div class="card pad"><div class="k small dim2">A · 业务流水</div>
      <div style="font-size:28px;font-weight:800" class="num mt2">${n(rec.ledgerNet)}</div>
      <div class="tiny dim2 mt2">${n(rec.ledgerRows)} 条流水的净额</div></div>
    <div class="card pad"><div class="k small dim2">B · 用户汇总</div>
      <div style="font-size:28px;font-weight:800" class="num mt2">${n(rec.statsBal)}</div>
      <div class="tiny dim2 mt2">${rec.okLedgerVsStats ? '✓ 与 A 一致' : '✗ 与 A 不一致'}</div></div>
    <div class="card pad"><div class="k small dim2">C · 链上账户</div>
      <div style="font-size:28px;font-weight:800" class="num mt2">${n(rec.chainBal)}</div>
      <div class="tiny dim2 mt2">+ ${n(rec.pendingNet)} 待打包 = ${n(rec.chainBal + rec.pendingNet)}</div></div>
  </div>
  <div class="alert ${rec.diff === 0 ? 'ok' : 'bad'} mb5">${I(rec.diff === 0 ? 'okc' : 'xc', 16)}
    <div>${rec.diff === 0 ? '三方一致。积分只可能从积分引擎里产生，没人绕过它改数据。'
    : `差异 ${n(rec.diff)} 分。请到管理端「对账台」查看是哪个用户对不上。`}</div></div>
  <div class="card">
    <div class="card-h"><h3>流水逐条（最近 200 条）</h3></div>
    <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>#</th><th>时间</th><th>类型</th><th class="r">变动</th><th class="r">余额</th><th>交易号</th></tr></thead>
      <tbody>${r.list.slice(0, 200).map((x) => `<tr>
        <td class="dim small">${x.id}</td><td class="small">${esc(dt(x.created_at))}</td>
        <td><span class="tag ${x.direction > 0 ? 'ok' : 'warn'}">${esc(TYPE_NAME[x.type] || x.type)}</span></td>
        <td class="r num bold">${x.direction > 0 ? '+' : '−'}${n(x.amount)}</td>
        <td class="r num dim">${n(x.balance_after)}</td>
        <td>${x.txid ? txLink(x.txid, shortHash(x.txid, 8, 5)) : '—'}</td></tr>`).join('')}</tbody>
    </table></div></div>
  </div>`;
}

/* ============================ 交互动作 ============================ */
async function actCheckin(btn) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> 正在上链…`;
  try {
    const r = await A.checkin(deviceId());
    if (r.already) { toast('今天已经签过到了', 'info'); }
    else {
      toast(`签到成功 +${r.total} 分（基础 ${r.base} + 连续加成 ${r.bonus}）`, 'ok', `连续第 ${r.streak} 天`);
      // 让链上那笔交易可见（如果已经出块）
      S.user = (await A.me()).user;
    }
    route();
  } catch (e) {
    toast(e.message, 'bad');
    btn.disabled = false;
    btn.innerHTML = `${I('flame', 17)} 立即签到`;
  }
}

async function actToggleTask(id, elm) {
  const item = elm.closest('.titem');
  const isDone = elm.classList.contains('done');
  elm.style.pointerEvents = 'none';
  try {
    if (isDone) {
      const r = await A.undoTask(id);
      toast(`已撤销，追回 ${r.points} 分（积分转回铸币账户）`, 'warn');
    } else {
      const r = await A.doneTask(id);
      if (r.already) toast('这项已经完成过了', 'info');
      else if (r.dayBonus) {
        toast(`今天全部完成！额外 +${r.dayBonus.points} 分`, 'ok', '当日全清奖励');
      } else {
        toast(`+${r.points} 分`, 'ok');
      }
    }
    S.user = (await A.me()).user;
    route();
  } catch (e) {
    toast(e.message, 'bad');
    elm.style.pointerEvents = '';
  }
}

function openAddTask() {
  const m = modal({
    title: '加一条今天的任务',
    body: `<div class="field"><label>任务内容</label>
        <input class="ctl" id="ntTitle" placeholder="例如：读完《深度工作》第 3 章" maxlength="60"></div>
      <div class="grid g2" style="gap:12px">
        <div class="field"><label>类别</label><select class="ctl" id="ntCat">
          ${Object.entries(CAT_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label>预计耗时（分钟）</label>
          <input class="ctl" id="ntMin" type="number" value="25" min="0" max="600"></div>
      </div>
      <div class="help">完成一项固定 +1 分；当天任务全部完成再额外 +10 分。</div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>添加</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const title = m.el.querySelector('#ntTitle').value.trim();
    if (title.length < 2) return toast('任务名称太短了', 'bad');
    try {
      await A.addTask({ title, category: m.el.querySelector('#ntCat').value,
        est_min: Number(m.el.querySelector('#ntMin').value) || 25 });
      m.close(); toast('已加入今天的清单'); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

async function openTemplates() {
  const r = await A.templates();
  const body = `<p class="small dim mb4">习惯模板会在每天早上自动变成当天的任务。
    这里改一次，以后每天都会有。</p>
    <div id="tplList">${r.list.length ? r.list.map((t) => `
      <div class="row-b" style="padding:11px 0;border-bottom:1px solid var(--line)">
        <div><div class="bold small">${esc(t.title)}</div>
          <div class="tiny dim2">${esc(CAT_NAME[t.category] || t.category)} · ${t.est_min} 分钟 ·
            ${t.repeat_type === 'daily' ? '每天' : t.repeat_type === 'weekday' ? '工作日' : '每周' + t.weekly_day}</div></div>
        <div class="row gap2">
          <button class="btn sm ${t.enabled ? 'soft' : ''}" data-act="tglTpl" data-id="${t.id}">${t.enabled ? '已启用' : '已暂停'}</button>
          <button class="btn sm ghost" data-act="delTpl" data-id="${t.id}">${I('trash', 13)}</button>
        </div>
      </div>`).join('') : `<div class="empty small">还没有模板</div>`}</div>
    <div class="card pad mt4" style="background:var(--card-2)">
      <div class="bold small mb3">新增模板</div>
      <div class="row gap2" style="flex-wrap:wrap">
        <input class="ctl grow" id="tpTitle" placeholder="例如：背 80 个单词" maxlength="60" style="min-width:180px">
        <select class="ctl" id="tpCat" style="width:110px">
          ${Object.entries(CAT_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn pri" data-act="addTpl">添加</button>
      </div>
    </div>`;
  const m = modal({ title: '习惯模板', body, wide: true,
    footer: `<button class="btn" data-no>关闭</button>` });
  m.el.querySelector('[data-no]').onclick = m.close;
  return m;
}

async function actClaim(id) {
  try {
    const r = await A.claimBadge(id);
    const url = `${location.origin}/verify?code=${r.verifyCode}`;
    modal({
      title: '成就凭证已铸造',
      wide: true,
      body: `<div class="cert mb4"><div class="cert-in">
          <div class="row-b"><div class="cert-no">凭证号 ${esc(r.serial)}</div>
            <span class="tag ok">${I('okc', 12)} 已上链</span></div>
          <h2 style="font-size:23px;margin:12px 0 4px">成就已永久记录</h2>
          <p class="dim small">这笔铸造交易已经打进区块，任何人都能用下面这个验真码查出它 ——
            包括「是谁、什么时候、由哪一笔交易铸出来的」。</p>
          <div class="grid g2 mt5" style="gap:16px">
            <div>
              <div class="tiny dim2 mb2">验真码（给别人查的）</div>
              <div class="row gap2"><b class="mono" style="font-size:19px;letter-spacing:.06em;color:var(--brand-ink)">${esc(r.verifyCode)}</b>
                <button class="btn sm" data-copy="${esc(r.verifyCode)}">${I('copy', 13)}</button></div>
              <div class="tiny dim2 mt4 mb2">交易号</div>
              <a class="hash block" href="#/tx/${esc(r.txid)}">${esc(r.txid)}</a>
              ${r.proof ? `<div class="tiny dim2 mt4">Merkle 证明：${r.proof.path.length} 层路径，
                可在验真页用浏览器本地重算</div>` : ''}
            </div>
            <div class="center"><img class="qr" src="/api/verify/${esc(r.verifyCode)}/qr.svg" alt="验真二维码"></div>
          </div>
        </div></div>`,
      footer: `<a class="btn" href="#/verify?code=${esc(r.verifyCode)}" target="_blank">${I('ext', 14)} 打开验真页</a>
        <button class="btn pri" data-no>知道了</button>`,
    }).el.querySelector('[data-no]').onclick = function () { this.closest('.mask').remove(); };
    toast('徽章已铸造，凭证可在「成就凭证」里查看', 'ok');
    S.user = (await A.me()).user;
  } catch (e) { toast(e.message, 'bad'); }
}

async function actRedeem(id) {
  const ok = await confirmDlg('确认兑换', '兑换后积分会转到销毁账户，不可撤销。确定要兑换吗？', '确认兑换');
  if (!ok) return;
  try {
    const r = await A.redeem(id, 1);
    toast(`兑换成功，订单 ${r.orderNo}`, 'ok', `消耗 ${r.cost} 分`);
    S.user = (await A.me()).user;
    route();
  } catch (e) { toast(e.message, 'bad'); }
}

function openNewStake() {
  const m = modal({
    title: '押注一个目标',
    body: `<div class="field"><label>你要押的目标</label>
        <input class="ctl" id="skT" placeholder="例如：连续 14 天早上 7 点前起床" maxlength="80"></div>
      <div class="grid g3" style="gap:12px">
        <div class="field"><label>押多少分</label><input class="ctl" id="skA" type="number" value="50" min="10"></div>
        <div class="field"><label>周期（天）</label><input class="ctl" id="skD" type="number" value="14" min="1" max="90"></div>
        <div class="field"><label>需完成次数</label><input class="ctl" id="skN" type="number" value="10" min="1"></div>
      </div>
      <div class="field"><label>返还倍数</label><select class="ctl" id="skO">
        <option value="1.8">1.8 倍（稳妥）</option><option value="2" selected>2.0 倍（标准）</option>
        <option value="2.5">2.5 倍（激进，要求更高）</option></select></div>
      <div class="alert warn">${I('alert', 15)}<div class="small">达成 → 从奖池按倍数返还；失败 → 本金进奖池。
        押注期间这部分积分会被冻结，不能用于兑换。</div></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>押上</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const title = m.el.querySelector('#skT').value.trim();
    if (title.length < 4) return toast('把目标写具体一点，至少 4 个字', 'bad');
    try {
      await A.newStake({ title, amount: Number(m.el.querySelector('#skA').value),
        days: Number(m.el.querySelector('#skD').value), needCount: Number(m.el.querySelector('#skN').value),
        odds: Number(m.el.querySelector('#skO').value) });
      m.close(); toast('押注已锁定，积分已上链', 'ok'); S.user = (await A.me()).user; route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

function openJoinTeam() {
  const m = modal({
    title: '用邀请码加入自习室',
    body: `<div class="field"><label>6 位邀请码</label>
        <input class="ctl mono" id="jcCode" placeholder="例如 A1B2C3" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em"></div>
      <div class="help">邀请码在自习室详情页右上角，房主可以分享给别人。</div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>加入</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    try {
      const r = await A.joinTeam(m.el.querySelector('#jcCode').value);
      m.close(); toast('已加入「' + r.name + '」', 'ok'); location.hash = '#/team/' + r.id;
    } catch (e) { toast(e.message, 'bad'); }
  };
}

function openNewTeam() {
  const m = modal({
    title: '建一个自习室',
    body: `<div class="field"><label>名称</label><input class="ctl" id="tmN" placeholder="例如：清晨六点自习室" maxlength="40"></div>
      <div class="field"><label>口号</label><input class="ctl" id="tmS" placeholder="例如：今天只做一小步" maxlength="80"></div>
      <div class="field"><label>共同目标</label><input class="ctl" id="tmG" placeholder="例如：考研上岸" maxlength="80"></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>创建</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    try {
      const r = await A.newTeam({ name: m.el.querySelector('#tmN').value,
        slogan: m.el.querySelector('#tmS').value, goal: m.el.querySelector('#tmG').value });
      m.close(); toast('自习室已创建，邀请码 ' + r.join_code, 'ok'); location.hash = '#/team/' + r.id;
    } catch (e) { toast(e.message, 'bad'); }
  };
}

async function openDonate(topic) {
  const m = modal({
    title: '把积分捐出去',
    body: `<div class="field"><label>捐赠方向</label><select class="ctl" id="dnT">
        ${['乡村图书角', '荒漠护林计划', '山区儿童早餐', '流浪动物救助', '社区老人送餐',
    '乡村学校护眼灯', '听障儿童助听', '一小时支教课', '乡村儿童羽绒服', '城市绿化认养']
    .map((t) => `<option ${t === topic ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>捐赠积分</label><input class="ctl" id="dnA" type="number" value="50" min="1"></div>
      <div class="field"><label>留言（可选）</label><input class="ctl" id="dnM" placeholder="想说的话" maxlength="120"></div>
      <div class="alert ok">${I('heart', 15)}<div class="small">平台按 10% 追加配捐。捐赠记录会上链公示。</div></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>确认捐赠</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    try {
      const r = await A.donate({ topic: m.el.querySelector('#dnT').value,
        amount: Number(m.el.querySelector('#dnA').value),
        message: m.el.querySelector('#dmM') || m.el.querySelector('#dnM').value });
      m.close(); toast(`捐赠成功，平台配捐 ${r.match} 分`, 'ok', '谢谢你的善意');
      S.user = (await A.me()).user; route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 登录 / 注册 ============================ */
function openAuth(mode = 'login') {
  const isLogin = mode === 'login';
  const m = modal({
    title: isLogin ? '登录寸进链' : '注册新账号',
    body: isLogin
      ? `<div class="field"><label>用户名</label><input class="ctl" id="au" placeholder="cunjin001" autocomplete="username"></div>
        <div class="field"><label>密码</label><input class="ctl" id="ap" type="password" placeholder="123456" autocomplete="current-password"></div>
        <div id="aErr"></div>
        <div class="alert info mt3">${I('info', 14)}<div class="small">
          演示账号：<b class="mono">cunjin001 ~ cunjin057</b>（普通用户）／
          <b class="mono">admin</b>（管理员）／<b class="mono">ops_lin</b>（运营）<br>密码统一 <b class="mono">123456</b></div></div>`
      : `<div class="grid g2" style="gap:12px">
          <div class="field"><label>用户名</label><input class="ctl" id="au" placeholder="字母数字下划线，3~20 位"></div>
          <div class="field"><label>昵称</label><input class="ctl" id="an" placeholder="别人怎么称呼你"></div>
        </div>
        <div class="field"><label>密码</label><input class="ctl" id="ap" type="password" placeholder="至少 6 位"></div>
        <div class="grid g2" style="gap:12px">
          <div class="field"><label>城市</label><input class="ctl" id="ac" placeholder="杭州"></div>
          <div class="field"><label>我的目标</label><input class="ctl" id="ag" placeholder="例如：考研上岸"></div>
        </div>
        <div id="aErr"></div>
        <div class="alert chain mt3">${I('key', 14)}<div class="small">
          注册时会当场生成一对 <b>Ed25519 密钥</b>，并据此算出你的链上地址。
          从那以后，你的每一笔积分都由这把私钥签名。</div></div>`,
    footer: `<button class="btn" data-no>取消</button>
      <button class="btn pri" data-yes>${isLogin ? '登录' : '注册并开始'}</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  const submit = async () => {
    const err = m.el.querySelector('#aErr');
    err.innerHTML = '';
    const u = m.el.querySelector('#au').value.trim();
    const p = m.el.querySelector('#ap').value;
    const yes = m.el.querySelector('[data-yes]');
    yes.disabled = true;
    yes.innerHTML = `<span class="spin"></span> 处理中`;
    try {
      const r = isLogin ? await A.login(u, p) : await A.register({
        username: u, password: p, nickname: m.el.querySelector('#an').value.trim() || u,
        city: m.el.querySelector('#ac').value.trim(), goal: m.el.querySelector('#ag').value.trim(),
      });
      m.close();
      toast(isLogin ? '欢迎回来，' + r.user.nickname : '注册成功，你的链上地址已生成', 'ok');
      S.user = (await A.me()).user;
      paintNav();
      route();
    } catch (e) {
      err.innerHTML = `<div class="field bad"><div class="err">${I('xc', 13)} ${esc(e.message)}</div></div>`;
      yes.disabled = false;
      yes.innerHTML = isLogin ? '登录' : '注册并开始';
    }
  };
  m.el.querySelector('[data-yes]').onclick = submit;
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

/* ============================ 导航与路由 ============================ */
function paintNav() {
  const u = S.user;
  const links = [
    ['#/today', '今日'], ['#/data', '数据'], ['#/badges', '徽章'], ['#/shop', '商城'],
    ['#/stake', '押注'], ['#/teams', '自习室'], ['#/rank', '榜单'], ['#/donate', '公益'],
  ];
  $('#navlink').innerHTML = links.map(([h, t]) =>
    `<a href="${h}" class="${location.hash.startsWith(h) ? 'on' : ''}">${t}</a>`).join('')
    + `<a href="/chain" target="_blank">链浏览器 ${I('ext', 12)}</a>`;
  $('#uchip').innerHTML = u
    ? `<div class="uchip" data-act="goMine">
        <span class="ava">${esc(u.nickname.slice(0, 2))}</span>
        <div style="line-height:1.25"><div class="bold small">${esc(u.nickname)}</div>
          <div class="tiny" style="color:var(--brand-ink)">${n(u.balance)} 分 · Lv.${u.level}</div></div>
      </div>`
    : `<div class="row gap2"><button class="btn sm" data-act="openLogin">登录</button>
        <button class="btn sm pri" data-act="openReg">注册</button></div>`;
}

const ROUTES = {
  today: () => viewToday(),
  data: () => viewData(),
  ledger: (q) => viewLedger(q),
  badges: () => viewBadges(),
  shop: (q) => viewShop(q.cat),
  stake: () => viewStake(),
  teams: () => viewTeam(),
  team: (q, id) => viewTeam(id),
  rank: (q) => viewRank(q.type),
  donate: () => viewDonate(),
  mine: () => viewMine(),
  reconcile: () => viewReconcile(),
  // 链上跳转：直接用链浏览器页面打开详情
  block: (q, id) => { location.href = '/chain#/block/' + id; },
  tx: (q, id) => { location.href = '/chain#/tx/' + id; },
  addr: (q, id) => { location.href = '/chain#/addr/' + id; },
  verify: (q) => { location.href = '/verify' + (q.code ? '?code=' + q.code : ''); },
};

async function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'today';
  const [path, qs2] = raw.split('?');
  const seg = path.split('/');
  const q = Object.fromEntries(new URLSearchParams(qs2 || ''));
  const root = $('#view');
  root.scrollIntoView({ block: 'start' });
  paintNav();
  const fn = ROUTES[seg[0]];
  if (!fn) { root.innerHTML = empty('页面不存在', '回到「今日」看看', 'alert'); return; }
  try {
    await fn(q, seg[1]);
  } catch (e) {
    root.innerHTML = `<div class="card pad"><div class="alert bad">${I('alert', 16)}
      <div><b>加载失败</b><div class="small mt2">${esc(e.message)}</div></div></div>
      <button class="btn mt4" data-act="reload">${I('refresh', 14)} 重试</button></div>`;
  }
}

/* ============================ 全局事件 ============================ */
function bindActions() {
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) {
      // 链上跳转用 <a href="#/...">，这里处理普通链接的滚动
      return;
    }
    const act = t.getAttribute('data-act');
    const id = t.getAttribute('data-id');
    const map = {
      checkin: () => actCheckin(t),
      toggleTask: () => actToggleTask(Number(id), t),
      addTask: openAddTask,
      openTpl: openTemplates,
      undoTask: async () => { try { const r = await A.undoTask(id); toast(`已撤销，追回 ${r.points} 分`, 'warn'); S.user = (await A.me()).user; route(); } catch (er) { toast(er.message, 'bad'); } },
      skipTask: async () => { try { await A.skipTask(id); toast('已跳过这项', 'info'); route(); } catch (er) { toast(er.message, 'bad'); } },
      delTask: async () => {
        if (!(await confirmDlg('删除任务', '确定删除这条任务吗？'))) return;
        try { await A.delTask(id); toast('已删除'); route(); } catch (er) { toast(er.message, 'bad'); }
      },
      claim: () => actClaim(Number(id)),
      redeem: () => actRedeem(Number(id)),
      newStake: openNewStake,
      settleStake: async () => {
        if (!(await confirmDlg('结算押注', '结算后不可撤销。确定现在结算吗？'))) return;
        try {
          const r = await A.settleStake(id);
          toast(r.win ? `达成！从奖池返还 ${n(r.payout || r.amount)} 分` : '未达成，本金已进奖池',
            r.win ? 'ok' : 'warn');
          S.user = (await A.me()).user; route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      bumpStake: async () => { try { await A.bumpStake(id); toast('进度 +1'); route(); } catch (er) { toast(er.message, 'bad'); } },
      joinTeam: openJoinTeam,
      newTeam: openNewTeam,
      openTeam: () => { location.hash = '#/team/' + id; },
      donate: () => openDonate(),
      pickTopic: () => openDonate(t.getAttribute('data-t')),
      openLogin: () => openAuth('login'),
      openReg: () => openAuth('register'),
      goMine: () => { location.hash = '#/mine'; },
      rankType: () => { location.hash = '#/rank?type=' + t.getAttribute('data-t'); },
      shopcat: () => { location.hash = '#/shop' + (t.getAttribute('data-c') ? '?cat=' + t.getAttribute('data-c') : ''); },
      lfilter: () => { const ty = t.getAttribute('data-t'); location.hash = '#/ledger' + (ty ? '?type=' + ty : ''); },
      lpage: () => { location.hash = '#/ledger?page=' + t.getAttribute('data-p'); },
      reload: () => route(),
      logout: async () => {
        if (!(await confirmDlg('退出登录', '确定要退出吗？'))) return;
        await A.logout(); S.user = null; toast('已退出'); location.hash = '#/today'; route();
      },
      tglTpl: async () => { try { await A.toggleTpl(id); const m = await openTemplates(); m.close(); openTemplates(); } catch (er) { toast(er.message, 'bad'); } },
      delTpl: async () => { try { await A.delTpl(id); toast('模板已删除'); const m = await openTemplates(); m.close(); openTemplates(); } catch (er) { toast(er.message, 'bad'); } },
      addTpl: async () => {
        const box = document.querySelector('#tpTitle');
        const title = box ? box.value.trim() : '';
        if (title.length < 2) return toast('模板名称太短', 'bad');
        try {
          await A.addTpl({ title, category: document.querySelector('#tpCat').value });
          toast('模板已添加，明天会自动生成任务');
          document.querySelectorAll('.mask').forEach((m2) => m2.remove());
          openTemplates();
        } catch (er) { toast(er.message, 'bad'); }
      },
    };
    if (map[act]) { e.preventDefault(); map[act](); }
  });

  // 复选框支持键盘操作（空格/回车切换）
  document.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-act="toggleTask"]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // 链上跳转的 hash 链接（#/block/xx）不刷新页面
  window.addEventListener('hashchange', route);
}

/* ============================ 启动 ============================ */
(async function boot() {
  bindCopy(document);
  bindActions();
  try {
    const r = await A.me();
    S.user = r.user;
    if (S.user) S.user.levelStep = r.levelProgress ? r.levelProgress.step : 500;
  } catch (e) { S.user = null; }
  try {
    const p = await A.pub();
    S.pool = p.pool;
  } catch (e) { /* 忽略 */ }
  paintNav();
  await route();
})();
