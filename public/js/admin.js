/* =====================================================================================
   运营管理端
   =====================================================================================
   设计取向（跟用户端刻意不一样）：
     · 第一屏不是一堆 KPI，而是「需要我处理的事」——每条待办点进去都落到已经排好序的列表
     · 表格固定表头、可排序、可翻页；筛选条件写进 URL，刷新不丢
     · 凡是能改钱和规则的入口，都必须填理由；提交后写审计日志 + 上链存证
   管理端不做「假动作」：界面上出现的每个按钮，点下去都真的改数据、真的留痕。
   ===================================================================================== */
import * as A from './api.js';
import {
  $, $$, I, esc, n, pct, dt, ago, shortHash, toast, modal, confirmDlg, copy, bindCopy,
  empty, skel,
} from './ui.js';
import * as C from './charts.js';

const S = { user: null, overview: null, q: {} };
let booting = false;

const TABS = [
  ['overview', '概览', 'home'],
  ['users', '用户', 'users'],
  ['rules', '积分规则', 'scale'],
  ['rewards', '奖励商品', 'gift'],
  ['orders', '兑换订单', 'wallet'],
  ['risk', '风控', 'shield'],
  ['chain', '链路运维', 'cube'],
  ['reconcile', '对账台', 'key'],
  ['announce', '公告', 'bell'],
  ['audit', '审计日志', 'book'],
  ['analytics', '数据看板', 'chart'],
];

const RISK_LEVEL = { high: '高危', mid: '中危', low: '低危' };
const ORDER_STATUS = {
  paid: '待发货', shipped: '已发货', done: '已完成', cancel: '已取消',
};
const REDEEM_CAT = { coupon: '券码', course: '课程', goods: '实物', virtual: '虚拟', charity: '公益' };
const RULE_UNIT = { point: '分', day: '天', percent: '%' };

/* ============================ 登录门 ============================ */
function paintGate(msg) {
  $('#shell').classList.add('hide');
  const g = $('#gate');
  g.classList.remove('hide');
  g.innerHTML = `
  <div class="adm-gate-c">
    <div class="row gap3 mb5" style="justify-content:center">
      <span class="brand-mark" style="width:38px;height:38px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
          stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg>
      </span>
      <div><div style="font-weight:800;font-size:17px">寸进链 · 运营管理端</div>
        <div class="tiny dim2">规则配置 · 奖励运营 · 风控处置 · 链路运维 · 三方对账</div></div>
    </div>

    <div class="card">
      <div class="card-b">
        ${msg ? `<div class="alert bad mb4">${I('alert', 16)}<div class="small">${esc(msg)}</div></div>` : ''}
        <div class="field"><label>运营账号</label>
          <input class="ctl" id="lgU" value="ops_lin" autocomplete="username"></div>
        <div class="field"><label>密码</label>
          <input class="ctl" id="lgP" type="password" value="123456" autocomplete="current-password"></div>
        <button class="btn pri block lg" id="lgGo">${I('lock', 16)} 登录管理端</button>
        <div class="small dim2 mt4" style="line-height:1.9">
          演示账号：<b class="mono">ops_lin</b> / <b class="mono">123456</b>（运营）<br>
          管理员：<b class="mono">admin</b> / <b class="mono">123456</b>（权限更大，可封禁与调账）<br>
          普通用户账号登录会被告知：你没有运营权限。
        </div>
      </div>
    </div>
    <div class="row gap3 mt5 small" style="justify-content:center">
      <a href="/" style="color:var(--txt-3)">用户端</a>
      <a href="/chain" style="color:var(--txt-3)">链浏览器</a>
      <a href="/verify" style="color:var(--txt-3)">凭证验真</a>
    </div>
  </div>`;

  const go = async () => {
    const u = $('#lgU').value.trim(), p = $('#lgP').value;
    if (!u || !p) return toast('账号密码都要填', 'warn');
    $('#lgGo').setAttribute('disabled', 'true');
    try {
      const r = await A.login(u, p);
      if (r.user.role !== 'operator' && r.user.role !== 'admin') {
        paintGate(`账号「${r.user.nickname}」是普通用户（role=user），没有运营权限。请用 ops_lin 或 admin 登录。`);
        return;
      }
      S.user = r.user;
      await enter();
    } catch (e) {
      paintGate(e.message);
    } finally {
      const b = $('#lgGo'); if (b) b.removeAttribute('disabled');
    }
  };
  $('#lgGo').onclick = go;
  $('#lgP').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#lgU').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lgP').focus(); });
}

/* ============================ 外壳 ============================ */
function paintShell() {
  $('#gate').classList.add('hide');
  $('#shell').classList.remove('hide');
  const open = S.overview && S.overview.risk ? Number(S.overview.risk.open) || 0 : 0;
  $('#navlink').innerHTML = TABS.map(([k, t, ic]) => {
    const on = (S.q.tab || 'overview') === k;
    return `<a href="#/${k}" class="${on ? 'on' : ''}">${I(ic, 15)} ${t}
      ${k === 'risk' && open ? `<span class="adm-nav-n">${open}</span>` : ''}</a>`;
  }).join('');
  $('#uchip').innerHTML = `<div class="row gap3" style="padding:0 4px 6px">
    <span class="ava sm">${esc((S.user.nickname || '运').slice(0, 2))}</span>
    <div style="line-height:1.3;min-width:0">
      <div class="bold small nowrap" style="overflow:hidden;text-overflow:ellipsis">${esc(S.user.nickname)}</div>
      <div class="tiny" style="color:var(--brand-ink)">${S.user.role === 'admin' ? '管理员' : '运营'}</div>
    </div>
    <div class="grow"></div>
    <div class="btn-ico" data-act="logout" title="退出登录">${I('logout', 15)}</div>
  </div>`;
}

function head({ title, subtitle, acts = [] }) {
  $('#crumb').innerHTML = `寸进链 / 运营管理端 / <b>${esc(title)}</b>`;
  $('#title').textContent = title;
  $('#subtitle').innerHTML = subtitle || '';
  // acts 约定是数组；容错成字符串，免得一个参数写错就把整个页签搞成空白
  $('#acts').innerHTML = Array.isArray(acts) ? acts.join('') : String(acts == null ? '' : acts);
}

/** 统一的分页控件 */
function pagerHTML(q, total, size) {
  const p = Number(q.page) || 1;
  const pages = Math.max(1, Math.ceil(total / size));
  return `<div class="pager">
    <span>共 <b class="num">${n(total)}</b> 条 · 第 ${p}/${pages} 页</span>
    <span class="row gap2">
      <button class="btn sm" data-act="page" data-p="${p - 1}" ${p <= 1 ? 'disabled' : ''}>${I('left', 13)} 上一页</button>
      <button class="btn sm" data-act="page" data-p="${p + 1}" ${p >= pages ? 'disabled' : ''}>下一页 ${I('right', 13)}</button>
    </span>
  </div>`;
}

const chipRow = (items, cur, act, key) => `<div class="row gap2" style="flex-wrap:wrap">${items.map(([v, t]) => `
  <button class="chip ${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-${key}="${esc(v)}">${esc(t)}</button>`).join('')}</div>`;

/* ============================ 视图：概览 ============================ */
async function viewOverview() {
  head({
    title: '概览',
    subtitle: '第一屏只回答一个问题：现在有没有事等我处理。',
    acts: [
      `<button class="btn" data-act="sweep">${I('shield', 14)} 跑一次风控扫描</button>`,
      `<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`,
    ],
  });
  const v = $('#view');
  v.innerHTML = `<div class="kgrid">${skel(96)}${skel(96)}${skel(96)}${skel(96)}</div>
    <div class="mt5">${skel(180)}</div>`;
  const o = await A.admOverview();
  S.overview = o;
  paintShell();

  const todoBox = o.todos.length
    ? `<div class="grid" style="gap:12px">${o.todos.map((t) => `
        <div class="adm-todo ${esc(t.level)}">
          <div class="adm-todo-i">${I(t.level === 'high' ? 'alert' : t.level === 'mid' ? 'clock' : 'info', 17)}</div>
          <div class="adm-todo-b">
            <b>${esc(t.title)}</b>
            <p>${esc(t.desc)}</p>
          </div>
          <div class="adm-todo-g">
            <button class="btn sm pri" data-act="goTodo"
              data-route="${esc(t.route)}" data-sort="${esc(t.sort || 'none')}">${esc(t.action)} ${I('right', 13)}</button>
          </div>
        </div>`).join('')}</div>`
    : `<div class="alert ok">${I('okc', 16)}<div><b>暂时没有待处理的事</b>
        <div class="small mt2">风控告警已清、库存充足、对账三方一致。有新情况这里会自动冒出来。</div></div></div>`;

  const k = o.kpi, m = o.money, c = o.chain;
  const recOk = o.reconcile.ok;

  v.innerHTML = `
  <div class="card">
    <div class="card-h"><h3>${I('target', 15)} 需要我处理的事 <span class="hsub">按紧急程度排序</span></h3>
      <span class="tag ${o.todos.length ? 'warn' : 'ok'}">${o.todos.length} 项</span></div>
    <div class="card-b">${todoBox}</div>
  </div>

  <div class="kgrid mt5">
    ${kpi('今日签到', `${n(k.today_checkin)} 人`, `昨日 ${n(k.yday_checkin)} 人`,
    k.yday_checkin > 0 ? (k.today_checkin >= k.yday_checkin ? 'ok' : 'bad') : 'idle')}
    ${kpi('今日任务完成率', `${pct(k.today_done, k.today_tasks)}%`, `${n(k.today_done)} / ${n(k.today_tasks)} 项`, 'idle')}
    ${kpi('待处置告警', `${n(k.open_alerts)} 条`, `累计 ${n(o.risk.total)} 条`, k.open_alerts ? 'bad' : 'ok')}
    ${kpi('运行中的押注', `${n(k.running_stakes)} 笔`, `奖池余额 ${n(m.pool)} 分`, 'idle')}
  </div>

  <div class="grid g-2-1 mt5">
    <div class="card">
      <div class="card-h"><h3>${I('coin', 15)} 积分经济</h3>
        <a class="btn sm" href="#/reconcile">${I('key', 13)} 去对账台</a></div>
      <div class="card-b">
        <div class="adm-strip">
          <div class="adm-st"><b>${n(m.issued)}</b><span>累计发行</span></div>
          <div class="adm-st"><b>${n(m.consumed)}</b><span>累计消耗</span></div>
          <div class="adm-st"><b>${n(m.burned)}</b><span>已销毁（通缩）</span></div>
          <div class="adm-st"><b>${n(m.user_total)}</b><span>用户总余额</span></div>
          <div class="adm-st"><b>${n(m.frozen)}</b><span>冻结中（押注）</span></div>
          <div class="adm-st"><b>${n(m.pool)}</b><span>奖池余额</span></div>
          <div class="adm-st"><b>${n(m.donate_pool)}</b><span>公益账户</span></div>
        </div>
        <div class="adm-note ${recOk ? 'ok' : 'bad'} mt4" style="display:flex;gap:9px;align-items:flex-start">
          <span style="flex:none">${I(recOk ? 'okc' : 'alert', 15)}</span>
          <div class="small">
            <b>三方对账${recOk ? '一致' : '不平'}</b>：链上账户重算 ${n(o.reconcile.users)} 个用户，
            ${recOk ? '「业务流水 = 用户汇总 = 链上余额」全部相等。'
    : `<b>${o.reconcile.mismatch}</b> 个用户对不上，说明有人绕过积分引擎改了库，去对账台看是哪些。`}
            销毁账户余额 ${n(o.reconcile.burned)} 分，链上公开可查。
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${I('cube', 15)} 链路状态</h3>
        <span class="tag ${c.pending > 30 ? 'warn' : 'ok'}">
          ${c.pending > 30 ? '有积压' : '通畅'}</span></div>
      <div class="card-b">
        <dl>
          <div class="adm-kv"><dt>区块高度</dt><dd class="num">${n(c.height)}</dd></div>
          <div class="adm-kv"><dt>交易总数</dt><dd class="num">${n(c.tx_count)}</dd></div>
          <div class="adm-kv"><dt>交易池待打包</dt><dd class="num">${n(c.pending)}</dd></div>
          <div class="adm-kv"><dt>当前挖矿难度</dt><dd>${c.difficulty}</dd></div>
          <div class="adm-kv"><dt>平均出块耗时</dt><dd class="num">${n(c.avg_mined_ms)} ms</dd></div>
          <div class="adm-kv"><dt>最近出块</dt><dd>${c.last_ts ? ago(c.last_ts) : '—'}</dd></div>
        </dl>
        <div class="row gap2 mt4">
          <button class="btn sm" data-act="mine">${I('hammer', 13)} 立即出块</button>
          <a class="btn sm" href="/chain" target="_blank" rel="noopener">${I('ext', 13)} 链浏览器</a>
        </div>
      </div>
    </div>
  </div>`;
}

const kpi = (label, value, sub, tone) => `<div class="kpi">
  <div class="tiny dim2">${esc(label)}</div>
  <div class="v num" style="font-size:26px;font-weight:800;letter-spacing:-.03em;margin:4px 0 2px">${esc(value)}</div>
  <div class="row gap2 tiny" style="color:var(--txt-3)">
    <i class="dot ${tone}"></i>${esc(sub)}</div></div>`;

/* ============================ 视图：用户 ============================ */
async function viewUsers() {
  const q = S.q;
  head({
    title: '用户',
    subtitle: '余额、连续天数、任务完成、徽章、未处置告警一屏可见。点任意一行看该用户的链上地址与流水。',
    acts: [`<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(240)}</div></div>`;
  const r = await A.admUsers(q);
  const sorts = [['balance', '按余额'], ['points', '按累计获得'], ['streak', '按连续天数'], ['new', '按注册时间']];

  v.innerHTML = `
  <div class="card">
    <div class="card-h">
      <h3>${I('users', 15)} 用户列表</h3>
      <div class="row gap2">
        <div class="field" style="margin:0"><input class="ctl" id="uq" style="width:210px;min-height:34px;padding:6px 11px"
          placeholder="搜用户名 / 昵称 / 链上地址" value="${esc(q.q || '')}"></div>
        <button class="btn sm pri" data-act="usearch">${I('search', 13)} 搜索</button>
      </div>
    </div>
    <div class="card-b" style="padding-bottom:0">${chipRow(sorts, q.sort || 'balance', 'usort', 's')}</div>
    <div class="card-b flush">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>用户</th><th>链上地址</th>
            <th class="r">余额</th><th class="r">累计获得</th><th class="r">冻结</th>
            <th class="c">连续 / 最长</th><th class="c">任务</th><th class="c">徽章</th>
            <th class="c">告警</th><th class="c">状态</th><th class="r">最近登录</th>
          </tr></thead>
          <tbody>${r.list.map((u) => `<tr data-act="openUser" data-id="${u.id}" style="cursor:pointer">
            <td><div class="t-main">${esc(u.nickname)}${u.role !== 'user' ? ` <span class="tag brand">${u.role === 'admin' ? '管理员' : '运营'}</span>` : ''}</div>
              <div class="t-sub">@${esc(u.username)}${u.city ? ' · ' + esc(u.city) : ''}</div></td>
            <td><span class="hash short">${shortHash(u.addr, 8, 6)}</span></td>
            <td class="r num"><b>${n(u.balance)}</b></td>
            <td class="r num dim">${n(u.earned)}</td>
            <td class="r num ${Number(u.frozen) ? '' : 'dim2'}">${Number(u.frozen) ? n(u.frozen) : '—'}</td>
            <td class="c num">${Number(u.streak) ? `<b style="color:var(--streak)">${n(u.streak)}</b>` : '0'}
              <span class="dim2">/ ${n(u.max_streak)}</span></td>
            <td class="c num">${n(u.task_done)}</td>
            <td class="c num">${n(u.badge_count)}</td>
            <td class="c">${Number(u.open_alerts) ? `<span class="tag bad">${n(u.open_alerts)}</span>` : '<span class="dim2">—</span>'}</td>
            <td class="c">${u.status ? `<span class="tag ok">正常</span>` : `<span class="tag bad">已封禁</span>`}</td>
            <td class="r tiny dim">${u.last_login ? ago(u.last_login) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${pagerHTML({ page: r.page }, r.total, r.size)}
    </div>
  </div>`;

  const doSearch = () => { S.q = { ...S.q, q: $('#uq').value.trim(), page: 1 }; route(); };
  const btn = $('[data-act="usearch"]'); if (btn) btn.onclick = doSearch;
  const inp = $('#uq'); if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

async function openUser(id) {
  const r = await A.admUser(id);
  const u = r.user;
  const rec = r.reconcile;
  const m = modal({
    wide: true,
    title: `用户详情 · ${u.nickname}`,
    body: `<div class="grid g4 mb5">
        ${miniStat('余额', n(u.balance) + ' 分')}
        ${miniStat('累计获得', n(u.earned) + ' 分')}
        ${miniStat('累计消耗', n(u.spent) + ' 分')}
        ${miniStat('冻结中', n(u.frozen) + ' 分')}
      </div>
      <div class="grid g3 mb5">
        ${miniStat('连续签到', n(u.streak) + ' 天')}
        ${miniStat('最长连续', n(u.max_streak) + ' 天')}
        ${miniStat('累计签到', n(u.checkin_days) + ' 天')}
      </div>

      <div class="card mb5" style="box-shadow:none">
        <div class="card-h"><h3>身份与链上地址</h3></div>
        <div class="card-b">
          <dl>
            <div class="adm-kv"><dt>用户 ID / 用户名</dt><dd>#${u.id} · @${esc(u.username)}</dd></div>
            <div class="adm-kv"><dt>链上地址</dt><dd class="mono" style="font-size:11.5px">
              <a class="hash" href="/chain#/addr/${esc(u.addr)}" target="_blank" rel="noopener">${esc(u.addr)}</a></dd></div>
            <div class="adm-kv"><dt>链上余额 / 交易笔数</dt><dd class="num">${n(rec.chainBal)} 分 · ${n(u.tx_count)} 笔</dd></div>
            <div class="adm-kv"><dt>注册 / 最近登录</dt><dd>${dt(u.created_at)} · ${u.last_login ? dt(u.last_login) : '—'}</dd></div>
            <div class="adm-kv"><dt>等级</dt><dd>Lv.${u.level} · 经验 ${n(u.exp)}</dd></div>
          </dl>
        </div>
      </div>

      <div class="card mb5" style="box-shadow:none">
        <div class="card-h"><h3>${I('key', 14)} 三方对账</h3>
          <span class="tag ${rec.okLedgerVsStats && rec.okStatsVsChain ? 'ok' : 'bad'}">
            ${rec.okLedgerVsStats && rec.okStatsVsChain ? '一致' : '不平'}</span></div>
        <div class="card-b">
          <div class="adm-strip">
            <div class="adm-st"><b>${n(rec.ledgerNet)}</b><span>业务流水净额</span></div>
            <div class="adm-st"><b>${n(rec.statsBal)}</b><span>用户统计余额</span></div>
            <div class="adm-st"><b>${n(rec.chainBal)}</b><span>链上账户余额</span></div>
            <div class="adm-st"><b>${n(rec.ledgerRows)}</b><span>流水条数</span></div>
          </div>
          ${rec.okLedgerVsStats && rec.okStatsVsChain ? ''
      : `<div class="adm-note bad mt4">${I('alert', 15)}<div class="small">差额 ${n(rec.diff)} 分。
              说明这条链的账被绕过积分引擎动过，请对照审计日志查。</div></div>`}
        </div>
      </div>

      <div class="grid g2">
        <div class="card" style="box-shadow:none">
          <div class="card-h"><h3>最近 30 笔积分流水</h3></div>
          <div class="card-b" style="padding:0;max-height:290px;overflow:auto">
            <table class="tbl"><tbody>${r.ledger.map((l) => `<tr>
              <td><div class="t-main small">${esc(l.memo || l.type)}</div>
                <div class="t-sub">${dt(l.created_at)}${l.block_height !== null ? ` · 区块 #${l.block_height}` : ' · 待打包'}</div></td>
              <td class="r num" style="color:${l.direction > 0 ? 'var(--ok)' : 'var(--txt-2)'}">
                ${l.direction > 0 ? '+' : '−'}${n(l.amount)}</td>
              <td class="r num tiny dim">${n(l.balance_after)}</td>
            </tr>`).join('') || '<tr><td class="dim2">暂无流水</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card" style="box-shadow:none">
          <div class="card-h"><h3>风控告警</h3>
            <span class="tag ${r.alerts.some((a) => !a.handled) ? 'bad' : 'ok'}">${r.alerts.filter((a) => !a.handled).length} 条未处置</span></div>
          <div class="card-b" style="padding:0;max-height:290px;overflow:auto">
            <table class="tbl"><tbody>${r.alerts.map((a) => `<tr>
              <td><div class="t-main small">${esc(a.rule_name)}</div>
                <div class="t-sub">${esc(a.detail || '')}</div></td>
              <td class="r">${a.handled ? '<span class="tag">已处置</span>' : `<span class="tag ${a.level === 'high' ? 'bad' : 'warn'}">${RISK_LEVEL[a.level]}</span>`}</td>
            </tr>`).join('') || '<tr><td class="dim2">没有告警记录</td></tr>'}</tbody></table>
          </div>
        </div>
      </div>`,
    footer: `
      <button class="btn" data-act="noop">关闭</button>
      <button class="btn warn" data-x-ban>${I('shield', 14)} ${u.status ? '封禁账号' : '解封账号'}</button>
      <button class="btn pri" data-x-adjust>${I('coin', 14)} 人工调账</button>`,
  });

  m.el.querySelector('[data-act="noop"]').onclick = m.close;
  m.el.querySelector('[data-x-adjust]').onclick = () => { m.close(); openAdjust(u); };
  m.el.querySelector('[data-x-ban]').onclick = async () => {
    if (S.user.role !== 'admin') return toast('只有管理员能封禁/解封账号', 'warn');
    if (!(await confirmDlg(u.status ? '封禁账号' : '解封账号',
      u.status ? `封禁 ${u.nickname} 后，他将无法登录、不能签到与兑换。确定吗？`
        : `解封 ${u.nickname}？`))) return;
    try {
      await A.admUserStatus(u.id, u.status ? 0 : 1);
      toast(u.status ? '已封禁' : '已解封', 'warn');
      m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

const miniStat = (label, value) => `<div class="adm-st">
  <b style="font-size:16px">${esc(value)}</b><span>${esc(label)}</span></div>`;

async function openAdjust(u) {
  const m = modal({
    title: `人工调账 · ${u.nickname}`,
    body: `<div class="adm-note warn mb4" style="display:flex;gap:9px;align-items:flex-start">
        <span style="flex:none">${I('alert', 15)}</span>
        <div class="small">这是管理端唯一能「凭空」改用户余额的入口。它会<b>走积分引擎生成一笔真实的链上 ADJUST 交易</b>，
        而不是直接 UPDATE 数据库 —— 所以这笔调整在链浏览器上能查到，对账也不会破。</div></div>
      <div class="field"><label>调整金额（正数加分，负数扣分）</label>
        <input class="ctl" id="ajA" type="number" value="100"></div>
      <div class="field"><label>理由（至少 4 个字，会写进审计日志和链上备注）</label>
        <input class="ctl" id="ajR" placeholder="例如：活动补发 / 误判撤销 / 客服补偿"></div>
      <div class="field"><label>当前余额</label>
        <input class="ctl" value="${n(u.balance)} 分" disabled></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>确认调账</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const amount = Number($('#ajA').value);
    const reason = $('#ajR').value.trim();
    if (!amount) return toast('金额不能为 0', 'warn');
    if (reason.length < 4) return toast('理由至少 4 个字', 'warn');
    try {
      const r = await A.admAdjust({ userId: u.id, amount, reason });
      toast(`已调账 ${amount > 0 ? '+' : ''}${amount} 分，余额 ${n(r.balanceAfter)} 分`);
      toast('已生成链上交易 ' + shortHash(r.txid, 10, 6), 'info');
      m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 视图：积分规则 ============================ */
async function viewRules() {
  head({
    title: '积分规则',
    subtitle: '规则不是覆盖写，而是<b>加新版本</b>：任何一笔积分都能追溯到当时生效的是哪一版，每次改动都会生成一笔 RULE 交易上链存证。',
    acts: [`<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(220)}</div></div>`;
  const r = await A.admRules();

  v.innerHTML = `
  <div class="kgrid">
    ${miniStat('生效规则数', r.active.length + ' 条')}
    ${miniStat('历史版本总数', r.totalRules + ' 条')}
    ${miniStat('当前最高版本', 'v' + Math.max(...r.active.map((x) => Number(x.version))))}
  </div>

  <div class="grid g2 mt5">
    ${r.active.map((x) => `<div class="card">
      <div class="card-h"><h3>${esc(x.rule_name)}</h3>
        <span class="tag brand">v${x.version}</span></div>
      <div class="card-b">
        <div class="row-b" style="align-items:baseline">
          <div style="font-size:28px;font-weight:800;letter-spacing:-.035em">
            ${n(x.val_num)}<span class="small dim" style="font-weight:500;margin-left:3px">${esc(RULE_UNIT[x.unit] || '')}</span></div>
          <button class="btn sm" data-act="editRule" data-k="${esc(x.rule_key)}">调整</button>
        </div>
        ${x.val_text ? `<div class="small dim mt3">阶梯：<span class="mono">${esc(x.val_text)}</span></div>` : ''}
        <div class="small dim2 mt3">规则键 <span class="mono">${esc(x.rule_key)}</span></div>
        ${x.txid ? `<div class="mt3"><a class="hash" href="/chain#/tx/${esc(x.txid)}" target="_blank"
          rel="noopener">${I('cube', 11)}本版存证交易</a></div>` : ''}
      </div>
    </div>`).join('')}
  </div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('book', 15)} 版本历史 <span class="hsub">改过的每一版都留着</span></h3></div>
    <div class="card-b flush">
      <div class="tbl-wrap" style="max-height:460px">
        <table class="tbl">
          <thead><tr><th>规则</th><th class="c">版本</th><th class="r">数值</th><th>阶梯</th>
            <th>变更理由</th><th class="c">状态</th><th class="r">时间</th></tr></thead>
          <tbody>${r.history.map((h) => `<tr>
            <td><div class="t-main">${esc(h.rule_name)}</div><div class="t-sub mono">${esc(h.rule_key)}</div></td>
            <td class="c"><span class="tag ${h.active ? 'brand' : ''}">v${h.version}</span></td>
            <td class="r num">${n(h.val_num)} ${esc(RULE_UNIT[h.unit] || '')}</td>
            <td class="small dim">${esc(h.val_text || '—')}</td>
            <td class="small dim">${esc(h.reason || '初始版本')}</td>
            <td class="c">${h.active ? '<span class="tag ok">生效中</span>' : '<span class="tag">已归档</span>'}</td>
            <td class="r tiny dim">${dt(h.created_at)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

async function openEditRule(ruleKey) {
  const r = await A.admRules();
  const cur = r.active.find((x) => x.rule_key === ruleKey);
  if (!cur) return toast('规则不存在', 'bad');
  const m = modal({
    title: `调整规则 · ${cur.rule_name}`,
    body: `<div class="adm-note mb4" style="display:flex;gap:9px;align-items:flex-start">
        <span style="flex:none">${I('info', 15)}</span>
        <div class="small">保存后当前版本 v${cur.version} 会被归档，新版本 v${Number(cur.version) + 1} 生效，
        并生成一笔 <b>RULE</b> 交易上链存证。历史积分不受影响（当时按哪一版算的，流水里记着）。</div></div>
      <div class="field"><label>数值（${esc(RULE_UNIT[cur.unit] || '')}）</label>
        <input class="ctl" id="ruV" type="number" value="${Number(cur.val_num)}"></div>
      <div class="field"><label>阶梯说明（可选）</label>
        <input class="ctl" id="ruT" value="${esc(cur.val_text || '')}" placeholder="例如 7:5,14:10,30:30"></div>
      <div class="field"><label>变更理由（必填，至少 4 个字）</label>
        <input class="ctl" id="ruR" placeholder="例如：连续加成激励不足，7 天档提高"></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>保存并上链</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const val_num = Number($('#ruV').value);
    const val_text = $('#ruT').value.trim();
    const reason = $('#ruR').value.trim();
    if (reason.length < 4) return toast('变更理由至少 4 个字', 'warn');
    try {
      const res = await A.admSaveRule({ rule_key: ruleKey, val_num, val_text, reason });
      toast(`已生效 v${res.version}，链上存证 ${shortHash(res.txid, 10, 6)}`);
      m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 视图：奖励商品 ============================ */
async function viewRewards() {
  head({
    title: '奖励商品',
    subtitle: '按库存从少到多排 —— 库存见底的排在前面，这才是有用的顺序。',
    acts: [
      `<button class="btn pri" data-act="addReward">${I('plus', 14)} 上架新商品</button>`,
      `<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`,
    ],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(240)}</div></div>`;
  const r = await A.admRewards();
  const low = r.list.filter((x) => Number(x.stock) < 10 && x.status && x.category !== 'charity').length;

  v.innerHTML = `
  ${low ? `<div class="adm-note warn mb4">${I('alert', 15)}
    <div class="small"><b>${low} 件商品库存低于 10</b>。库存见底会让用户兑不到东西，建议今天就补。</div></div>` : ''}
  <div class="card">
    <div class="card-h"><h3>${I('gift', 15)} 商品与库存</h3>
      <span class="small dim2">兑换消耗的积分会转入销毁账户，链上可查通缩量</span></div>
    <div class="card-b flush">
      <div class="tbl-wrap" style="max-height:600px">
        <table class="tbl">
          <thead><tr><th>商品</th><th class="c">类型</th><th class="r">所需积分</th>
            <th class="r">库存</th><th class="r">已兑</th><th class="c">限兑</th>
            <th class="c">状态</th><th class="r">操作</th></tr></thead>
          <tbody>${r.list.map((x) => `<tr>
            <td><div class="row gap3">
              <span style="width:30px;height:30px;border-radius:10px;flex:none;display:grid;place-items:center;color:#fff;
                background:linear-gradient(135deg,${esc(x.cover_color || '#6366f1')},${esc(x.cover_color || '#6366f1')}bb)">
                ${I(x.category === 'course' ? 'book' : x.category === 'coupon' ? 'gift' : x.category === 'charity' ? 'heart' : 'cube', 15)}</span>
              <div><div class="t-main">${esc(x.name)}</div>
                <div class="t-sub">${esc((x.descr || '').slice(0, 40))}</div></div></div></td>
            <td class="c"><span class="tag">${esc(REDEEM_CAT[x.category] || x.category)}</span></td>
            <td class="r num"><b>${n(x.cost)}</b></td>
            <td class="r num" style="color:${Number(x.stock) < 10 ? 'var(--bad)' : 'inherit'}">
              <b>${n(x.stock)}</b></td>
            <td class="r num dim">${n(x.orders)}</td>
            <td class="c tiny dim">${n(x.per_limit)}</td>
            <td class="c">${x.status ? '<span class="tag ok">在售</span>' : '<span class="tag">下架</span>'}</td>
            <td class="r"><button class="btn sm" data-act="editReward" data-id="${x.id}"
              data-stock="${x.stock}" data-name="${esc(x.name)}">改库存/价格</button></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

async function openEditReward(id, stock, name) {
  const m = modal({
    title: `修改商品 · ${name}`,
    body: `<div class="field"><label>库存</label><input class="ctl" id="rwS" type="number" value="${stock}"></div>
      <div class="field"><label>所需积分</label><input class="ctl" id="rwC" type="number" placeholder="留空表示不改"></div>
      <div class="field"><label>状态</label>
        <select class="ctl" id="rwT"><option value="1">在售</option><option value="0">下架</option></select></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>保存</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const body = { stock: Number($('#rwS').value), status: Number($('#rwT').value) };
    const c = $('#rwC').value.trim();
    if (c) body.cost = Number(c);
    try { await A.admUpdReward(id, body); toast('已保存'); m.close(); route(); } catch (e) { toast(e.message, 'bad'); }
  };
}

async function openAddReward() {
  const m = modal({
    title: '上架新商品',
    body: `<div class="field"><label>商品名</label>
        <input class="ctl" id="nwN" placeholder="例如：图书馆座位预约券"></div>
      <div class="field"><label>类型</label>
        <select class="ctl" id="nwC">
          <option value="coupon">券码</option><option value="course">课程</option>
          <option value="goods" selected>实物</option><option value="virtual">虚拟</option>
          <option value="charity">公益</option></select></div>
      <div class="grid g2" style="gap:12px">
        <div class="field"><label>所需积分</label><input class="ctl" id="nwP" type="number" value="80"></div>
        <div class="field"><label>库存</label><input class="ctl" id="nwS" type="number" value="50"></div>
      </div>
      <div class="field"><label>简介</label><input class="ctl" id="nwD" placeholder="一句话说清能换到什么"></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>上架</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const name = $('#nwN').value.trim();
    if (!name) return toast('商品名必填', 'warn');
    try {
      await A.admAddReward({ name, category: $('#nwC').value, cost: Number($('#nwP').value),
        stock: Number($('#nwS').value), descr: $('#nwD').value.trim() });
      toast('已上架'); m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 视图：兑换订单 ============================ */
async function viewOrders() {
  const q = S.q;
  head({
    title: '兑换订单',
    subtitle: '订单状态流转：待发货 → 已发货 → 已完成。每次流转都写审计日志。',
    acts: [`<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(240)}</div></div>`;
  const r = await A.admRedemptions(q);
  const st = [['', '全部'], ['paid', '待发货'], ['shipped', '已发货'], ['done', '已完成'], ['cancel', '已取消']];

  v.innerHTML = `
  <div class="card">
    <div class="card-h"><h3>${I('wallet', 15)} 订单列表</h3>
      <div class="row gap2">
        <div class="field" style="margin:0"><input class="ctl" id="oq" style="width:200px;min-height:34px;padding:6px 11px"
          placeholder="搜订单号 / 用户" value="${esc(q.q || '')}"></div>
        <button class="btn sm pri" data-act="osearch">${I('search', 13)} 搜索</button>
      </div></div>
    <div class="card-b" style="padding-bottom:0">${chipRow(st, q.status || '', 'ostatus', 's')}</div>
    <div class="card-b flush">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>订单号</th><th>用户</th><th>商品</th><th class="r">消耗积分</th>
            <th class="c">数量</th><th class="c">状态</th><th class="r">下单时间</th><th class="r">操作</th></tr></thead>
          <tbody>${r.list.map((x) => `<tr>
            <td><div class="t-main mono" style="font-size:12px">${esc(x.order_no)}</div>
              <div class="t-sub">${x.txid ? `<a class="hash" href="/chain#/tx/${esc(x.txid)}" target="_blank"
                rel="noopener">${shortHash(x.txid, 8, 5)}</a>` : '未上链'}</div></td>
            <td><div class="t-main small">${esc(x.nickname)}</div>
              <div class="t-sub mono">${shortHash(x.addr, 8, 5)}</div></td>
            <td>${esc(x.reward_name)} <span class="tag" style="margin-left:4px">${esc(REDEEM_CAT[x.category] || x.category)}</span></td>
            <td class="r num"><b>${n(x.cost)}</b></td>
            <td class="c num">${n(x.qty)}</td>
            <td class="c"><span class="tag ${x.status === 'done' ? 'ok' : x.status === 'cancel' ? 'bad' : x.status === 'paid' ? 'warn' : ''}">
              ${esc(ORDER_STATUS[x.status] || x.status)}</span></td>
            <td class="r tiny dim">${dt(x.created_at)}</td>
            <td class="r"><select class="ctl" style="min-height:30px;padding:4px 26px 4px 8px;font-size:12px"
              data-act="oset" data-id="${x.id}">
              ${Object.entries(ORDER_STATUS).map(([k, t]) =>
    `<option value="${k}" ${x.status === k ? 'selected' : ''}>${t}</option>`).join('')}
            </select></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${pagerHTML({ page: r.page }, r.total, r.size)}
    </div>
  </div>`;

  const doSearch = () => { S.q = { ...S.q, q: $('#oq').value.trim(), page: 1 }; route(); };
  const b = $('[data-act="osearch"]'); if (b) b.onclick = doSearch;
  const i = $('#oq'); if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

/* ============================ 视图：风控 ============================ */
async function viewRisk() {
  const q = S.q;
  head({
    title: '风控',
    subtitle: '刷分会直接稀释真实用户的积分价值。这里按「规则 × 等级」聚合并可逐条处置；处置动作写审计日志。',
    acts: [`<button class="btn pri" data-act="sweep">${I('shield', 14)} 跑一次扫描</button>`,
      `<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(260)}</div></div>`;
  const r = await A.admRisk(q);
  const ov = r.overview;
  const lv = [['', '全部'], ['high', '高危'], ['mid', '中危'], ['low', '低危']];
  const hd = [['0', '未处置'], ['1', '已处置'], ['', '全部']];

  v.innerHTML = `
  <div class="kgrid mb5">
    ${miniStat('总告警数', n(ov.total) + ' 条')}
    ${miniStat('未处置', n(ov.open) + ' 条')}
    ${miniStat('高危未处置', n(ov.high || 0) + ' 条')}
    ${miniStat('涉及用户', n(ov.users) + ' 个')}
  </div>

  ${ov.byRule && ov.byRule.length ? `<div class="card mb5">
    <div class="card-h"><h3>${I('chart', 15)} 命中规则分布</h3>
      <span class="small dim2">哪条规则抓得最多，说明它就是主要作弊手法</span></div>
    <div class="card-b">${C.hbars(ov.byRule.map((x) => ({ label: x.rule_name, v: Number(x.n) })), { unit: ' 次' })}</div>
  </div>` : ''}

  <div class="card">
    <div class="card-h"><h3>${I('alert', 15)} 告警明细</h3>
      <div class="row gap2">
        <button class="chip ${q.sort === 'level_desc' ? 'on' : ''}" data-act="rsort" data-s="level_desc">按等级排序</button>
        <button class="chip ${q.sort !== 'level_desc' ? 'on' : ''}" data-act="rsort" data-s="id">按时间排序</button>
      </div></div>
    <div class="card-b" style="padding-bottom:0">
      <div class="mb3">${chipRow(lv, q.level || '', 'rlevel', 's')}</div>
      ${chipRow(hd, q.handled === undefined || q.handled === '' ? '' : q.handled, 'rhandled', 's')}
    </div>
    <div class="card-b flush">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th class="c">等级</th><th>规则 / 命中说明</th><th>用户</th><th>证据</th>
            <th class="c">状态</th><th class="r">时间</th><th class="r">操作</th></tr></thead>
          <tbody>${r.list.map((x) => `<tr>
            <td class="c"><span class="tag ${x.level === 'high' ? 'bad' : x.level === 'mid' ? 'warn' : ''}">
              ${RISK_LEVEL[x.level] || x.level}</span></td>
            <td><div class="t-main">${esc(x.rule_name)}</div>
              <div class="t-sub">${esc(x.detail || '')}</div>
              <div class="t-sub mono">${esc(x.rule_code)}</div></td>
            <td><div class="t-main small">${esc(x.nickname)}</div>
              <div class="t-sub">累计签到 ${n(x.ck_total)} 天 · ${x.user_status ? '正常' : '已封禁'}</div></td>
            <td class="small mono dim" style="max-width:190px;overflow:hidden;text-overflow:ellipsis">${esc(x.evidence || '—')}</td>
            <td class="c">${x.handled ? `<span class="tag ok">已处置</span>
              <div class="t-sub">${esc(x.handle_note || '')}</div>` : '<span class="tag warn">待处置</span>'}</td>
            <td class="r tiny dim">${dt(x.created_at)}</td>
            <td class="r">${x.handled ? '' : `<button class="btn sm" data-act="handleRisk"
              data-id="${x.id}" data-name="${esc(x.nickname)}" data-rule="${esc(x.rule_name)}">处置</button>`}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${pagerHTML({ page: r.page }, r.total, r.size)}
    </div>
  </div>`;
}

async function openHandleRisk(id, name, rule) {
  const m = modal({
    title: `处置告警 · ${name}`,
    body: `<div class="adm-note mb4" style="display:flex;gap:9px;align-items:flex-start">
        <span style="flex:none">${I('alert', 15)}</span>
        <div class="small">处置只记录结论，不会自动扣回积分 —— 要扣分请用「人工调账」，那样才会生成链上交易。</div></div>
      <div class="field"><label>命中规则</label><input class="ctl" value="${esc(rule)}" disabled></div>
      <div class="field"><label>处置说明</label>
        <input class="ctl" id="hrN" placeholder="例如：核实为误报 / 已警告 / 确认刷分已追回"></div>
      <div class="field"><label class="row gap2" style="cursor:pointer">
        <input type="checkbox" id="hrB"> <span>同时封禁该账号</span></label>
        <div class="help">封禁后对方无法登录、签到与兑换。只有管理员能操作。</div></div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn warn" data-yes>确认处置</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const note = $('#hrN').value.trim();
    const ban = $('#hrB').checked;
    if (ban && S.user.role !== 'admin') return toast('只有管理员能封禁账号', 'warn');
    try {
      await A.admHandleRisk(id, { note, ban });
      toast(ban ? '已处置并封禁账号' : '已处置', 'warn');
      m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 视图：链路运维 ============================ */
async function viewChain() {
  head({
    title: '链路运维',
    subtitle: '挖矿难度、交易池、出块、全链校验。调难度最能说明 PoW 是什么：难度 4→5，工作量直接 ×16，出块立刻变慢。',
    acts: [`<button class="btn pri" data-act="mine">${I('hammer', 14)} 立即出块</button>`,
      `<button class="btn" data-act="validate">${I('shield', 14)} 跑一次全链校验</button>`,
      `<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(260)}</div></div>`;
  const r = await A.admChain();
  const s = r.stats, cfg = r.config;
  const lvDiag = [3, 4, 5, 6];
  const est = { 3: '约 20 ms / 块', 4: '约 200 ms / 块', 5: '约 3 秒 / 块', 6: '约 50 秒 / 块' };

  v.innerHTML = `
  <div class="grid g4 mb5">
    ${miniStat('区块高度', n(s.height))}
    ${miniStat('交易总数', n(s.tx_count))}
    ${miniStat('待打包', n(s.pending) + ' 笔')}
    ${miniStat('平均出块', n(s.avg_mined_ms) + ' ms')}
  </div>

  <div class="grid g-2-1">
    <div class="card">
      <div class="card-h"><h3>${I('hammer', 15)} 挖矿难度</h3>
        <span class="tag brand">当前 ${cfg.difficulty}</span></div>
      <div class="card-b">
        <div class="small dim mb4">难度 = 区块哈希要求的前导零个数。每 +1，期望尝试次数 ×16。
          现场按一下就能感受到「算力换安全」这句话是什么意思。</div>
        <div class="row gap2" style="flex-wrap:wrap">
          ${lvDiag.map((d) => `<button class="btn ${d === Number(cfg.difficulty) ? 'pri' : ''}"
            data-act="setDiff" data-d="${d}">难度 ${d}<span class="tiny dim" style="margin-left:5px">${est[d]}</span></button>`).join('')}
        </div>
        <div class="adm-strip mt5">
          <div class="adm-st"><b>${n(cfg.maxTxPerBlock)}</b><span>每块最多打包笔数</span></div>
          <div class="adm-st"><b>${n(cfg.intervalMs)} ms</b><span>出块检查间隔</span></div>
          <div class="adm-st"><b>${n(cfg.targetMs)} ms</b><span>目标出块耗时</span></div>
          <div class="adm-st"><b>${n(r.suggest)}</b><span>算法建议难度</span></div>
        </div>
        <div class="small dim2 mt3">建议值由最近区块的平均耗时算出，只作参考，实际难度以手动设置为准。</div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${I('key', 15)} 系统账户</h3></div>
      <div class="card-b" style="padding:0;max-height:300px;overflow:auto">
        <table class="tbl"><tbody>${r.accounts.map((a) => `<tr>
          <td><div class="t-main mono" style="font-size:12px">
            <a class="hash" href="/chain#/addr/${esc(a.addr)}" target="_blank" rel="noopener">${esc(a.addr)}</a></div>
            <div class="t-sub">${esc(a.label || '')}</div></td>
          <td class="r num"><b>${n(a.on_chain)}</b><div class="t-sub">交易 ${n(a.tx_count)} 笔</div></td>
        </tr>`).join('')}</tbody></table>
      </div>
    </div>
  </div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('clock', 15)} 交易池 <span class="hsub">还没被打包的交易</span></h3>
      <span class="tag ${r.pool.length ? 'warn' : 'ok'}">${r.pool.length} 笔</span></div>
    <div class="card-b flush">
      <div class="tbl-wrap" style="max-height:340px">
        <table class="tbl">
          <thead><tr><th>交易号</th><th class="c">类型</th><th>付款方</th><th>收款方</th>
            <th class="r">金额</th><th>备注</th><th class="r">进入池子</th></tr></thead>
          <tbody>${r.pool.map((t) => `<tr>
            <td><a class="hash" href="/chain#/tx/${esc(t.txid)}" target="_blank" rel="noopener">${shortHash(t.txid, 9, 6)}</a></td>
            <td class="c"><span class="tag chain">${esc(t.typeCN || t.type)}</span></td>
            <td class="mono small">${esc(shortHash(t.from_addr, 8, 5))}</td>
            <td class="mono small">${esc(shortHash(t.to_addr, 8, 5))}</td>
            <td class="r num">${n(t.amount)}</td>
            <td class="small dim" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(t.memo || '')}</td>
            <td class="r tiny dim">${ago(t.ts)}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="dim2" style="padding:22px">交易池是空的 —— 所有交易都已打包。</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('shield', 15)} 最近一次全链校验</h3>
      <span class="tag ${r.validate.ok ? 'ok' : 'bad'}">${r.validate.ok ? '通过' : '失败'}</span></div>
    <div class="card-b">
      <div class="verdict ${r.validate.ok ? 'ok' : 'bad'}">
        <h3>${I(r.validate.ok ? 'okc' : 'alert', 18)} ${r.validate.ok ? '链是完整的' : `在第 ${r.validate.badHeight} 块被抓住`}</h3>
        <p class="small mt3" style="color:${r.validate.ok ? '#067A5B' : '#8B1E32'}">${esc(r.validate.reason)}</p>
      </div>
      <div class="small dim2 mt4">校验覆盖：高度连续性 · 前哈希链接 · 区块头自洽 · 工作量目标 · Merkle 根 · 每笔交易的内容哈希与 Ed25519 签名。</div>
    </div>
  </div>`;
}

/* ============================ 视图：对账台 ============================ */
async function viewReconcile() {
  head({
    title: '对账台',
    subtitle: '把「业务流水 / 用户汇总 / 链上账户」三方摆在一起。任何一方对不上，就说明数据被绕过积分引擎动过。',
    acts: [`<button class="btn" data-act="reload">${I('refresh', 14)} 重新对账</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(260)}</div></div>`;
  const r = await A.admReconcile();

  const byType = {};
  r.ledgerByType.forEach((x) => {
    const k = x.type;
    if (!byType[k]) byType[k] = { type: k, in: 0, out: 0, n: 0 };
    if (Number(x.direction) > 0) byType[k].in = Number(x.amt); else byType[k].out = Number(x.amt);
    byType[k].n += Number(x.n);
  });

  v.innerHTML = `
  <div class="verdict ${r.ok ? 'ok' : 'bad'} mb5">
    <h3>${I(r.ok ? 'okc' : 'alert', 20)} ${r.ok ? '三方对账一致' : `有 ${r.mismatch.length} 个用户对不上`}</h3>
    <p class="small mt3" style="color:${r.ok ? '#067A5B' : '#8B1E32'}">
      ${r.ok
    ? `扫描了 ${n(r.users)} 个用户：每个人的「业务流水净额 = 用户统计余额 = 链上账户余额」都相等。`
    : '下面列出了具体是哪些用户、差多少。请对照审计日志查是谁动的。'}
    </p>
  </div>

  <div class="grid g4 mb5">
    ${miniStat('业务流水净额', n(r.balance.ledger) + ' 分')}
    ${miniStat('用户汇总余额', n(r.balance.users) + ' 分')}
    ${miniStat('链上发行总量', n(r.balance.chainIssued) + ' 分')}
    ${miniStat('链上已销毁', n(r.balance.chainBurned) + ' 分')}
  </div>

  <div class="grid g-2-1">
    <div class="card">
      <div class="card-h"><h3>${I('book', 15)} 按类型拆积分流向</h3>
        <span class="small dim2">这张表能解释「积分是怎么发出去、又怎么被回收的」</span></div>
      <div class="card-b flush">
        <div class="tbl-wrap" style="max-height:420px">
          <table class="tbl">
            <thead><tr><th>类型</th><th class="r">笔数</th><th class="r">发放</th><th class="r">消耗</th><th class="r">净额</th></tr></thead>
            <tbody>${Object.values(byType).sort((a, b) => b.n - a.n).map((x) => `<tr>
              <td><div class="t-main">${esc(TYPE_CN[x.type] || x.type)}</div><div class="t-sub mono">${esc(x.type)}</div></td>
              <td class="r num">${n(x.n)}</td>
              <td class="r num" style="color:var(--ok)">${x.in ? '+' + n(x.in) : '<span class="dim2">—</span>'}</td>
              <td class="r num">${x.out ? '−' + n(x.out) : '<span class="dim2">—</span>'}</td>
              <td class="r num"><b>${n(x.in - x.out)}</b></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${I('key', 15)} 系统账户余额</h3></div>
      <div class="card-b flush">
        <table class="tbl"><tbody>${r.systems.map((a) => `<tr>
          <td><div class="t-main mono" style="font-size:12px">${esc(a.addr)}</div>
            <div class="t-sub">${esc(a.label || '')}</div></td>
          <td class="r num"><b>${n(a.on_chain)}</b></td>
        </tr>`).join('')}</tbody></table>
      </div>
      <div class="card-b" style="border-top:1px solid var(--line)">
        <div class="small dim">销毁账户余额就是「累计通缩量」；奖池余额是全体押注失败者的本金，
          用来给达成者发奖。两者都在链上公开可查，平台改不了。</div>
      </div>
    </div>
  </div>

  ${r.mismatch.length ? `<div class="card mt5">
    <div class="card-h"><h3>${I('alert', 15)} 对不上的用户</h3></div>
    <div class="card-b flush">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>用户</th><th class="r">流水净额</th><th class="r">汇总余额</th><th class="r">链上余额</th><th class="r">差额</th></tr></thead>
          <tbody>${r.mismatch.map((x) => `<tr>
            <td><div class="t-main">${esc(x.nickname)}</div><div class="t-sub">#${x.id}</div></td>
            <td class="r num">${n(x.ledger_net)}</td>
            <td class="r num">${n(x.stats_bal)}</td>
            <td class="r num">${n(x.chain_bal)}</td>
            <td class="r num" style="color:var(--bad)"><b>${n(Number(x.stats_bal) - Number(x.chain_bal))}</b></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>` : ''}`;
}

const TYPE_CN = {
  checkin: '签到奖励', task: '任务完成', daybonus: '当日全清', badge: '徽章铸造', redeem: '商城兑换',
  donate: '公益捐赠', stake: '押注锁定', settle: '押注结算', pool: '罚金入池', burn: '销毁',
  transfer: '积分转账', adjust: '人工调账', GENESIS: '创世发行', ADJUST: '人工调账',
};

/* ============================ 视图：公告 ============================ */
async function viewAnnounce() {
  head({
    title: '公告',
    subtitle: '发布与下架都会写审计日志。用户端首页会显示置顶公告。',
    acts: [`<button class="btn pri" data-act="addAnno">${I('plus', 14)} 发布公告</button>`,
      `<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(240)}</div></div>`;
  const r = await A.admAnnouncements();
  const CAT = { notice: '通知', rule: '规则', activity: '活动', maintain: '维护' };

  v.innerHTML = `
  <div class="card">
    <div class="card-h"><h3>${I('bell', 15)} 公告列表</h3>
      <span class="small dim2">共 ${n(r.list.length)} 条（显示最近 60 条）</span></div>
    <div class="card-b flush">
      <div class="tbl-wrap" style="max-height:640px">
        <table class="tbl">
          <thead><tr><th>标题</th><th class="c">分类</th><th class="c">置顶</th>
            <th class="r">浏览</th><th class="r">发布时间</th><th class="r">操作</th></tr></thead>
          <tbody>${r.list.map((x) => `<tr style="${x.status ? '' : 'opacity:.5'}">
            <td><div class="t-main">${x.pinned ? `<span class="tag brand" style="margin-right:5px">置顶</span>` : ''}${esc(x.title)}</div>
              <div class="t-sub">${esc((x.content || '').slice(0, 70))}</div></td>
            <td class="c"><span class="tag">${esc(CAT[x.category] || x.category)}</span></td>
            <td class="c">${x.pinned ? I('star', 13) : '<span class="dim2">—</span>'}</td>
            <td class="r num dim">${n(x.views)}</td>
            <td class="r tiny dim">${dt(x.created_at)}</td>
            <td class="r">${x.status
    ? `<button class="btn sm" data-act="delAnno" data-id="${x.id}">下架</button>`
    : '<span class="tag">已下架</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

async function openAddAnno() {
  const m = modal({
    title: '发布公告',
    body: `<div class="field"><label>标题</label>
        <input class="ctl" id="anT" placeholder="例如：积分规则第 2 版生效" maxlength="80"></div>
      <div class="field"><label>正文</label>
        <textarea class="ctl" id="anC" rows="4" placeholder="说清改了什么都行"></textarea></div>
      <div class="grid g2" style="gap:12px">
        <div class="field"><label>分类</label>
          <select class="ctl" id="anK">
            <option value="notice">通知</option><option value="rule">规则</option>
            <option value="activity">活动</option><option value="maintain">维护</option></select></div>
        <div class="field"><label class="row gap2" style="cursor:pointer;margin-top:24px">
          <input type="checkbox" id="anP"> <span>置顶显示</span></label></div>
      </div>`,
    footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>发布</button>`,
  });
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = async () => {
    const title = $('#anT').value.trim();
    if (!title) return toast('标题不能为空', 'warn');
    try {
      await A.admAddAnnounce({ title, content: $('#anC').value.trim(),
        category: $('#anK').value, pinned: $('#anP').checked });
      toast('已发布'); m.close(); route();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================ 视图：审计日志 ============================ */
async function viewAudit() {
  const q = S.q;
  head({
    title: '审计日志',
    subtitle: '每次封禁、调账、改规则、处置告警、出块都会写在这里。涉及钱的动作还会带上链上交易号。',
    acts: [`<button class="btn" data-act="reload">${I('refresh', 14)} 刷新</button>`],
  });
  const v = $('#view');
  v.innerHTML = `<div class="card"><div class="card-b">${skel(240)}</div></div>`;
  const r = await A.admAudit(q);

  v.innerHTML = `
  <div class="card">
    <div class="card-h"><h3>${I('book', 15)} 操作记录</h3>
      <div class="row gap2">
        <div class="field" style="margin:0"><input class="ctl" id="aq" style="width:180px;min-height:34px;padding:6px 11px"
          placeholder="搜操作名，如「调账」" value="${esc(q.action || '')}"></div>
        <button class="btn sm pri" data-act="asearch">${I('search', 13)} 筛选</button>
      </div></div>
    <div class="card-b flush">
      <div class="tbl-wrap" style="max-height:640px">
        <table class="tbl">
          <thead><tr><th>操作</th><th>对象 / 详情</th><th>操作人</th><th class="c">IP</th>
            <th>链上交易</th><th class="r">时间</th></tr></thead>
          <tbody>${r.list.map((x) => `<tr>
            <td><div class="t-main">${esc(x.action)}</div><div class="t-sub mono">${esc(x.target || '')}</div></td>
            <td class="small dim" style="max-width:420px">${esc(x.detail || '')}</td>
            <td><div class="t-main small">${esc(x.nickname || '—')}</div>
              <div class="t-sub">${x.actor_role === 'admin' ? '管理员' : x.actor_role === 'operator' ? '运营' : esc(x.actor_role_name || '')}</div></td>
            <td class="c tiny mono dim">${esc(x.ip || '—')}</td>
            <td>${x.txid ? `<a class="hash" href="/chain#/tx/${esc(x.txid)}" target="_blank"
              rel="noopener">${shortHash(x.txid, 8, 5)}</a>` : '<span class="dim2">—</span>'}</td>
            <td class="r tiny dim">${dt(x.created_at)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${pagerHTML({ page: r.page }, r.total, r.size)}
    </div>
  </div>`;

  const go = () => { S.q = { ...S.q, action: $('#aq').value.trim(), page: 1 }; route(); };
  const b = $('[data-act="asearch"]'); if (b) b.onclick = go;
  const i = $('#aq'); if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* ============================ 视图：数据看板 ============================ */
async function viewAnalytics() {
  const days = Number(S.q.days) || 21;
  head({
    title: '数据看板',
    subtitle: `最近 ${days} 个「已结束」的自然日：签到、任务、积分发行与用户分布。今天仍在进行中，不计入趋势。图表全部手写 SVG，不依赖 CDN。`,
    acts: [chipRow([[7, '近 7 天'], [21, '近 21 天'], [42, '近 42 天']], days, 'adays', 'd')],
  });
  const v = $('#view');
  v.innerHTML = `<div class="grid g2">${skel(200)}${skel(200)}</div>`;
  const r = await A.admAnalytics(days);

  const daily = r.daily.map((d) => ({ x: String(d.day).slice(5), a: Number(d.issued),
    b: Number(d.consumed), v: Number(d.checkin_users) }));
  const doneRate = r.daily.map((d) => ({
    x: String(d.day).slice(5), y: pct(Number(d.done_tasks), Number(d.tasks)),
  }));

  v.innerHTML = `
  <div class="grid g-2-1">
    <div class="card">
      <div class="card-h"><h3>${I('chart', 15)} 积分发行与消耗</h3>
        <span class="small dim2">两条线的间距就是「净增发的压力」</span></div>
      <div class="card-b">${daily.length ? C.area2(daily, { height: 210 }) : empty('暂无数据')}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('target', 15)} 用户转化漏斗</h3></div>
      <div class="card-b">${C.funnel([
    { label: '注册用户', v: Number(r.funnel.users) },
    { label: '签过到', v: Number(r.funnel.checked) },
    { label: '完成过任务', v: Number(r.funnel.did_task) },
    { label: '有成就徽章', v: Number(r.funnel.has_badge) },
    { label: '兑换过商品', v: Number(r.funnel.redeemed) },
    { label: '捐过积分', v: Number(r.funnel.donated) },
  ])}</div>
    </div>
  </div>

  <div class="grid g2 mt5">
    <div class="card">
      <div class="card-h"><h3>${I('calendar', 15)} 每日签到人数</h3></div>
      <div class="card-b">${C.vbars(r.daily.map((d) => ({ x: String(d.day).slice(5), y: Number(d.checkin_users) })),
    { unit: ' 人', slice: 5 })}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('check', 15)} 每日任务完成率</h3></div>
      <div class="card-b">${C.area(doneRate, { height: 190, max: 100, color: '#10B981', color2: '#059669' })}</div>
    </div>
  </div>

  <div class="grid g3 mt5">
    <div class="card">
      <div class="card-h"><h3>${I('coin', 15)} 余额分布</h3></div>
      <div class="card-b">
        ${C.hbars(r.dist.map((x) => ({ label: x.bucket + ' 分', v: Number(x.n) })), { unit: ' 人' })}
        <div class="small dim2 mt4">看尾部有没有长尾：如果绝大多数人余额很低，说明积分留不住。</div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('star', 15)} 任务分类构成</h3></div>
      <div class="card-b">
        ${C.donut(r.byCategory.slice(0, 6).map((x, i) => ({
    label: x.category, v: Number(x.n),
    color: ['#5B6CFF', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#F43F5E'][i],
  })), { centerLabel: '任务数' })}
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('clock', 15)} 积分动作的小时分布</h3></div>
      <div class="card-b">
        ${C.hourHeat(r.hourHeat)}
        <div class="small dim2 mt4">高峰时段是运营发消息的最佳时间；凌晨的异常活跃往往是刷分。</div>
      </div>
    </div>
  </div>

  <div class="grid g2 mt5">
    <div class="card">
      <div class="card-h"><h3>${I('flame', 15)} 最受欢迎的徽章</h3></div>
      <div class="card-b flush">
        <table class="tbl">
          <thead><tr><th>徽章</th><th class="c">等级</th><th class="r">需要积分</th><th class="r">已发放</th><th class="r">发放率</th></tr></thead>
          <tbody>${r.badgeHot.map((b) => `<tr>
            <td><div class="t-main">${esc(b.name)}</div><div class="t-sub mono">${esc(b.category)}</div></td>
            <td class="c"><span class="tag ${b.level >= 4 ? 'brand' : ''}">${['', '铜', '银', '金', '钻石'][b.level] || b.level}</span></td>
            <td class="r num">${n(b.cost)}</td>
            <td class="r num"><b>${n(b.claims)}</b></td>
            <td class="r num dim">${pct(b.claims, r.funnel.users)}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('trophy', 15)} 自习室排行</h3></div>
      <div class="card-b flush">
        <table class="tbl">
          <thead><tr><th class="c">#</th><th>自习室</th><th>房主</th><th class="r">成员</th>
            <th class="r">总积分</th><th class="r">今日打卡率</th></tr></thead>
          <tbody>${r.topTeams.map((t, i) => `<tr>
            <td class="c"><b style="color:${i < 3 ? 'var(--brand-ink)' : 'var(--txt-3)'}">${i + 1}</b></td>
            <td class="t-main">${esc(t.name)}</td>
            <td class="small dim">${esc(t.owner)}</td>
            <td class="r num">${n(t.member_count)}</td>
            <td class="r num"><b>${n(t.total_points)}</b></td>
            <td class="r num">${n(t.checkin_rate)}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('gift', 15)} 兑换的商品类型</h3></div>
    <div class="card-b">
      ${C.hbars(r.redempByCat.map((x) => ({
    label: REDEEM_CAT[x.category] || x.category, v: Number(x.cost),
  })), { unit: ' 分' })}
      <div class="small dim2 mt4">柱长 = 该类型消耗掉的积分数（也就是被销毁的量）。</div>
    </div>
  </div>`;
}

/* ============================ 路由 ============================ */
const ROUTES = {
  overview: viewOverview,
  users: viewUsers,
  rules: viewRules,
  rewards: viewRewards,
  orders: viewOrders,
  risk: viewRisk,
  chain: viewChain,
  reconcile: viewReconcile,
  announce: viewAnnounce,
  audit: viewAudit,
  analytics: viewAnalytics,
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, qs] = raw.split('?');
  const seg = path.split('/');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const tab = ROUTES[seg[0]] ? seg[0] : 'overview';
  // 换页签就清掉旧筛选条件（否则会出现「切到风控却还筛着上一页的状态」），
  // 但 URL 里带过来的参数要生效 —— 概览页的「去处理」就是靠这个把列表排好序的。
  if (S.q.tab !== tab) S.q = { tab, ...q };
  else S.q = { ...S.q, ...q, tab };
  return { tab, id: seg[1] };
}

async function route() {
  if (!S.user) return;
  const { tab, id } = parseHash();
  paintShell();
  const fn = ROUTES[tab];
  try {
    await fn(id);
  } catch (e) {
    if (e.status === 401 || e.status === 403) { S.user = null; return paintGate(e.message); }
    $('#view').innerHTML = `<div class="card"><div class="card-b">
      <div class="alert bad">${I('alert', 16)}<div><b>加载失败</b>
        <div class="small mt2">${esc(e.message)}</div></div></div>
      <button class="btn mt4" data-act="reload">${I('refresh', 14)} 重试</button></div></div>`;
  }
}

/* ============================ 事件 ============================ */
function bind() {
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.getAttribute('data-act');
    const id = Number(t.getAttribute('data-id'));
    const map = {
      reload: () => route(),
      goTodo: () => {
        // 落点必须带上「怎么排」，否则就是把用户丢进大表让他自己找
        const r = t.getAttribute('data-route');
        const s = t.getAttribute('data-sort');
        const target = r + (s && s !== 'none' ? '?' + new URLSearchParams({ sort: s }) : '');
        if (location.hash === target) route(); else location.hash = target;
      },
      logout: async () => {
        if (!(await confirmDlg('退出管理端', '确定退出吗？'))) return;
        await A.logout(); S.user = null; S.overview = null; paintGate(''); 
      },
      sweep: async () => {
        try {
          const r = await A.admRiskSweep();
          toast(`扫描完成，新增 ${r.added} 条告警`, r.added ? 'warn' : 'ok');
          route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      mine: async () => {
        try {
          const r = await A.admMine(80);
          toast(`出块 #${r.height}，打包 ${r.txCount} 笔，nonce ${n(r.nonce)}，耗时 ${r.minedMs}ms`);
          if (!r.validate.ok) toast(r.validate.reason, 'bad', '警告：校验失败');
          route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      validate: async () => {
        const m = modal({ title: '正在校验全链', body: `<div class="row gap3">
          <span class="spin"></span><div class="small">逐块重算哈希、Merkle 根、工作量目标，
          并逐笔验签（几万个区块会慢，请稍候）…</div></div>` });
        try {
          const r = await A.chainValidate();
          m.close();
          toast(r.ok ? `校验通过：${r.blocks} 个区块 · ${r.txs} 笔交易 · ${r.elapsedMs}ms`
            : `第 ${r.badHeight} 块出问题：${r.reason}`, r.ok ? 'ok' : 'bad');
          route();
        } catch (er) { m.close(); toast(er.message, 'bad'); }
      },
      setDiff: async () => {
        try {
          const r = await A.admDifficulty(Number(t.getAttribute('data-d')));
          toast('难度已调整为 ' + r.difficulty + '，下次出块立刻生效'); route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      /* 用户 */
      openUser: () => openUser(id),
      usort: () => { S.q = { ...S.q, sort: t.getAttribute('data-s'), page: 1 }; route(); },
      /* 规则 */
      editRule: () => openEditRule(t.getAttribute('data-k')),
      /* 商品 */
      addReward: () => openAddReward(),
      editReward: () => openEditReward(id, t.getAttribute('data-stock'), t.getAttribute('data-name')),
      /* 订单 */
      ostatus: () => { S.q = { ...S.q, status: t.getAttribute('data-s'), page: 1 }; route(); },
      /* 风控 */
      rlevel: () => { S.q = { ...S.q, level: t.getAttribute('data-s'), page: 1 }; route(); },
      rhandled: () => { S.q = { ...S.q, handled: t.getAttribute('data-s'), page: 1 }; route(); },
      rsort: () => { S.q = { ...S.q, sort: t.getAttribute('data-s'), page: 1 }; route(); },
      handleRisk: () => openHandleRisk(id, t.getAttribute('data-name'), t.getAttribute('data-rule')),
      /* 公告 */
      addAnno: () => openAddAnno(),
      delAnno: async () => {
        if (!(await confirmDlg('下架公告', '下架后用户端不再显示，但记录仍在库里。确定吗？'))) return;
        try { await A.admDelAnnounce(id); toast('已下架'); route(); } catch (er) { toast(er.message, 'bad'); }
      },
      /* 看板 */
      adays: () => { S.q = { ...S.q, days: t.getAttribute('data-d') }; route(); },
      /* 分页 */
      page: () => { S.q = { ...S.q, page: Number(t.getAttribute('data-p')) }; route(); },
    };
    if (map[act]) { e.preventDefault(); map[act](); }
  });

  // 订单状态下拉直接改状态
  document.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-act="oset"]');
    if (!s) return;
    const id = Number(s.getAttribute('data-id'));
    const status = s.value;
    try {
      await A.admRedemptionStatus(id, status);
      toast('订单状态已更新为「' + (ORDER_STATUS[status] || status) + '」');
    } catch (er) { toast(er.message, 'bad'); route(); }
  });

  window.addEventListener('hashchange', route);
}

/* ============================ 启动 ============================ */
async function enter() {
  const g = $('#gate'); if (g) g.classList.add('hide');
  $('#shell').classList.remove('hide');
  try {
    S.overview = await A.admOverview();
  } catch (e) {
    if (e.status === 401 || e.status === 403) { S.user = null; return paintGate(e.message); }
  }
  paintShell();
  await route();
}

(async function boot() {
  if (booting) return;
  booting = true;
  bindCopy(document);
  bind();
  try {
    const r = await A.me();
    S.user = r.user;
  } catch (e) { S.user = null; }

  if (!S.user) return paintGate('');
  if (S.user.role !== 'operator' && S.user.role !== 'admin') {
    return paintGate(`账号「${S.user.nickname}」是普通用户（role=user），没有运营权限。请换 ops_lin 或 admin 登录。`);
  }
  await enter();
})();
