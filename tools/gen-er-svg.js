/* =====================================================================================
   E-R 图生成器（教科书 Chen 风格：实体矩形 / 联系菱形 / 基数标注）
   -------------------------------------------------------------------------------------
   正交栅格布局，三列：
     第 1 列  用户（核心实体）
     第 2 列  一级联系菱形 + 一级业务实体
     第 3 列  二级联系菱形 + 依赖的主数据实体
   用户到一级联系之间用一条纵向「总线」扇出（六条联系同源），走线全是横平竖直，
   比辐射式更好排版、也更接近教科书画法。

     node tools/gen-er-svg.js        # → docs/figs/src/er.svg
   ===================================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------ 布局参数 ------------------------------ */
const W = 1080, H = 946;

const UX = 60, UW = 200, UH = 74;             // 第 1 列：用户
const BUS = 330;                              // 扇出总线 x
const D1X = 452, D2X = 782;                   // 两个联系菱形的中心 x
const E1X = 540, E1W = 152, E1H = 52;         // 一级实体
const E2X = 846, E2W = 150, E2H = 50;         // 二级实体
const ROW0 = 82, ROWGAP = 144;                // 首行 y 与行距

const DL = 24, DW = 34;                       // 菱形沿轴半长 / 横向半宽
const UCY = ROW0 + ROWGAP * 2.5;              // 用户纵向居中

/* 六条主联系（自上而下）。菱形里只放两字，避免文字溢出菱形 */
const ROWS = [
  { d1: '提交', d2: null, e1: ['签到记录', 'checkins'], e2: null },
  { d1: '记录', d2: '归属', e1: ['每日任务', 'tasks'], e2: ['任务模板', 'task_templates'] },
  { d1: '产生', d2: '结算', e1: ['积分流水', 'point_ledger'], e2: ['链上交易', 'txs → blocks'] },
  { d1: '铸造', d2: '属于', e1: ['成就凭证', 'badge_claims'], e2: ['徽章定义', 'badges'] },
  { d1: '兑换', d2: '兑换', e1: ['兑换单', 'redemptions'], e2: ['商城商品', 'rewards'] },
  { d1: '押注', d2: '加入', e1: ['目标押注', 'stakes'], e2: ['自习室', 'teams · team_members'] },
];

/* ------------------------------ 逐行生成 ------------------------------ */
const L = [];   // 连线
const S = [];   // 图形
const T = [];   // 文本

// 用户 → 总线，以及总线本身（六条联系同源，所以画成一条汇流线）
L.push(`<line x1="${UX + UW}" y1="${UCY}" x2="${BUS}" y2="${UCY}"/>`);
L.push(`<line x1="${BUS}" y1="${ROW0}" x2="${BUS}" y2="${ROW0 + ROWGAP * 5}"/>`);
T.push({ x: (UX + UW + BUS) / 2, y: UCY - 12, t: '1', c: '#6D28D9', s: 13 });

ROWS.forEach((r, i) => {
  const y = ROW0 + ROWGAP * i;

  // 总线 → 联系1 菱形 → 实体1
  L.push(`<line x1="${BUS}" y1="${y}" x2="${D1X - DL}" y2="${y}"/>`);
  L.push(`<line x1="${D1X + DL}" y1="${y}" x2="${E1X}" y2="${y}"/>`);

  S.push(`<polygon points="${D1X - DL},${y} ${D1X},${y - DW} ${D1X + DL},${y} ${D1X},${y + DW}" fill="#FFFFFF" stroke="#8B5CF6" stroke-width="1.6"/>`);
  T.push({ x: D1X, y: y + 4.5, t: r.d1, c: '#5B21B6', s: 11.5 });

  S.push(`<rect x="${E1X}" y="${y - E1H / 2}" width="${E1W}" height="${E1H}" rx="11" fill="#FFFFFF" stroke="#C9CFFA" stroke-width="1.6" filter="url(#e1)"/>`);
  T.push({ x: E1X + E1W / 2, y: y - 1, t: r.e1[0], c: '#1B2340', s: 13, w: '700' });
  T.push({ x: E1X + E1W / 2, y: y + 16, t: r.e1[1], c: '#8A93AB', s: 10, mono: true });

  // 基数：1 靠用户侧、N 靠实体侧
  T.push({ x: (BUS + D1X - DL) / 2, y: y - 9, t: '1', c: '#6D28D9', s: 12.5 });
  T.push({ x: (D1X + DL + E1X) / 2, y: y - 9, t: 'N', c: '#6D28D9', s: 12.5 });

  if (!r.e2) return;

  // 实体1 → 联系2 菱形 → 实体2
  L.push(`<line x1="${E1X + E1W}" y1="${y}" x2="${D2X - DL}" y2="${y}"/>`);
  L.push(`<line x1="${D2X + DL}" y1="${y}" x2="${E2X}" y2="${y}"/>`);

  S.push(`<polygon points="${D2X - DL},${y} ${D2X},${y - DW} ${D2X + DL},${y} ${D2X},${y + DW}" fill="#FFFFFF" stroke="#0EA5E9" stroke-width="1.5"/>`);
  T.push({ x: D2X, y: y + 4.5, t: r.d2, c: '#0369A1', s: 10.5 });

  S.push(`<rect x="${E2X}" y="${y - E2H / 2}" width="${E2W}" height="${E2H}" rx="11" fill="#F4F7FE" stroke="#CBD8F0"/>`);
  T.push({ x: E2X + E2W / 2, y: y - 1, t: r.e2[0], c: '#1B2340', s: 12.5, w: '600' });
  T.push({ x: E2X + E2W / 2, y: y + 16, t: r.e2[1], c: '#8A93AB', s: 10, mono: true });

  T.push({ x: (E1X + E1W + D2X - DL) / 2, y: y - 9, t: 'N', c: '#0369A1', s: 11.5 });
  T.push({ x: (D2X + DL + E2X) / 2, y: y - 9, t: '1', c: '#0369A1', s: 11.5 });
});

// 用户实体
S.push(`<rect x="${UX}" y="${UCY - UH / 2}" width="${UW}" height="${UH}" rx="16" fill="url(#gC)" filter="url(#e1)"/>`);
T.push({ x: UX + UW / 2, y: UCY - 4, t: '用户', c: '#FFFFFF', s: 18, w: '700' });
T.push({ x: UX + UW / 2, y: UCY + 21, t: 'users · user_stats', c: '#DDE1FF', s: 11, mono: true });

/* ------------------------------ 输出 ------------------------------ */
const txt = (t) => {
  const a = [`<text x="${t.x}" y="${t.y}" font-size="${t.s}"`];
  if (t.w) a.push(` font-weight="${t.w}"`);
  if (t.mono) a.push(` font-family="Consolas, monospace"`);
  a.push(` text-anchor="middle"`);
  a.push(` fill="${t.c}">${t.t}</text>`);
  return a.join('');
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Microsoft YaHei, PingFang SC, sans-serif">
  <defs>
    <linearGradient id="gC" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5B6CFF"/><stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
    <filter id="e1" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#1E2A50" flood-opacity="0.11"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <text x="40" y="44" font-size="21" font-weight="700" fill="#1B2340">数据库概念结构（E-R 图）</text>

  <g stroke="#C3C9E2" stroke-width="1.8" fill="none">
${L.map((l) => '    ' + l).join('\n')}
  </g>

${S.map((s) => '  ' + s).join('\n')}

${T.map((t) => '  ' + txt(t)).join('\n')}

  <rect x="40" y="${H - 88}" width="${W - 80}" height="58" rx="14" fill="#F7F8FD" stroke="#E3E6F5"/>
  <rect x="62" y="${H - 72}" width="32" height="18" rx="5" fill="url(#gC)"/>
  <text x="102" y="${H - 58}" font-size="11.5" fill="#4A5470">核心实体</text>
  <rect x="182" y="${H - 72}" width="32" height="18" rx="5" fill="#FFFFFF" stroke="#C9CFFA" stroke-width="1.6"/>
  <text x="222" y="${H - 58}" font-size="11.5" fill="#4A5470">业务实体</text>
  <rect x="302" y="${H - 72}" width="32" height="18" rx="5" fill="#F4F7FE" stroke="#CBD8F0"/>
  <text x="342" y="${H - 58}" font-size="11.5" fill="#4A5470">依赖的主数据</text>
  <polygon points="462,${H - 63} 494,${H - 54} 462,${H - 45} 430,${H - 54}" fill="#FFFFFF" stroke="#8B5CF6" stroke-width="1.6"/>
  <text x="504" y="${H - 58}" font-size="11.5" fill="#4A5470">用户侧联系</text>
  <polygon points="622,${H - 63} 654,${H - 54} 622,${H - 45} 590,${H - 54}" fill="#FFFFFF" stroke="#0EA5E9" stroke-width="1.5"/>
  <text x="664" y="${H - 58}" font-size="11.5" fill="#4A5470">主数据归属联系</text>
  <text x="62" y="${H - 38}" font-size="11" fill="#A0A8BF">1:N 一个用户对多条　M:N 多对多（自习室成员）　·　完整清单：23 张表 / 5 个视图 / 310 字段 / 83 索引 / 13 外键，见正文表 4-1</text>
</svg>
`;

const out = path.join(__dirname, '..', 'docs', 'figs', 'src', 'er.svg');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg, 'utf8');
console.log(`已生成 ${out}（${ROWS.length} 条一级联系，${ROWS.filter((r) => r.e2).length} 条二级联系）`);
