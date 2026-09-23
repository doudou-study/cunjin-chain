/* =====================================================================================
   链浏览器（公开，不需要登录）
   =====================================================================================
   这个页面承担三件事：
     ① 让「链」这件事看得见 —— 区块、交易、地址、交易池
     ② 让「校验」变成观众能自己做的事 —— 浏览器本地重算哈希，不信任服务端
     ③ 让「不可篡改」变成一场可以亲手做的实验 —— 篡改实验室
   ===================================================================================== */
import * as A from './api.js';
import { $, I, esc, n, dt, ago, shortHash, toast, modal, copy, bindCopy, empty, skel } from './ui.js';
import * as C from './charts.js';
import * as L from './chain-lite.js';

const S = { user: null, stats: null };
const TYPE_CN = {
  GENESIS: '创世发行', CHECKIN: '签到奖励', TASK: '任务完成', DAYBONUS: '当日全清',
  BADGE: '徽章铸造', REDEEM: '商城兑换', DONATE: '公益捐赠', STAKE: '押注锁定',
  SETTLE: '押注结算', POOL: '罚金入池', BURN: '销毁', TRANSFER: '积分转账',
  RULE: '规则存证', ADJUST: '管理员调账',
};
const TYPE_COLOR = {
  CHECKIN: '#F59E0B', TASK: '#10B981', DAYBONUS: '#5B6CFF', BADGE: '#0EA5E9', REDEEM: '#F43F5E',
  DONATE: '#EC4899', STAKE: '#8B5CF6', SETTLE: '#06B6D4', GENESIS: '#64748B', RULE: '#A855F7',
  ADJUST: '#EF4444', POOL: '#14B8A6', BURN: '#94A3B8', TRANSFER: '#6366F1',
};
const ACC_LABEL = {
  CJMINT: '铸币账户', CJBURN: '销毁账户', CJPOOL: '奖池账户', CJDONATE: '公益账户',
};
const accLabel = (a) => ACC_LABEL[a] || (a ? shortHash(a, 10, 6) : '—');

const txChip = (t) => `<span class="tag" style="background:${(TYPE_COLOR[t] || '#64748B')}1A;color:${TYPE_COLOR[t] || '#475569'}">${esc(TYPE_CN[t] || t)}</span>`;
const hashLink = (h, href, label) => `<a class="hash" href="${href}" title="${esc(h)}"
  data-copy="${esc(h)}">${I('cube', 11)}${esc(label || shortHash(h))}</a>`;

/* ============================ 概览 ============================ */
async function viewHome() {
  $('#view').innerHTML = `<div class="kgrid">${skel(110)}${skel(110)}${skel(110)}${skel(110)}</div>`;
  const [st, blk, pool, dif] = await Promise.all([A.chainStats(), A.chainBlocks(1, 12), A.chainPool(), A.chainDifficulty()]);
  S.stats = st;
  const recent = blk.list; // 高度倒序
  const asc = recent.slice().reverse(); // 画链条要从低到高
  const typeBars = st.types.slice(0, 8).map((x) => ({
    label: TYPE_CN[x.type] || x.type, v: Number(x.n), color: TYPE_COLOR[x.type] || '#64748B',
  }));

  $('#view').innerHTML = `
  <div class="kgrid mb5">
    <div class="kpi accent"><div class="k">链高度</div><div class="v">${n(st.height)}</div>
      <div class="d">共 ${n(st.block_count)} 个区块</div></div>
    <div class="kpi"><div class="k">交易总数</div><div class="v">${n(st.tx_count)}</div>
      <div class="d">待打包 ${n(st.pending)} 笔</div></div>
    <div class="kpi"><div class="k">当前难度</div><div class="v">${st.difficulty}<em>个前导 0</em></div>
      <div class="d">算法建议 ${dif.suggest} · 目标 ${Math.round(dif.targetMs / 1000)} 秒/块</div></div>
    <div class="kpi"><div class="k">平均挖矿耗时</div><div class="v">${n(st.avg_mined_ms)}<em>ms</em></div>
      <div class="d">工作量证明的真实成本</div></div>
  </div>

  <div class="card mb5">
    <div class="card-h"><h3>${I('link', 16)} 最近的区块</h3>
      <div class="row gap2">
        <span class="tag chain">${I('cpu', 12)} 每块存着前一块的哈希</span>
        <a class="btn sm" href="#/blocks">全部区块 ${I('right', 12)}</a>
      </div></div>
    <div class="card-b" style="padding:16px 18px 8px">
      <div class="chain-strip">
        ${asc.map((b, i) => `${i ? `<div class="chain-link">${I('link', 14)}</div>` : ''}
          <div class="chain-node" data-act="goBlock" data-h="${b.height}">
            <div class="cn-h">#${n(b.height)}</div>
            <div class="cn-hash">${esc(shortHash(b.hash, 14, 6))}</div>
            <div class="cn-t">${b.tx_count} 笔 · 难度 ${b.difficulty}</div>
            <div class="cn-t">${esc(ago(b.ts))}</div>
          </div>`).join('')}
        <div class="chain-link">${I('link', 14)}</div>
        <div class="chain-node" style="border-style:dashed;display:grid;place-items:center;text-align:center">
          <div><div class="dim2">${I('clock', 18)}</div>
            <div class="cn-t">下一块</div>
            <div class="cn-t" style="color:var(--brand-ink)">${n(st.pending)} 笔待打包</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="grid g2 mb5">
    <div class="card">
      <div class="card-h"><h3>${I('chart', 16)} 交易类型分布</h3>
        <span class="hsub">共 ${n(st.tx_count)} 笔</span></div>
      <div class="card-b">${C.hbars(typeBars, { unit: '' })}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3>${I('wallet', 16)} 系统账户（钱都去哪了）</h3></div>
      <div class="card-b flush"><div class="tbl-wrap" style="max-height:320px"><table class="tbl">
        <thead><tr><th>账户</th><th>地址</th><th class="r">链上余额</th><th class="r">笔数</th><th></th></tr></thead>
        <tbody>${st.systems.map((a) => `<tr>
          <td class="t-main">${esc(a.label.split('（')[0])}
            <div class="t-sub">${esc((a.label.match(/（(.+)）/) || [, ''])[1])}</div></td>
          <td><a class="hash" href="#/addr/${esc(a.addr)}">${esc(a.addr)}</a></td>
          <td class="r num bold">${n(a.on_chain)}</td>
          <td class="r num dim">${n(a.tx_count)}</td>
          <td><a class="btn sm ghost" href="#/addr/${esc(a.addr)}">${I('right', 12)}</a></td></tr>`).join('')}</tbody>
      </table></div></div>
    </div>
  </div>

  <div class="grid g-2-1">
    <div class="card">
      <div class="card-h"><h3>${I('clock', 16)} 交易池（还没被打包的交易）</h3>
        <span class="hsub">攒够 ${pool.maxTxPerBlock} 笔或超时就会出块</span></div>
      <div class="card-b flush">${pool.list.length ? `<div class="tbl-wrap" style="max-height:340px"><table class="tbl">
        <thead><tr><th>类型</th><th>付款方</th><th>收款方</th><th class="r">金额</th><th>备注</th><th>时间</th></tr></thead>
        <tbody>${pool.list.map((t) => `<tr>
          <td>${txChip(t.type)}</td>
          <td class="small">${esc(accLabel(t.from_addr))}</td>
          <td class="small">${esc(accLabel(t.to_addr))}</td>
          <td class="r num">${n(t.amount)}</td>
          <td class="small dim">${esc(t.memo || '—')}</td>
          <td class="small dim nowrap">${esc(ago(t.ts))}</td></tr>`).join('')}</tbody>
      </table></div>` : empty('交易池是空的', '所有交易都已经打包上链了', 'check')}</div>
    </div>
    <div class="col gap4" style="gap:18px">
      <div class="card pad">
        <h3 class="mb3">${I('shield', 16)} 链的健康状况</h3>
        <button class="btn pri block" data-act="validateAll">${I('refresh', 15)} 跑一次全链校验</button>
        <div class="mt3 small dim2">逐块检查：高度连续 · 前哈希衔接 · 区块头自洽 · 满足难度 · Merkle 根 · 每笔交易签名</div>
        <div id="valBox" class="mt4"></div>
      </div>
      <div class="card pad" style="background:linear-gradient(150deg,#FFF5F7,#FFFBFD);border-color:#F8D9E1">
        <h3 class="mb3">${I('alert', 16, 'style="color:#F43F5E"')} 篡改实验室</h3>
        <p class="small dim">试试直接改数据库里的账，看这条链能不能发现。</p>
        <a class="btn block mt4" href="#/lab">${I('play', 14)} 进去试试</a>
      </div>
    </div>
  </div>`;
}

/* ============================ 区块列表 ============================ */
async function viewBlocks(q) {
  const page = Number(q.page) || 1;
  const r = await A.chainBlocks(page, 25);
  $('#view').innerHTML = `
  <div class="ptitle"><div><h1>区块</h1>
    <div class="psub">共 ${n(r.total)} 个区块，从最高高度往下看</div></div>
    <div class="row gap2">
      <button class="btn sm" data-act="bpage" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${I('left', 13)} 上一页</button>
      <span class="tag line">第 ${page} 页</span>
      <button class="btn sm" data-act="bpage" data-p="${page + 1}" ${page * 25 >= r.total ? 'disabled' : ''}>下一页 ${I('right', 13)}</button>
    </div>
  </div>
  <div class="col gap3">
    ${r.list.map((b) => `<div class="blk-card" data-act="goBlock" data-h="${b.height}">
      <div class="blk-h"><div><b>#${n(b.height)}</b><span>HEIGHT</span></div></div>
      <div class="grow" style="min-width:0">
        <div class="row gap3" style="flex-wrap:wrap">
          <span class="hash">${esc(b.hash)}</span>
        </div>
        <div class="blk-meta">
          <span>前哈希 <b class="mono">${esc(shortHash(b.prev_hash, 12, 6))}</b></span>
          <span>Merkle 根 <b class="mono">${esc(shortHash(b.merkle_root, 12, 6))}</b></span>
        </div>
        <div class="blk-meta">
          <span>${I('layers', 12)} <b>${b.tx_count}</b> 笔交易</span>
          <span>${I('cpu', 12)} 难度 <b>${b.difficulty}</b></span>
          <span>${I('refresh', 12)} nonce <b class="num">${n(b.nonce)}</b></span>
          <span>${I('clock', 12)} ${esc(dt(b.ts))}</span>
          <span>${I('zap', 12)} 挖了 <b>${n(b.mined_ms)}</b> ms</span>
        </div>
      </div>
      <div class="center" style="color:var(--txt-3)">${I('right', 18)}</div>
    </div>`).join('')}
  </div>`;
}

/* ============================ 区块详情（含浏览器本地校验） ============================ */
async function viewBlock(h) {
  $('#view').innerHTML = skel(400);
  const r = await A.chainBlock(h);
  const b = r.block;
  $('#view').innerHTML = `
  <div class="crumb"><a href="#/blocks">区块</a> / <span>#${n(b.height)}</span></div>
  <div class="row-b mb4" style="flex-wrap:wrap;gap:12px">
    <h1 style="font-size:24px">区块 #${n(b.height)}</h1>
    <div class="row gap2">
      ${r.prev ? `<a class="btn sm" href="#/block/${r.prev.height}">${I('left', 13)} #${r.prev.height}</a>` : ''}
      ${r.next ? `<a class="btn sm" href="#/block/${r.next.height}">#${r.next.height} ${I('right', 13)}</a>` : ''}
      <button class="btn sm pri" data-act="localVerify" data-h="${b.height}">${I('shield', 14)} 用浏览器本地校验这一块</button>
    </div>
  </div>

  <div class="grid g3 mb5">
    <div class="card pad" style="grid-column:span 2">
      <h3 class="mb4">${I('cube', 16)} 区块头</h3>
      <table class="tbl">
        <tbody>
          <tr><td class="dim small" style="width:132px">区块哈希</td><td><span class="hash block">${esc(b.hash)}</span></td></tr>
          <tr><td class="dim small">前一块哈希</td><td>${hashLink(b.prev_hash, '#/block/' + (b.height - 1))}</td></tr>
          <tr><td class="dim small">Merkle 根</td><td><span class="hash block">${esc(b.merkle_root)}</span></td></tr>
          <tr><td class="dim small">时间戳</td><td><b>${n(b.ts)}</b> <span class="dim small">· ${esc(dt(b.ts))} · ${esc(ago(b.ts))}</span></td></tr>
          <tr><td class="dim small">nonce（挖出来的随机数）</td><td><b class="num">${n(b.nonce)}</b>
            <span class="dim small">· 试了 ${n(b.nonce)} 次才凑出符合难度的哈希</span></td></tr>
          <tr><td class="dim small">难度</td><td><b>${b.difficulty}</b>
            <span class="dim small">· 哈希开头必须是 <span class="mono">${'0'.repeat(Number(b.difficulty))}</span>，
            实际是 <span class="mono">${esc(b.hash.slice(0, Number(b.difficulty) + 4))}…</span></span></td></tr>
          <tr><td class="dim small">出块者</td><td>${esc(accLabel(b.miner))} <span class="mono small dim">${esc(b.miner)}</span></td></tr>
          <tr><td class="dim small">交易数 / 耗时</td><td><b>${b.tx_count}</b> 笔 · 挖矿 <b>${n(b.mined_ms)}</b> ms</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card pad">
      <h3 class="mb3">${I('cpu', 16)} 挖矿难度意味着什么</h3>
      <p class="small dim">难度每 +1，需要尝试的次数平均 ×16。
        难度 ${b.difficulty} 平均要试 <b class="num">${n(Math.pow(16, b.difficulty))}</b> 次。</p>
      <div class="mt4">${C.hbars([
    { label: '难度 3', v: Math.pow(16, 3) }, { label: '难度 4', v: Math.pow(16, 4) },
    { label: '难度 5', v: Math.pow(16, 5) / 100 }, { label: '难度 6', v: Math.pow(16, 6) / 10000 },
  ].map((x, i) => ({ ...x, label: `难度 ${i + 3}`, v: Math.round(Math.pow(16, i + 3)) })),
  { unit: ' 次' })}</div>
      <div class="alert warn mt4">${I('alert', 14)}<div class="tiny">
        这就是「改一块要重挖后面所有块」的成本来源。</div></div>
    </div>
  </div>

  <div class="card" id="localBox"></div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('layers', 16)} 块内交易（${b.txs.length} 笔）</h3>
      <span class="hsub">点表头「Merkle」可以看到这笔交易在树里的路径</span></div>
    <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>类型</th><th>付款方</th><th></th><th>收款方</th><th class="r">金额</th>
        <th>备注</th><th>交易号</th><th></th></tr></thead>
      <tbody>${b.txs.map((t) => `<tr>
        <td>${txChip(t.type)}</td>
        <td class="small">${esc(accLabel(t.from_addr))}</td>
        <td class="c dim">${I('arrow', 13)}</td>
        <td class="small">${esc(accLabel(t.to_addr))}</td>
        <td class="r num bold">${n(t.amount)}</td>
        <td class="small dim">${esc(t.memo || '—')}</td>
        <td>${hashLink(t.txid, '#/tx/' + t.txid)}</td>
        <td><button class="btn sm ghost" data-act="verifyProof" data-tx="${esc(t.txid)}"
          >${I('shield', 12)} 证明</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div>
  </div>`;
}

/** 浏览器本地校验，逐步动画显示 */
async function localVerify(height) {
  const box = $('#localBox');
  if (!box) return;
  box.innerHTML = `<div class="card-b"><div class="row gap3">${I('cpu', 18)}<b>正在用浏览器本地重算…</b>
    <span class="spin dark"></span></div>
    <div class="small dim2 mt2">这一步不经过服务端 —— 哈希是这台电脑自己算出来的。</div></div>`;
  if (!L.available()) {
    box.innerHTML = `<div class="card-b"><div class="alert bad">${I('alert', 15)}
      <div>当前环境不支持 WebCrypto（需要 https 或 localhost），无法做本地校验。</div></div></div>`;
    return;
  }
  const r = await A.chainBlock(height);
  const b = r.block;
  const t0 = performance.now();
  const res = await L.verifyBlock(b, b.txs, r.prev ? r.prev.hash : null);
  const cost = Math.round(performance.now() - t0);

  box.innerHTML = `<div class="card-h">
      <h3>${I('shield', 16)} 浏览器本地校验结果</h3>
      <span class="tag ${res.ok ? 'ok' : 'bad'}">${I(res.ok ? 'okc' : 'xc', 12)}
        ${res.ok ? '全部通过' : '发现问题'} · 耗时 ${cost}ms</span></div>
    <div class="card-b"><div class="step-list">
      ${res.steps.map((s, i) => `<div class="st ${s.ok ? 'ok' : 'bad'}">
        <div class="st-n">${s.ok ? I('check', 13) : I('x', 13)}</div>
        <div><b class="small">${esc(s.name)}</b>
          <div class="small dim mt1" style="word-break:break-all">${esc(s.detail)}</div></div>
      </div>`).join('')}
    </div>
    <div class="alert ${res.ok ? 'ok' : 'bad'} mt4">${I(res.ok ? 'okc' : 'xc', 15)}
      <div class="small">${res.ok
    ? '这五项都是本机算出来的，服务端说什么不影响结论 —— 这才是「轻节点验证」的意思。'
    : '本机重算的结果与服务端给的数据对不上，说明数据被动过。'}</div></div>
    </div>`;
  toast(res.ok ? '浏览器本地校验：全部通过' : '浏览器本地校验：发现问题', res.ok ? 'ok' : 'bad');
}

/* ============================ Merkle 证明弹层 ============================ */
async function showProof(txid) {
  const p = await A.chainProof(txid);
  const local = await L.verifyMerkleProof(p.leaf, p.path, p.root);
  const steps = p.path.map((s, i) => `<div class="st ${i % 2 ? '' : ''}">
      <div class="st-n">${i + 1}</div>
      <div><b class="small">${s.left ? '兄弟节点在左' : '兄弟节点在右'}</b>
        <div class="mono tiny dim mt1" style="word-break:break-all">${esc(s.hash)}</div>
        <div class="tiny dim2 mt1">拼接 ${s.left ? '兄弟 + 自己' : '自己 + 兄弟'} 再取 SHA-256</div></div>
    </div>`).join('');
  modal({
    title: 'Merkle 证明',
    wide: true,
    body: `<p class="small dim mb4">不用下载整个区块，只要这条路径就能证明「这笔交易确实在那个区块里」。
      哈希树一共 ${p.path.length} 层，所以只需要 ${p.path.length} 个哈希，而不是 ${p.total} 笔交易的全部数据。</p>
      <div class="card pad mb4" style="background:var(--card-2)">
        <div class="grid g2" style="gap:12px">
          <div><div class="tiny dim2">叶子（交易号）</div>
            <div class="mono small" style="word-break:break-all">${esc(p.leaf)}</div></div>
          <div><div class="tiny dim2">根（写进区块头）</div>
            <div class="mono small" style="word-break:break-all">${esc(p.root)}</div></div>
        </div>
        <div class="grid g3 mt4" style="gap:12px">
          <div><div class="tiny dim2">块内位置</div><b>第 ${p.index + 1} / ${p.total} 笔</b></div>
          <div><div class="tiny dim2">证明路径长度</div><b>${p.path.length} 层</b></div>
          <div><div class="tiny dim2">服务端自验</div>
            <b style="color:var(--${p.serverVerified ? 'ok' : 'bad'})">${p.serverVerified ? '通过' : '不通过'}</b></div>
        </div>
      </div>
      <div class="step-list mb4">${steps}</div>
      <div class="verdict ${local.ok ? 'ok' : 'bad'}">
        <h3>${I(local.ok ? 'okc' : 'xc', 19)} 浏览器本地重算：${local.ok ? '证明成立' : '证明不成立'}</h3>
        <div class="mono small mt3" style="word-break:break-all">重算得到的根 = ${esc(local.computed)}</div>
        <div class="small mt2">${local.ok ? '与区块头里记录的根完全一致。'
    : '与区块头里的根不一致 —— 这笔交易或它的路径被动过。'}</div>
      </div>`,
    footer: `<button class="btn" data-copy="${esc(p.root)}">${I('copy', 14)} 复制根哈希</button>
      <button class="btn pri" data-no>关闭</button>`,
  }).el.querySelector('[data-no]').onclick = function () { this.closest('.mask').remove(); };
}

/* ============================ 交易列表 ============================ */
async function viewTxs(q) {
  const page = Number(q.page) || 1;
  const type = q.type || '';
  const kw = q.q || '';
  const r = await A.chainTxs({ page, size: 25, type, q: kw });
  $('#view').innerHTML = `
  <div class="ptitle"><div><h1>交易</h1>
    <div class="psub">共 ${n(r.total)} 笔链上交易，每笔都带 Ed25519 签名</div></div>
    <div class="row gap2">
      <input class="ctl" id="txq" placeholder="搜交易号 / 地址 / 备注" value="${esc(kw)}" style="width:220px">
      <button class="btn" data-act="txsearch">${I('search', 14)} 搜索</button>
    </div>
  </div>
  <div class="row gap2 mb4" style="flex-wrap:wrap">
    <button class="chip ${!type ? 'on' : ''}" data-act="txfilter" data-t="">全部</button>
    ${Object.keys(TYPE_CN).map((t) => `<button class="chip ${type === t ? 'on' : ''}"
      data-act="txfilter" data-t="${t}">${TYPE_CN[t]}</button>`).join('')}
  </div>
  <div class="card"><div class="card-b flush"><div class="tbl-wrap">
    <table class="tbl">
      <thead><tr><th>类型</th><th>付款方</th><th></th><th>收款方</th><th class="r">金额</th>
        <th>备注</th><th>区块</th><th>时间</th><th>交易号</th></tr></thead>
      <tbody>${r.list.map((t) => `<tr>
        <td>${txChip(t.type)}</td>
        <td class="small">${esc(accLabel(t.from_addr))}</td>
        <td class="c dim">${I('arrow', 13)}</td>
        <td class="small">${esc(accLabel(t.to_addr))}</td>
        <td class="r num bold">${n(t.amount)}</td>
        <td class="small dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(t.memo || '—')}</td>
        <td>${t.block_height === null
    ? '<span class="tag line">待打包</span>'
    : `<a class="hash" href="#/block/${t.block_height}">#${t.block_height}</a>`}</td>
        <td class="small dim nowrap">${esc(ago(t.ts))}</td>
        <td>${hashLink(t.txid, '#/tx/' + t.txid, shortHash(t.txid, 8, 5))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="pager"><span>共 ${n(r.total)} 笔 · 第 ${page} 页</span>
      <div class="row gap2">
        <button class="btn sm" data-act="tpage" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn sm" data-act="tpage" data-p="${page + 1}" ${page * 25 >= r.total ? 'disabled' : ''}>下一页</button>
      </div></div>
  </div></div>`;
}

/* ============================ 交易详情 ============================ */
async function viewTx(txid) {
  $('#view').innerHTML = skel(400);
  const r = await A.chainTx(txid);
  const t = r.tx;
  const local = L.available() ? await L.verifyTx(t) : null;
  const payload = L.canonical(L.txPayload(t));
  $('#view').innerHTML = `
  <div class="crumb"><a href="#/txs">交易</a> / <span>${esc(shortHash(txid, 12, 8))}</span></div>
  <div class="row-b mb4" style="flex-wrap:wrap;gap:12px">
    <div class="row gap3"><h1 style="font-size:24px">${TYPE_CN[t.type] || t.type}</h1>
      ${t.block_height === null ? '<span class="tag warn">待打包</span>'
    : `<a class="btn sm" href="#/block/${t.block_height}">${I('cube', 13)} 在区块 #${t.block_height} 里</a>`}</div>
    <button class="btn sm pri" data-act="txProof" data-tx="${esc(txid)}">${I('shield', 14)} 看 Merkle 证明</button>
  </div>

  <div class="grid g3 mb5">
    <div class="card pad" style="grid-column:span 2">
      <h3 class="mb4">${I('layers', 16)} 交易内容</h3>
      <table class="tbl"><tbody>
        <tr><td class="dim small" style="width:120px">交易号</td>
          <td><span class="hash block">${esc(t.txid)}</span>
            ${local ? `<span class="tag ${local.txidOk ? 'ok' : 'bad'} mt2" style="display:inline-flex">
              ${I(local.txidOk ? 'okc' : 'xc', 11)} 浏览器重算${local.txidOk ? '一致' : '不一致'}</span>` : ''}</td></tr>
        <tr><td class="dim small">类型</td><td>${txChip(t.type)} <span class="dim small">${esc(t.type)}</span></td></tr>
        <tr><td class="dim small">付款方</td><td><a class="hash" href="#/addr/${esc(t.from_addr)}">${esc(t.from_addr)}</a>
          <span class="dim small">${esc(accLabel(t.from_addr))}</span></td></tr>
        <tr><td class="dim small">收款方</td><td><a class="hash" href="#/addr/${esc(t.to_addr)}">${esc(t.to_addr)}</a>
          <span class="dim small">${esc(accLabel(t.to_addr))}</span></td></tr>
        <tr><td class="dim small">金额</td><td><b class="num" style="font-size:17px">${n(t.amount)}</b> 分</td></tr>
        <tr><td class="dim small">备注</td><td>${esc(t.memo || '—')}</td></tr>
        <tr><td class="dim small">nonce</td><td class="num">${n(t.nonce)} <span class="dim small">· 防重放序号</span></td></tr>
        <tr><td class="dim small">时间戳</td><td>${n(t.ts)} <span class="dim small">· ${esc(dt(t.ts))}</span></td></tr>
      </tbody></table>
    </div>
    <div class="col gap4" style="gap:18px">
      <div class="card pad">
        <h3 class="mb3">${I('key', 16)} 签名验证</h3>
        <div class="alert ${r.verify.signatureOk ? 'ok' : 'bad'}">${I(r.verify.signatureOk ? 'okc' : 'xc', 15)}
          <div><b>${r.verify.signatureOk ? 'Ed25519 验签通过' : '验签失败'}</b>
            <div class="small mt1">${esc(r.verify.reason || '')}</div></div></div>
        <div class="tiny dim2 mt4 mb2">签名公钥</div>
        <div class="mono tiny" style="word-break:break-all;background:var(--bg-2);padding:8px;border-radius:8px">
          ${esc(t.signer_pub || '—')}</div>
        <div class="tiny dim2 mt4 mb2">签名值</div>
        <div class="mono tiny" style="word-break:break-all;background:var(--bg-2);padding:8px;border-radius:8px">
          ${esc(t.sig || '—')}</div>
      </div>
      <div class="card pad">
        <h3 class="mb3">${I('cpu', 16)} 交易号怎么算出来的</h3>
        <p class="small dim mb3">把交易内容按固定规则序列化后取 SHA-256。
          字段顺序不影响结果（会先排序），但改任何一个字符都会让哈希全变。</p>
        <div class="mono tiny" style="word-break:break-all;background:var(--bg-2);padding:10px;border-radius:8px;line-height:1.7">
          ${esc(payload)}</div>
        ${local ? `<div class="mt4"><div class="tiny dim2">本地重算</div>
          <div class="mono tiny" style="word-break:break-all;color:var(--${local.txidOk ? 'ok' : 'bad'})">
            ${esc(local.computed)}</div>
          <div class="tiny dim2 mt3">链上记录</div>
          <div class="mono tiny" style="word-break:break-all">${esc(t.txid)}</div></div>` : ''}
      </div>
    </div>
  </div>`;
}

/* ============================ 地址页 ============================ */
async function viewAddr(addr) {
  $('#view').innerHTML = skel(400);
  const r = await A.chainAddr(addr);
  const name = r.user ? r.user.nickname : (r.label || '未知账户');
  const isSys = r.summary.isSystem;
  $('#view').innerHTML = `
  <div class="ptitle">
    <div>
      <div class="row gap3"><h1>${esc(name)}</h1>
        ${isSys ? '<span class="tag chain">系统账户</span>' : ''}
        ${r.user && r.user.streak ? `<span class="tag warn">${I('flame', 11)} 连续 ${r.user.streak} 天</span>` : ''}</div>
      <div class="row gap2 mt3"><span class="hash">${esc(addr)}</span>
        <button class="btn sm" data-copy="${esc(addr)}">${I('copy', 13)}</button></div>
    </div>
    <div style="text-align:right">
      <div class="tiny dim2">链上余额</div>
      <div style="font-size:30px;font-weight:800;letter-spacing:-.03em" class="num">${n(r.summary.balance)}</div>
    </div>
  </div>
  <div class="kgrid mb5">
    ${[['总收入', n(r.summary.inflow) + ' 分', '所有入账交易的合计'],
    ['总支出', n(r.summary.outflow) + ' 分', '所有出账交易的合计'],
    ['交易笔数', n(r.summary.tx_count) + ' 笔', r.summary.first_ts ? '首次 ' + ago(r.summary.first_ts) : '无交易'],
    ['最近活动', ago(r.summary.last_ts), '最后一笔交易的时间']]
    .map(([k, v, d]) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${v}</div>
      <div class="d">${esc(d)}</div></div>`).join('')}
  </div>
  <div class="grid g-2-1">
    <div class="card">
      <div class="card-h"><h3>${I('layers', 16)} 交易记录</h3>
        <span class="hsub">最近 ${r.txs.length} 笔</span></div>
      <div class="card-b flush"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>类型</th><th>方向</th><th>对手方</th><th class="r">金额</th><th>备注</th><th>区块</th><th>时间</th></tr></thead>
        <tbody>${r.txs.map((t) => {
    const out = t.from_addr === addr;
    return `<tr>
          <td>${txChip(t.type)}</td>
          <td><span class="tag ${out ? 'warn' : 'ok'}">${out ? '转出' : '转入'}</span></td>
          <td class="small">${hashLink(out ? t.to_addr : t.from_addr, '#/addr/' + (out ? t.to_addr : t.from_addr))}</td>
          <td class="r num bold" style="color:var(--${out ? 'streak' : 'ok'})">${out ? '−' : '+'}${n(t.amount)}</td>
          <td class="small dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(t.memo || '—')}</td>
          <td>${t.block_height === null ? '<span class="tag line">待打包</span>'
      : `<a class="hash" href="#/block/${t.block_height}">#${t.block_height}</a>`}</td>
          <td class="small dim nowrap">${esc(ago(t.ts))}</td></tr>`;
  }).join('')}</tbody>
      </table></div></div>
    </div>
    <div class="col gap4" style="gap:18px">
      <div class="card">
        <div class="card-h"><h3>${I('chart', 16)} 收支构成</h3></div>
        <div class="card-b">${C.donut(r.summary.byType.filter((x) => x.type !== 'BADGE').slice(0, 6).map((x) => ({
    label: TYPE_CN[x.type] || x.type, v: Number(x.amt), color: TYPE_COLOR[x.type] || '#64748B',
  })), { center: n(r.summary.inflow + r.summary.outflow), centerLabel: '总流水' })}</div>
      </div>
      ${r.claims.length ? `<div class="card">
        <div class="card-h"><h3>${I('trophy', 16)} 持有的成就凭证</h3></div>
        <div class="card-b" style="padding:10px 20px">
          ${r.claims.map((c) => `<div class="row-b" style="padding:10px 0;border-bottom:1px solid var(--line)">
            <div><div class="bold small">${esc(c.badge_name)}</div>
              <div class="tiny dim2 mono">${esc(c.serial)} · ${esc(c.verify_code)}</div></div>
            <div class="row gap2">
              <span class="tag ${c.status === 'valid' ? 'ok' : 'bad'}">${c.status === 'valid' ? '有效' : '已撤销'}</span>
              <a class="btn sm ghost" href="/verify?code=${esc(c.verify_code)}" target="_blank">${I('scan', 12)}</a>
            </div></div>`).join('')}
        </div></div>` : ''}
      ${r.user ? `<div class="card pad">
        <h3 class="mb3">${I('user', 16)} 这个人</h3>
        <div class="grid g2" style="gap:12px">
          <div><div class="tiny dim2">等级</div><b>Lv.${r.user.level}</b></div>
          <div><div class="tiny dim2">连续签到</div><b>${r.user.streak} 天</b></div>
          <div><div class="tiny dim2">累计签到</div><b>${n(r.user.checkin_days)} 天</b></div>
          <div><div class="tiny dim2">持有徽章</div><b>${n(r.user.badge_count)} 枚</b></div>
        </div>
        ${r.user.goal ? `<div class="alert info mt4">${I('target', 14)}
          <div class="small">目标：${esc(r.user.goal)}</div></div>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

/* ============================ 交易池 / 运维 ============================ */
async function viewPool() {
  const [pool, dif, st] = await Promise.all([A.chainPool(), A.chainDifficulty(), A.chainStats()]);
  const canOps = S.user && (S.user.role === 'operator' || S.user.role === 'admin');
  $('#view').innerHTML = `
  <div class="ptitle"><div><h1>交易池与出块</h1>
    <div class="psub">交易先进入池子，攒够 ${pool.maxTxPerBlock} 笔或等超 ${Math.round(pool.intervalMs / 1000)} 秒才打包</div></div>
    ${canOps ? `<div class="row gap2">
        <button class="btn pri" data-act="mineNow">${I('hammer', 15)} 立即出块</button>
      </div>` : ''}
  </div>
  ${canOps ? '' : `<div class="alert info mb5">${I('info', 15)}
    <div>手动出块和调难度需要「运营」或「管理员」权限。用 <b class="mono">ops_lin / 123456</b>
      到<a href="/">用户端</a>登录后再回来。</div></div>`}

  <div class="grid g-2-1 mb5">
    <div class="card">
      <div class="card-h"><h3>${I('clock', 16)} 待打包交易（${pool.list.length} 笔）</h3>
        <button class="btn sm" data-act="reload">${I('refresh', 13)} 刷新</button></div>
      <div class="card-b flush">${pool.list.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>类型</th><th>付款方</th><th>收款方</th><th class="r">金额</th><th>备注</th><th>等待</th></tr></thead>
        <tbody>${pool.list.map((t) => `<tr>
          <td>${txChip(t.type)}</td>
          <td class="small">${esc(accLabel(t.from_addr))}</td>
          <td class="small">${esc(accLabel(t.to_addr))}</td>
          <td class="r num">${n(t.amount)}</td>
          <td class="small dim">${esc(t.memo || '—')}</td>
          <td class="small dim">${esc(ago(t.ts))}</td></tr>`).join('')}</tbody>
      </table></div>` : empty('池子空了', '所有交易都已上链', 'check')}</div>
    </div>
    <div class="col gap4" style="gap:18px">
      <div class="card pad">
        <h3 class="mb3">${I('cpu', 16)} 难度控制</h3>
        <div class="row-b"><span class="small dim2">当前难度</span>
          <b class="num" style="font-size:22px">${st.runtimeDifficulty}</b></div>
        <div class="small dim2 mt2">算法建议：<b>${dif.suggest}</b>（按最近 20 块的实测间隔算，目标 ${Math.round(dif.targetMs / 1000)} 秒/块）</div>
        ${canOps ? `<div class="row gap2 mt4" style="flex-wrap:wrap">
            ${[2, 3, 4, 5, 6].map((d) => `<button class="chip ${st.runtimeDifficulty === d ? 'on' : ''}"
              data-act="setDiff" data-d="${d}">难度 ${d}</button>`).join('')}
          </div>
          <div class="alert warn mt4">${I('alert', 14)}<div class="tiny">
            难度每 +1，出块要试的次数平均 ×16。调到 5 再点「立即出块」，你会明显感觉到卡一下 —— 那就是工作量证明。</div></div>`
    : ''}
      </div>
      <div class="card">
        <div class="card-h"><h3>${I('zap', 16)} 最近 20 块</h3></div>
        <div class="card-b">${C.vbars(st.recent.slice().reverse().map((b) => ({
    x: '#' + b.height, y: Number(b.tx_count),
  })), { kind: 'g', unit: ' 笔', slice: 0 })}
        <div class="tiny dim2 mt3">柱高 = 该块打包的交易笔数</div></div>
      </div>
    </div>
  </div>`;
}

/* ============================ 全链校验 ============================ */
async function viewValidate() {
  const box = $('#valBox2') || $('#view');
  box.innerHTML = `<div class="ptitle"><div><h1>全链校验</h1>
    <div class="psub">把库里所有区块和交易读出来，重新算一遍每一个哈希</div></div>
    <button class="btn pri" data-act="validateAll">${I('refresh', 15)} 开始校验</button></div>
    <div class="card pad" id="valOut">
      <div class="row gap3">${I('shield', 20)}<b>点上面的按钮开始</b></div>
      <div class="small dim2 mt3">校验内容：高度是否连续 · 前哈希是否衔接 · 区块头哈希是否自洽 ·
        是否满足难度目标 · Merkle 根是否匹配 · 每笔交易的交易号与 Ed25519 签名是否有效</div>
    </div>`;
  window.__valOut = () => $('#valOut');
}

async function runValidate() {
  const out = window.__valOut ? window.__valOut() : $('#valBox');
  if (!out) return;
  out.innerHTML = `<div class="row gap3">${I('cpu', 18)}<b>正在逐块校验（${S.stats ? n(S.stats.block_count) : '全部'} 个区块）…</b>
    <span class="spin dark"></span></div>`;
  const t0 = performance.now();
  try {
    const r = await A.chainValidate();
    const cost = Math.round(performance.now() - t0);
    out.innerHTML = `
      <div class="verdict ${r.ok ? 'ok' : 'bad'} mb4">
        <h3>${I(r.ok ? 'okc' : 'xc', 20)} ${r.ok ? '全链校验通过' : `发现问题：区块 #${r.badHeight}`}</h3>
        <div class="mt2">${esc(r.reason)}</div>
        <div class="row gap4 mt3 small">
          <span>校验区块 <b>${n(r.checked)}</b> 个</span>
          <span>链上交易 <b>${n(r.txs)}</b> 笔</span>
          <span>待打包 <b>${n(r.pending)}</b> 笔</span>
          <span>耗时 <b>${cost}ms</b></span>
        </div>
      </div>
      <div class="small dim">如果这里显示通过，再回到任意区块详情页，用「浏览器本地校验」再验一次 ——
        服务端说通过不算数，你自己算一遍才算。</div>`;
  } catch (e) {
    out.innerHTML = `<div class="alert bad">${I('xc', 16)}<div>${esc(e.message)}</div></div>`;
  }
}

/* ============================ 篡改实验室 ============================ */
async function viewLab() {
  $('#view').innerHTML = skel(400);
  const o = await A.tamperOptions();
  S.blocks = o.blocks;
  S.txs = o.txs;
  $('#view').innerHTML = `
  <div class="ptitle">
    <div><h1>篡改实验室</h1>
      <div class="psub">链的价值只有在「有人试图篡改」的时候才体现出来。自己动手试一次。</div></div>
    ${o.hasBackup ? `<button class="btn danger" data-act="restore">${I('refresh', 15)} 还原上次的篡改</button>` : ''}
  </div>

  <div class="alert info mb5">${I('info', 16)}<div>
    <b>默认只在内存里改一份副本</b>，数据库毫发无损 —— 你看到的是「如果真改了会怎样」。
    想看真改库（改完可以一键还原），用运营账号 <b class="mono">ops_lin / 123456</b> 登录。</div></div>

  <div class="lab-grid mb5">
    ${o.options.map((x) => `<div class="lab-card" data-act="pickTamper" data-k="${x.kind}">
      <div class="lc-t">${I('alert', 15)} ${esc(x.name)}</div>
      <div class="lc-d">${esc(x.desc)}</div>
      <div class="lc-x">${I('shield', 11)} 预计会被：${esc(x.detect)}</div>
    </div>`).join('')}
  </div>

  <div class="card mb5">
    <div class="card-h"><h3>${I('target', 16)} 选择篡改目标</h3>
      <span class="hsub">先选上面的篡改方式，再挑一个具体的区块或交易</span></div>
    <div class="card-b" id="tamperTarget">${empty('先选一种篡改方式', '', 'alert')}</div>
  </div>

  <div class="card" id="tamperOut"></div>`;
}

let tamperKind = null;

function paintTamperTarget() {
  const box = $('#tamperTarget');
  if (!box || !tamperKind) return;
  const opt = { block_ts: 1, block_nonce: 1, drop_block: 1, reorder_tx: 1 };
  if (opt[tamperKind]) {
    box.innerHTML = `<div class="row gap3 mb3"><span class="small dim2">挑一个区块：</span>
        <span class="tag line">共 ${S.blocks.length} 个可选</span></div>
      <div class="row gap2" style="flex-wrap:wrap">
        ${S.blocks.slice(0, 18).map((b, i) => `<button class="chip ${i === 3 ? 'on' : ''}"
          data-act="tamperGo" data-k="${tamperKind}" data-h="${b.height}">
          #${b.height}</button>`).join('')}
      </div>
      <div class="small dim2 mt4">建议从中间挑（比如 #${S.blocks[3] ? S.blocks[3].height : 0}），
        这样能看清「改一块，后面的都对不上」。</div>`;
  } else {
    box.innerHTML = `<div class="row gap3 mb3"><span class="small dim2">挑一笔交易：</span>
        <span class="tag line">共 ${S.txs.length} 个可选</span></div>
      <div class="col gap2">
        ${S.txs.slice(0, 8).map((t) => `<div class="row-b" style="padding:9px 12px;border:1px solid var(--line);
          border-radius:10px;cursor:pointer" data-act="tamperGo" data-k="${tamperKind}" data-tx="${esc(t.txid)}">
          <div><span class="mono tiny">${esc(shortHash(t.txid, 16, 6))}</span>
            <span class="dim small"> · ${TYPE_CN[t.type] || t.type} · 金额 ${n(t.amount)}</span></div>
          <span class="tag line">#${t.block_height}</span>
        </div>`).join('')}
      </div>`;
  }
}

async function runTamper(kind, target) {
  const out = $('#tamperOut');
  out.innerHTML = `<div class="card-b"><div class="row gap3">${I('cpu', 18)}
    <b>正在改数据并重新校验…</b><span class="spin dark"></span></div></div>`;
  const body = { kind, ...target };
  try {
    const r = await A.tamper(body);
    const m = r.memory;
    out.innerHTML = `
    <div class="card-h"><h3>${I('alert', 16)} 实验结果：${esc(r.name)}</h3>
      <span class="tag ${r.apply ? 'bad' : 'line'}">${r.apply ? '已真实修改数据库' : '仅内存副本，数据库未被动'}</span></div>
    <div class="card-b">
      ${m && m.error ? `<div class="alert warn mb4">${I('alert', 14)}<div>${esc(m.error)}</div></div>` : ''}
      ${m && m.tampered ? `<div class="card pad mb4" style="background:var(--card-2)">
        <div class="grid g3" style="gap:12px">
          <div><div class="tiny dim2">改了什么</div><b class="small">${esc(m.tampered.what)} 的 ${esc(m.tampered.field)}</b></div>
          <div><div class="tiny dim2">改成之前</div><div class="mono tiny" style="word-break:break-all">${esc(String(m.tampered.from ?? '—'))}</div></div>
          <div><div class="tiny dim2">改成之后</div><div class="mono tiny" style="word-break:break-all;color:var(--bad)">${esc(String(m.tampered.to ?? '—'))}</div></div>
        </div></div>` : ''}
      <div class="grid g2" style="gap:16px">
        <div class="verdict ok">
          <h3>${I('okc', 18)} 动手之前</h3>
          <div class="small mt2">${esc(r.before.reason)}</div>
        </div>
        <div class="verdict ${(m ? m.result.ok : r.after.ok) ? 'bad' : 'bad'}">
          <h3>${I('xc', 18)} 动手之后</h3>
          <div class="small mt2">${esc(m ? m.result.reason : r.after.reason)}</div>
          ${(m && m.result.badHeight >= 0) || r.after.badHeight >= 0
    ? `<div class="mt3"><a class="btn sm danger" href="#/block/${(m && m.result.badHeight >= 0) ? m.result.badHeight : r.after.badHeight}">
        去看看第 ${(m && m.result.badHeight >= 0) ? m.result.badHeight : r.after.badHeight} 块</a></div>` : ''}
        </div>
      </div>
      <div class="alert ${r.apply ? (r.after.ok ? 'warn' : 'ok') : 'info'} mt4">${I('info', 15)}
        <div>${esc(r.hint)}</div></div>
      <div class="mt4 small dim">
        为什么能抓住？区块头里存着前一块的哈希，前一块又存着它前面的 —— 改任何一块，
        这个区块自己的哈希就变了，后一块记着的老哈希立刻对不上。想瞒过去，就得把后面所有块重挖一遍，
        难度每 +1 成本 ×16。
      </div>
    </div>`;
    if (r.apply) setTimeout(() => location.reload(), 4000);
  } catch (e) {
    out.innerHTML = `<div class="card-b"><div class="alert bad">${I('xc', 16)}
      <div><b>${esc(e.message)}</b></div></div></div>`;
  }
}

/* ============================ 导航 / 路由 ============================ */
function paintNav() {
  const links = [['#/', '概览'], ['#/blocks', '区块'], ['#/txs', '交易'],
    ['#/pool', '交易池'], ['#/validate', '全链校验'], ['#/lab', '篡改实验室']];
  $('#navlink').innerHTML = links.map(([h, t]) =>
    `<a href="${h}" class="${location.hash === h || (h !== '#/' && location.hash.startsWith(h)) ? 'on' : ''}">${t}</a>`).join('')
    + `<a href="/" >用户端 ${I('ext', 12)}</a>`;
  $('#uchip').innerHTML = S.user
    ? `<a class="uchip" href="/"><span class="ava">${esc(S.user.nickname.slice(0, 2))}</span>
        <div style="line-height:1.25"><div class="bold small">${esc(S.user.nickname)}</div>
        <div class="tiny dim2">回到用户端</div></div></a>`
    : `<a class="btn sm" href="/">去登录 / 注册</a>`;
}

const ROUTES = {
  '': viewHome,
  home: viewHome,
  blocks: viewBlocks,
  block: (q, id) => viewBlock(id),
  txs: viewTxs,
  tx: (q, id) => viewTx(id),
  addr: (q, id) => viewAddr(id),
  pool: viewPool,
  validate: viewValidate,
  lab: viewLab,
};

async function route() {
  const raw = location.hash.replace(/^#\/?/, '') || '';
  const [path, qs2] = raw.split('?');
  const seg = path.split('/');
  const q = Object.fromEntries(new URLSearchParams(qs2 || ''));
  paintNav();
  const fn = ROUTES[seg[0]];
  if (!fn) { $('#view').innerHTML = empty('页面不存在', '', 'alert'); return; }
  try { await fn(q, seg[1]); } catch (e) {
    $('#view').innerHTML = `<div class="card pad"><div class="alert bad">${I('alert', 16)}
      <div><b>加载失败</b><div class="small mt2">${esc(e.message)}</div></div></div></div>`;
  }
}

/* ============================ 事件 ============================ */
function bind() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.getAttribute('data-act');
    const h = t.getAttribute('data-h');
    const txid = t.getAttribute('data-tx');
    const map = {
      goBlock: () => { location.hash = '#/block/' + h; },
      bpage: () => { location.hash = '#/blocks?page=' + t.getAttribute('data-p'); },
      tpage: () => { location.hash = '#/txs?page=' + t.getAttribute('data-p'); },
      txfilter: () => { const ty = t.getAttribute('data-t'); location.hash = '#/txs' + (ty ? '?type=' + ty : ''); },
      txsearch: () => { const v = $('#txq').value.trim(); location.hash = '#/txs' + (v ? '?q=' + encodeURIComponent(v) : ''); },
      localVerify: () => localVerify(Number(h)),
      txProof: () => showProof(txid),
      verifyProof: () => showProof(txid),
      validateAll: () => runValidate(),
      reload: () => route(),
      mineNow: async () => {
        try {
          const r = await A.admMine(80);
          toast(`出块 #${r.height}，打包 ${r.txCount} 笔，耗时 ${r.minedMs}ms`, 'ok');
          if (!r.validate.ok) toast(r.validate.reason, 'bad', '警告：校验失败');
          route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      setDiff: async () => {
        try {
          const d = await A.admDifficulty(Number(t.getAttribute('data-d')));
          toast('难度已调整为 ' + d.difficulty); route();
        } catch (er) { toast(er.message, 'bad'); }
      },
      pickTamper: () => {
        tamperKind = t.getAttribute('data-k');
        document.querySelectorAll('.lab-card').forEach((x) => x.classList.remove('on'));
        t.classList.add('on');
        paintTamperTarget();
        $('#tamperOut').innerHTML = '';
      },
      tamperGo: () => {
        const k = t.getAttribute('data-k');
        const target = {};
        if (h) target.height = Number(h);
        if (txid) target.txid = txid;
        // 数值型篡改给一个明显的「假」值：时间戳往后挪一天 / 金额翻 50 倍
        if (k === 'block_ts') target.value = Date.now() + 86400000;
        if (k === 'block_nonce') target.value = 1;
        runTamper(k, target);
      },
      restore: async () => {
        try {
          const r = await A.tamperRestore();
          toast('已还原：' + r.restored, 'ok');
          toast(r.validate.ok ? '链校验恢复通过' : r.validate.reason, r.validate.ok ? 'ok' : 'bad');
          route();
        } catch (er) { toast(er.message, 'bad'); }
      },
    };
    if (map[act]) { e.preventDefault(); map[act](); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'txq') $('#txq').closest('.row').querySelector('[data-act="txsearch"]').click();
  });
  window.addEventListener('hashchange', route);
}

(async function boot() {
  bindCopy(document);
  bind();
  try { const r = await A.me(); S.user = r.user; } catch (e) { S.user = null; }
  await route();
})();
