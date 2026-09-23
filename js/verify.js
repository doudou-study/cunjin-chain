/* =====================================================================================
   凭证验真页（公开，免登录）
   =====================================================================================
   这个页面要说清一件事：**验真不靠平台的服务器点头**。
     ① 拿凭证号去问业务库 —— 这张凭证是不是真发过、有没有被撤销
     ② 拿交易号去问链 —— 这笔交易在不在链上、在第几块
     ③ 拿到 Merkle 证明 —— 然后用浏览器自己的 WebCrypto 从叶子一路算到区块头
   第 ③ 步是本地算的，服务器给的是「材料」，不是「结论」。
   即使服务器想骗人，它也得同时伪造 Merkle 路径和区块头哈希，而区块头哈希还牵着上一块。
   ===================================================================================== */
import * as A from './api.js';
import { $, I, esc, n, dt, shortHash, toast, skel, empty, copy, bindCopy } from './ui.js';
import * as L from './chain-lite.js';

const $view = $('#view');
let lastCode = '';

const LEVEL_NAME = { 1: '铜', 2: '银', 3: '金', 4: '钻石' };

/* ============================ 输入区 ============================ */
function paintForm(code = '') {
  $view.innerHTML = `
  <div class="ptitle" style="margin-bottom:16px">
    <div>
      <h1>凭证验真</h1>
      <div class="psub">把成就凭证上的编号输进来，看看它是真是假。不需要登录，也不需要装任何东西。</div>
    </div>
  </div>

  <div class="card">
    <div class="card-b">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div class="field grow" style="margin-bottom:0;min-width:260px">
          <label>凭证号</label>
          <input class="ctl" id="code" placeholder="例如 ZJ-A1B2-C3D4-E5F6（大小写都可以）"
            value="${esc(code)}" autocomplete="off" spellcheck="false"
            style="font-family:var(--mono);letter-spacing:.04em">
        </div>
        <button class="btn pri lg" id="go" style="height:42px">${I('search', 16)} 验真</button>
      </div>
      <div class="mt4 small dim">
        平台签发的每一枚成就徽章都绑定一张链上凭证。凭证号抄错一位就查不到 —— 这不是容错，是设计。
      </div>
      <div class="mt5" id="samples"></div>
    </div>
  </div>

  <div id="out" class="mt5"></div>

  <div class="card mt5">
    <div class="card-h"><h3>${I('shield', 15)} 为什么这个结论可信</h3></div>
    <div class="card-b">
      <div class="step-list">
        <div class="st"><span class="st-n">1</span><div>
          <b>业务库对账</b>
          <div class="small dim mt3">凭证号、持有人、徽章、领取时间都从业务库里查。这一步只说明「平台说发过」。</div></div></div>
        <div class="st"><span class="st-n">2</span><div>
          <b>链上交易存在性</b>
          <div class="small dim mt3">查这笔铸造交易是否已经打包进某个区块。没打包 = 平台嘴上说发了、链上没有，判定为可疑。</div></div></div>
        <div class="st ok"><span class="st-n">3</span><div>
          <b>Merkle 证明（浏览器本地重算）</b>
          <div class="small dim mt3">服务器把这条从交易号到 Merkle 根的路径给你，浏览器用 <span class="mono">crypto.subtle</span>
            自己一步步哈希上去。哈希对不上就是假的 —— 结论在你这台机器上产生。</div></div></div>
        <div class="st"><span class="st-n">4</span><div>
          <b>区块头自洽</b>
          <div class="small dim mt3">Merkle 根只是区块头里的一个字段，区块头本身还要满足前哈希链接与工作量目标。
            想整块伪造，得从那一块往后把每一块都重挖一遍。</div></div></div>
      </div>
      <div class="adm-note mt4" style="display:flex;gap:8px;align-items:flex-start">
        <span style="flex:none">${I('info', 15)}</span>
        <div class="small">想看「改了就一定被抓」的完整演示，去
          <a href="/cunjin-chain/chain#/lab">链浏览器 · 篡改实验室</a>，那里可以亲手改一笔链上金额再跑校验。</div>
      </div>
    </div>
  </div>`;

  $('#go').onclick = () => {
    const v = $('#code').value.trim();
    if (!v) return toast('先输入凭证号', 'warn');
    ask(v);
  };
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });

  loadSamples();
}

async function loadSamples() {
  const box = $('#samples');
  if (!box) return;
  box.innerHTML = `<div class="small dim2 mb3">没有凭证号？用下面这几个真实存在的试试（含一张已被撤销的）：</div>
    <div class="row gap2" style="flex-wrap:wrap">${skel(30, '150px')}${skel(30, '150px')}</div>`;
  try {
    const r = await A.verifySamples();
    box.innerHTML = `<div class="small dim2 mb3">没有凭证号？用下面这几个真实存在的试试 ——
      全站 ${n(r.total)} 张已上链凭证
      ${r.revokedTotal ? `，其中 <b>${n(r.revokedTotal)} 张已被撤销</b>，正好看看验真怎么区分：` : '，点一个看看：'}</div>
      <div class="row gap2" style="flex-wrap:wrap">${r.list.map((s) => `
        <button class="chip" data-sample="${esc(s.verify_code)}">
          ${esc(s.badge_name)} · ${esc(s.nickname)}
          ${s.status === 'revoked' ? '<span class="tag bad" style="margin-left:4px">已撤销</span>' : ''}
        </button>`).join('')}</div>`;
    box.querySelectorAll('[data-sample]').forEach((b) => {
      b.onclick = () => { $('#code').value = b.getAttribute('data-sample'); ask(b.getAttribute('data-sample')); };
    });
  } catch (e) {
    box.innerHTML = '';
  }
}

/* ============================ 查询 ============================ */
async function ask(code) {
  const out = $('#out');
  lastCode = code;
  history.replaceState(null, '', '/cunjin-chain/verify?code=' + encodeURIComponent(code));
  out.innerHTML = `<div class="card"><div class="card-b"><div class="row gap3">${skel(40, '40px')}
    <div class="grow">${skel(14, '60%')}<div class="mt3">${skel(12, '90%')}</div></div></div></div></div>
    <div class="card mt4"><div class="card-b">${skel(120)}</div></div>`;
  try {
    const r = await A.verify(code);
    out.innerHTML = await render(r, code);
    bindCopy(out);
  } catch (e) {
    out.innerHTML = `<div class="card"><div class="card-b">
      <div class="alert bad">${I('alert', 16)}<div><b>查询失败</b><div class="small mt2">${esc(e.message)}</div></div></div>
    </div></div>`;
  }
}

/* ============================ 渲染 ============================ */
async function render(r, code) {
  if (!r.found) {
    return `<div class="card"><div class="card-b">
      <div class="verdict bad" style="display:flex;gap:14px;align-items:flex-start">
        <span style="color:#C81E36;flex:none">${I('xc', 30)}</span>
        <div>
          <h3>查不到这个凭证</h3>
          <p class="small mt3" style="color:#8B1E32">${esc(r.message)}</p>
          <div class="mono mt3" style="color:#8B1E32">查询串：${esc(code)}</div>
        </div>
      </div>
      <div class="small dim mt4">可能的原因：抄错了一位、凭证号里的横杠漏了、或者这张凭证是别人伪造出来的。</div>
    </div></div>`;
  }

  const ok = r.result === 'valid';
  const revoked = r.result === 'revoked';

  /* --- 第 ③ 步：浏览器本地重算 Merkle 证明 --- */
  let local = { state: 'idle', text: '这笔交易还没打包，暂时拿不到 Merkle 证明' };
  if (r.chain) {
    try {
      const proof = await A.chainProof(r.chain.txid);
      if (!L.available()) {
        local = { state: 'skip', text: '当前浏览器不支持 WebCrypto，跳过本地重算（换 Chrome/Edge 即可）' };
      } else {
        const v = await L.verifyMerkleProof(proof.leaf, proof.path, proof.root);
        local = v.ok
          ? { state: 'ok', text: `本地重算通过：${proof.path.length} 层哈希后得到 ${shortHash(v.computed, 12, 8)}，与区块头里的 Merkle 根一致` }
          : { state: 'bad', text: `本地重算失败：算出来是 ${shortHash(v.computed, 12, 8)}，区块头写的是 ${shortHash(proof.root, 12, 8)}` };
        local.proof = proof;
      }
    } catch (e) {
      local = { state: 'bad', text: '取不到 Merkle 证明：' + e.message };
    }
  }

  const merged = ok && (local.state === 'ok' || local.state === 'skip');

  // 徽章图标（跟徽章墙用同一套 SVG）
  const iColor = r.badge.color || '#6366F1';
  const steps = [
    { name: '业务库里有这张凭证', ok: true, detail: `序列号 ${r.serial} · 领取于 ${dt(r.claimedAt)}` },
    { name: '凭证状态正常（未被撤销）', ok: !revoked, detail: revoked ? '发行方已撤销这张凭证' : '状态：有效' },
    { name: '铸造交易已在链上', ok: !!r.chain, detail: r.chain ? `区块高度 #${r.chain.height}` : '链上找不到这笔交易' },
    { name: 'Merkle 证明（浏览器本地重算）', ok: local.state === 'ok' || local.state === 'skip', detail: local.text },
  ];

  return `
  <div class="card">
    <div class="card-h">
      <h3>${I('scan', 15)} 验真结果
        <span class="hsub mono">${esc(r.verifyCode)}</span></h3>
      <button class="btn sm" data-copy="${esc(r.verifyCode)}">${I('copy', 13)} 复制凭证号</button>
    </div>
    <div class="card-b">
      <div class="verdict ${merged ? 'ok' : 'bad'}" style="display:flex;gap:16px;align-items:flex-start">
        <span style="color:${merged ? '#067A5B' : '#C81E36'};flex:none">${I(merged ? 'okc' : (revoked ? 'shield' : 'xc'), 32)}</span>
        <div class="grow">
          <h3>${merged ? '凭证有效' : (revoked ? '凭证已撤销' : '凭证存疑，请勿采信')}</h3>
          <p class="small mt3" style="color:${merged ? '#067A5B' : '#8B1E32'}">${esc(r.message)}</p>
        </div>
      </div>

      ${revoked ? `<div class="adm-note warn mt4" style="display:flex;gap:9px;align-items:flex-start">
        <span style="flex:none">${I('info', 15)}</span>
        <div class="small">注意这里的分寸：<b>链上那笔铸造交易并没有消失</b>，区块高度、时间戳、签名都还在，
        谁也删不掉。撤销改的是业务库里的一个状态位 —— 平台能声明「不再认可这张凭证」，
        但改不了「它确实发生过」。这两件事被分开记录，才是可追责的做法。</div></div>` : ''}

      <div class="step-list mt5" id="verifySteps">
        ${steps.map((s) => `<div class="st ${s.ok ? 'ok' : 'bad'}">
          <span class="st-n">${s.ok ? I('check', 13) : I('x', 13)}</span>
          <div class="grow" style="min-width:0">
            <div class="row-b"><b class="small">${esc(s.name)}</b>
              <span class="tag ${s.ok ? 'ok' : 'bad'}">${s.ok ? '通过' : '不通过'}</span></div>
            <div class="small dim mt3" style="word-break:break-word">${esc(s.detail)}</div>
          </div></div>`).join('')}
      </div>
    </div>
  </div>

  <div class="mt5">${certCard(r, iColor)}</div>

  ${r.chain ? chainCard(r, local) : ''}
  `;
}

/** 凭证卡：可以整张截图发出去的那张 */
function certCard(r, color) {
  return `<div class="cert">
    <div class="cert-in">
      <div class="row-b" style="align-items:flex-start;gap:18px;flex-wrap:wrap">
        <div class="row gap4" style="align-items:flex-start">
          <div class="badge-ico" style="margin:0;background:linear-gradient(135deg,${esc(color)},${esc(color)}cc)">
            ${I(r.badge.icon, 26)}</div>
          <div>
            <div class="cert-no">${esc(r.badge.code)} · ${LEVEL_NAME[r.badge.level] || ''}级徽章</div>
            <h2 style="font-size:22px;margin-top:6px">${esc(r.badge.name)}</h2>
            <div class="small dim mt3">${esc(r.badge.cond || '')}</div>
          </div>
        </div>
        <img class="qr" src="${A.verifyQr(r.verifyCode)}" alt="凭证二维码" width="132" height="132">
      </div>

      <div class="grid g3 mt6" style="gap:14px">
        <div><div class="tiny dim2">持有人</div><div class="bold mt3">${esc(r.holder.nickname)}</div></div>
        <div><div class="tiny dim2">链上地址</div>
          <div class="mt3"><a class="hash" href="/cunjin-chain/chain#/addr/${esc(r.holder.addr)}"
            title="${esc(r.holder.addr)}">${I('cube', 11)}${esc(shortHash(r.holder.addr, 10, 6))}</a></div></div>
        <div><div class="tiny dim2">序列号</div><div class="bold mono mt3">${esc(r.serial)}</div></div>
      </div>

      <div class="row-b mt6" style="border-top:1px dashed var(--line-2);padding-top:14px;flex-wrap:wrap;gap:10px">
        <div class="small dim">寸进链 · 每日打卡积分与链上成就存证平台</div>
        <div class="tiny dim2">扫码或打开 <span class="mono">/verify?code=${esc(r.verifyCode)}</span> 可复核</div>
      </div>
    </div>
  </div>`;
}

/** 链上明细 + 本地重算的中间值，全部摆出来让人自己核对 */
function chainCard(r, local) {
  const c = r.chain;
  return `<div class="card">
    <div class="card-h">
      <h3>${I('cube', 15)} 链上明细</h3>
      <a class="btn sm" href="/cunjin-chain/chain#/tx/${esc(c.txid)}" target="_blank" rel="noopener">${I('ext', 13)} 在链浏览器打开</a>
    </div>
    <div class="card-b">
      <div class="grid g2" style="gap:8px 26px">
        <dl>
          <div class="adm-kv"><dt>交易号</dt><dd class="mono" style="font-size:11.5px">
            <a class="hash" href="/cunjin-chain/chain#/tx/${esc(c.txid)}">${shortHash(c.txid, 12, 8)}</a></dd></div>
          <div class="adm-kv"><dt>交易类型</dt><dd>${esc(c.type)}</dd></div>
          <div class="adm-kv"><dt>铸造消耗积分</dt><dd>${n(c.amount)} 分（转入销毁账户）</dd></div>
          <div class="adm-kv"><dt>所在区块</dt><dd>#${c.height}</dd></div>
        </dl>
        <dl>
          <div class="adm-kv"><dt>区块时间</dt><dd>${dt(c.blockTs)}</dd></div>
          <div class="adm-kv"><dt>挖矿难度</dt><dd>${c.difficulty}（哈希前缀 ${'0'.repeat(Number(c.difficulty))}）</dd></div>
          <div class="adm-kv"><dt>区块 nonce</dt><dd class="mono">${n(c.nonce)}</dd></div>
          <div class="adm-kv"><dt>区块头 Merkle 根</dt><dd class="mono" style="font-size:11.5px">${shortHash(c.merkleRoot, 12, 8)}</dd></div>
        </dl>
      </div>

      ${local.proof ? `<div class="mt5" style="background:var(--card-2);border-radius:var(--r-md);padding:14px 16px">
        <div class="row-b mb3">
          <b class="small">${I('link', 13)} Merkle 路径（服务器给的材料，不是结论）</b>
          <span class="tag ${local.state === 'ok' ? 'ok' : 'bad'}">
            ${local.state === 'ok' ? '浏览器重算通过' : '浏览器重算失败'}</span>
        </div>
        <div class="small dim mb3">这 ${local.proof.path.length} 个节点与叶子交易号逐层哈希，最终应等于区块头里的 Merkle 根：</div>
        <div class="mono small" style="display:flex;flex-direction:column;gap:5px;word-break:break-all">
          <div><span class="dim2">叶子（交易号）</span><br>${esc(local.proof.leaf)}</div>
          ${local.proof.path.map((p, i) => `<div><span class="dim2">第 ${i + 1} 层 · ${p.left ? '兄弟在左，拼在后面' : '兄弟在右，拼在前面'}</span>
            <br>${esc(p.hash)}</div>`).join('')}
          <div><span class="dim2">根（区块头记录）</span><br>${esc(local.proof.root)}</div>
        </div>
      </div>` : ''}
    </div>
  </div>`;
}

/* ============================ 启动 ============================ */
(async function boot() {
  bindCopy(document);
  const q = new URLSearchParams(location.search).get('code') || '';
  paintForm(q);
  if (q) await ask(q);
})();
