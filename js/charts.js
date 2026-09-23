/* =====================================================================================
   手写 SVG / CSS 图表
   =====================================================================================
   不引 ECharts 之类的 CDN 库。理由有两条：
     ① 断网也能用（老师和同学拿到源码直接跑，不该因为拉不到 CDN 就变白板）
     ② 图表样式能跟设计系统完全一致，不会出现「库默认蓝」那种突兀感
   所有函数都返回字符串，直接塞进 innerHTML。
   ===================================================================================== */
import { n, esc } from './ui.js';

/** 环形进度。size 直径，stroke 线宽 */
export function ring(p, o = {}) {
  const size = o.size || 108, sw = o.stroke || 10;
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(p) || 0));
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const from = o.from || '#5B6CFF', to = o.to || '#8B5CF6';
  return `<div class="ring${o.small ? ' sm' : ''}" style="${o.size ? `width:${size}px;height:${size}px` : ''}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
      </linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#EDEFF6" stroke-width="${sw}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${sw}"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v / 100)}"
        style="transition:stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)"/>
    </svg>
    <div class="ring-txt"><div><b>${o.big !== undefined ? o.big : Math.round(v)}${o.unit || '%'}</b>
      <span>${esc(o.label || '')}</span></div></div>
  </div>`;
}

/** 面积折线图。data = [{x:'01-05', y:12}, ...] */
export function area(data, o = {}) {
  const W = 640, H = o.height || 170, pad = { t: 12, r: 8, b: 22, l: 34 };
  if (!data.length) return `<div class="empty small">暂无数据</div>`;
  const max = Math.max(o.max || 0, ...data.map((d) => d.y), 1);
  const step = data.length > 1 ? (W - pad.l - pad.r) / (data.length - 1) : 0;
  const X = (i) => pad.l + i * step;
  const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.y).toFixed(1)}`).join(' ');
  const areaPath = `${line} L${X(data.length - 1).toFixed(1)},${H - pad.b} L${X(0).toFixed(1)},${H - pad.b} Z`;
  const id = 'a' + Math.random().toString(36).slice(2, 8);
  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line class="grid-line" x1="${pad.l}" y1="${Y(v)}" x2="${W - pad.r}" y2="${Y(v)}"/>
      <text class="axis" x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${n(v)}</text>`;
  }).join('');
  const step2 = Math.max(1, Math.ceil(data.length / 7));
  const xlab = data.map((d, i) => (i % step2 === 0
    ? `<text class="axis" x="${X(i)}" y="${H - 5}" text-anchor="middle">${esc(String(d.x).slice(5))}</text>` : '')).join('');
  const dots = data.map((d, i) => `<circle cx="${X(i)}" cy="${Y(d.y)}" r="2.6" fill="#fff" stroke="${o.color2 || '#8B5CF6'}" stroke-width="2"><title>${esc(d.x)}：${n(d.y)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${o.color || '#5B6CFF'}" stop-opacity=".28"/>
      <stop offset="100%" stop-color="${o.color || '#5B6CFF'}" stop-opacity="0"/>
    </linearGradient></defs>
    ${ticks}
    <path d="${areaPath}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${o.color2 || '#6366F1'}" stroke-width="2.4"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlab}
  </svg>`;
}

/** 双系列面积图（收入 / 支出），用于积分流水趋势 */
export function area2(data, o = {}) {
  const W = 640, H = o.height || 180, pad = { t: 12, r: 8, b: 22, l: 36 };
  if (!data.length) return `<div class="empty small">暂无数据</div>`;
  const max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));
  const step = data.length > 1 ? (W - pad.l - pad.r) / (data.length - 1) : 0;
  const X = (i) => pad.l + i * step;
  const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const mk = (key) => data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d[key]).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line class="grid-line" x1="${pad.l}" y1="${Y(v)}" x2="${W - pad.r}" y2="${Y(v)}"/>
      <text class="axis" x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${n(v)}</text>`;
  }).join('');
  const step2 = Math.max(1, Math.ceil(data.length / 7));
  const xlab = data.map((d, i) => (i % step2 === 0
    ? `<text class="axis" x="${X(i)}" y="${H - 5}" text-anchor="middle">${esc(String(d.x).slice(5))}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    ${ticks}
    <path d="${mk('a')}" fill="none" stroke="#10B981" stroke-width="2.3" stroke-linejoin="round"/>
    <path d="${mk('b')}" fill="none" stroke="#F59E0B" stroke-width="2.3" stroke-linejoin="round" stroke-dasharray="5 4"/>
    ${xlab}
  </svg>
  <div class="row gap3 mt3 small dim"><span class="row gap2"><i class="dot" style="background:#10B981"></i>获得</span>
    <span class="row gap2"><i class="dot" style="background:#F59E0B"></i>消耗</span></div>`;
}

/** 竖柱：data = [{x, y}]，kind 决定配色 */
export function vbars(data, o = {}) {
  if (!data.length) return `<div class="empty small">暂无数据</div>`;
  const max = Math.max(1, ...data.map((d) => d.y));
  const cls = o.kind ? ' ' + o.kind : '';
  return `<div class="bars">${data.map((d) => `<div class="b${cls}"
      style="height:${Math.max(3, Math.round(d.y / max * 100))}%"
      title="${esc(d.x)}：${n(d.y)}${esc(o.unit || '')}"></div>`).join('')}</div>
    <div class="bars-x">${data.map((d) => `<span>${esc(String(d.x).slice(o.slice || 5))}</span>`).join('')}</div>`;
}

/** 横条：data = [{label, v, color}] */
export function hbars(data, o = {}) {
  if (!data.length) return `<div class="empty small">暂无数据</div>`;
  const max = Math.max(1, ...data.map((d) => d.v));
  return `<div>${data.map((d) => `<div class="hb">
    <div class="hb-l" title="${esc(d.label)}">${esc(d.label)}</div>
    <div class="hb-t"><i style="width:${Math.max(2, d.v / max * 100)}%;${d.color ? `background:${d.color}` : ''}"></i></div>
    <div class="hb-v">${n(d.v)}${esc(o.unit || '')}</div>
  </div>`).join('')}</div>`;
}

/** 环形占比图（甜甜圈） */
export function donut(items, o = {}) {
  const total = items.reduce((a, b) => a + Number(b.v || 0), 0) || 1;
  const size = o.size || 168, sw = o.stroke || 22, r = (size - sw) / 2, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = items.map((it) => {
    const len = c * (Number(it.v) / total);
    const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${it.color}"
      stroke-width="${sw}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}"
      transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(it.label)}：${n(it.v)}</title></circle>`;
    off += len;
    return seg;
  }).join('');
  const legend = items.map((it) => `<div class="row gap2 small" style="justify-content:space-between">
      <span class="row gap2"><i class="dot" style="background:${it.color}"></i>${esc(it.label)}</span>
      <b class="num">${n(it.v)}<span class="dim tiny"> · ${Math.round(it.v / total * 100)}%</span></b>
    </div>`).join('');
  return `<div class="row gap6" style="gap:26px;align-items:center;flex-wrap:wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#F1F3F9" stroke-width="${sw}"/>
      ${arcs}
      <text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" font-size="20" font-weight="800"
        fill="var(--txt)">${n(o.center !== undefined ? o.center : total)}</text>
      <text x="${size / 2}" y="${size / 2 + 15}" text-anchor="middle" font-size="10.5"
        fill="var(--txt-3)">${esc(o.centerLabel || '合计')}</text>
    </svg>
    <div class="grow" style="min-width:170px;display:flex;flex-direction:column;gap:8px">${legend}</div>
  </div>`;
}

/** 漏斗：steps = [{label, v}] */
export function funnel(steps) {
  if (!steps.length) return '';
  const max = Math.max(1, steps[0].v);
  return `<div class="funnel-row">${steps.map((s, i) => {
    const w = Math.max(8, s.v / max * 100);
    const prev = i ? steps[i - 1].v : s.v;
    const rate = i ? Math.round(s.v / Math.max(1, prev) * 100) : 100;
    return `<div class="fnl">
      <div class="fnl-bar" style="width:${w}%;background:linear-gradient(90deg,
        hsl(${248 - i * 8} 85% 62%), hsl(${268 - i * 6} 80% 64%))">
        <span style="white-space:nowrap">${esc(s.label)} · ${n(s.v)}</span></div>
      <span class="fnl-l">${i ? `转化 ${rate}%` : '起点'}</span>
    </div>`;
  }).join('')}</div>`;
}

/** 24 小时热力（积分动作分布在几点） */
export function hourHeat(list, o = {}) {
  const map = new Map(list.map((x) => [Number(x.h), Number(x.n)]));
  const max = Math.max(1, ...list.map((x) => Number(x.n)));
  const cells = Array.from({ length: 24 }, (_, h) => {
    const v = map.get(h) || 0;
    const alpha = v ? (0.12 + 0.88 * (v / max)) : 0.05;
    return `<div class="hh" style="background:rgba(91,108,255,${alpha.toFixed(2)})"
      title="${h}:00 共 ${n(v)} 笔"></div>`;
  }).join('');
  return `<div class="hour-heat">${cells}</div>
    <div class="row-b tiny dim" style="margin-top:5px"><span>0 点</span><span>6 点</span>
      <span>12 点</span><span>18 点</span><span>23 点</span></div>
    ${o.hint ? `<div class="tiny dim2 mt3">${esc(o.hint)}</div>` : ''}`;
}

/**
 * 签到热力图。
 * 按「周」分列（周一到周日一行七天），横向是周，像 GitHub 那样一眼看出规律。
 */
export function heatmap(list, o = {}) {
  const map = new Map(list.map((r) => [String(r.day), r]));
  const days = o.days || 84;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 起点对齐到那一周的周一
  const start = new Date(today); start.setDate(start.getDate() - days + 1);
  const shift = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - shift);
  const weeks = [];
  const cur = new Date(start);
  while (cur <= today) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cur); d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = map.get(key);
      col.push({ key, d: new Date(d), rec, future: d > today });
    }
    weeks.push(col);
    cur.setDate(cur.getDate() + 7);
  }
  const cell = (c) => {
    if (c.future) return `<div class="hm-cell" style="opacity:.25"></div>`;
    const isToday = c.d.getTime() === today.getTime();
    if (!c.rec) {
      return `<div class="hm-cell miss${isToday ? ' today' : ''}" title="${c.key} 没有签到"></div>`;
    }
    // 颜色深浅 = 当天任务完成率 + 是否签到
    const total = Number(c.rec.task_total || 0), done = Number(c.rec.task_done || 0);
    const rate = total ? done / total : 1;
    const lv = rate >= 1 ? 4 : rate >= 0.7 ? 3 : rate >= 0.4 ? 2 : 1;
    return `<div class="hm-cell l${lv}${isToday ? ' today' : ''}"
      title="${c.key} 签到 +${c.rec.total_points} 分 · 任务 ${done}/${total}"></div>`;
  };
  const wd = ['一', '二', '三', '四', '五', '六', '日'];
  return `<div class="hm">
    <div class="row gap3" style="align-items:flex-start">
      <div class="col tiny dim2" style="gap:4px;padding-top:0">${wd.map((x) => `<span style="height:13px;line-height:13px">${x}</span>`).join('')}</div>
      <div class="hm-weeks">${weeks.map((w) => `<div class="hm-w">${w.map(cell).join('')}</div>`).join('')}</div>
    </div>
    <div class="row-b mt3"><div class="hm-legend">
      <span>少</span>
      <div class="hm-cell l0"></div><div class="hm-cell l1"></div><div class="hm-cell l2"></div>
      <div class="hm-cell l3"></div><div class="hm-cell l4"></div>
      <span>当天任务全清</span></div>
      <span class="tiny dim2">虚线格 = 当天没签到</span>
    </div>
  </div>`;
}

/** 迷你火花线（表格里用） */
export function spark(values, o = {}) {
  const W = o.w || 84, H = o.h || 24;
  if (!values.length) return '';
  const max = Math.max(1, ...values), min = Math.min(...values);
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const y = (v) => H - 2 - (H - 4) * ((v - min) / Math.max(1, max - min));
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <path d="${d}" fill="none" stroke="${o.color || '#5B6CFF'}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** 积分/成长 等级条 */
export function levelBar(level, exp, step) {
  const inLevel = exp % step;
  const p = step ? Math.round(inLevel / step * 100) : 0;
  return `<div class="row gap3">
    <span class="tag brand">Lv.${level}</span>
    <div class="prog grow"><i style="width:${p}%"></i></div>
    <span class="tiny dim2 num">${n(inLevel)}/${n(step)}</span>
  </div>`;
}
