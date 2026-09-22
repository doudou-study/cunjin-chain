/* =====================================================================================
   寸进链 · 前端公共层
   图标全部手写 SVG（24×24 stroke），不用 emoji —— emoji 在不同系统上长得不一样，
   在截图和录屏里尤其明显。
   ===================================================================================== */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** 转义，凡是要拼进 innerHTML 的用户数据都必须过一遍 */
export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const el = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  if (html !== undefined) n.innerHTML = html;
  return n;
};

/* ============================ 图标 ============================ */
const P = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a3 3 0 0 0-5 1c0 2 5 1 5 3a3 3 0 0 1-5 1M12 7v10"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M17 4.5a3.5 3.5 0 0 1 0 7M19 21v-1a5.5 5.5 0 0 0-3-4.9"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M7.5 8a2.5 2.5 0 1 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.3 3-5.5A5.5 5.5 0 0 0 12 5 5.5 5.5 0 0 0 2 8.5c0 2.2 1.5 4 3 5.5l7 7Z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 14 3.5-4 3 3L20 6"/>',
  star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.8 6.2 20.8l1.1-6.4L2.6 9.8l6.5-.9Z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  okc: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  xc: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M5 6l1 15h12l1-15M10 11v6M14 11v6"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5Z"/><path d="M4 17.5h16"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  hammer: '<path d="m14 5 5 5-2 2-5-5Z"/><path d="m11 8-8 8 3 3 8-8"/><path d="M17 3l4 4-2 2-4-4Z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 14h2"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  scale: '<path d="M12 3v18M7 21h10M5 8h14l-3 6a4 4 0 0 1-8 0Z"/>',
  play: '<path d="m6 3 14 9-14 9Z"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
  sort: '<path d="M8 5v14M8 5 5 8M8 5l3 3M16 19V5M16 19l3-3M16 19l-3-3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8-8M17 4l3 3M15 6l2 2"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16"/>',
  // 徽章用到的图标。少一个就会静默退化成「信息圈」，徽章墙会变成一片 i，
  // 所以这里必须跟 badges.icon 里出现过的名字对齐（见 sql/schema.sql 注释）。
  medal: '<path d="M7.5 15 3 7.2a2 2 0 0 1 .1-2.2L4.4 3.6A2 2 0 0 1 6 3h12a2 2 0 0 1 1.6.6L21 5a2 2 0 0 1 .1 2.2L16.5 15"/><circle cx="12" cy="17" r="5"/><path d="M12 18.5V16"/>',
  crown: '<path d="M3 17.5h18M4 17.5 2.7 8.1a.5.5 0 0 1 .8-.5l4.3 3.7L12 4.5l4.2 6.8 4.3-3.7a.5.5 0 0 1 .8.5L20 17.5"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/><path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  gem: '<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M11 3 8 9l4 12 4-12-3-6M2 9h20"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1ZM4 22v-7"/>',
};

/** 生成一个图标。name 见上表，size 单位 px */
export function I(name, size = 16, extra = '') {
  const d = P[name] || P.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}`
    + ` style="flex:none;vertical-align:-2px">${d}</svg>`;
}

/* ============================ 格式化 ============================ */
export const n = (v) => Number(v || 0).toLocaleString('zh-CN');
export const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

export function dt(v) {
  if (!v) return '—';
  const d = new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T'));
  if (isNaN(d)) return String(v);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function dOnly(v) {
  if (!v) return '—';
  return String(v).slice(0, 10);
}
export function ago(v) {
  if (!v) return '—';
  const t = typeof v === 'number' ? v : new Date(String(v).replace(' ', 'T')).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' 天前';
  return dt(v).slice(0, 10);
}
export const shortHash = (h, a = 8, b = 6) => (!h ? '—' : (h.length <= a + b + 1 ? h : h.slice(0, a) + '…' + h.slice(-b)));

/* ============================ 提示条 ============================ */
let toastBox = null;
export function toast(msg, type = 'ok', title = '') {
  if (!toastBox) { toastBox = el('div', { class: 'toasts' }); document.body.appendChild(toastBox); }
  const icons = { ok: 'okc', bad: 'xc', warn: 'alert', info: 'info' };
  const t = el('div', { class: 'toast ' + type },
    `<span style="color:var(--${type === 'ok' ? 'ok' : type === 'bad' ? 'bad' : type === 'warn' ? 'streak' : 'brand-1'})">${I(icons[type] || 'info', 17)}</span>`
    + `<div class="grow">${title ? `<b>${esc(title)}</b>` : ''}<span class="dim">${esc(msg)}</span></div>`);
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 240); }, type === 'bad' ? 5200 : 3600);
  return t;
}

/* ============================ 弹层 ============================ */
export function modal({ title, body, footer, wide = false, onClose }) {
  const mask = el('div', { class: 'mask' });
  const dlg = el('div', { class: 'dlg' + (wide ? ' wide' : '') });
  dlg.innerHTML = `<div class="dlg-h"><h3>${esc(title)}</h3>`
    + `<div class="btn-ico" data-x>${I('x', 16)}</div></div>`
    + `<div class="dlg-b">${typeof body === 'string' ? body : ''}</div>`
    + (footer ? `<div class="dlg-f">${footer}</div>` : '');
  if (typeof body !== 'string') dlg.querySelector('.dlg-b').appendChild(body);
  mask.appendChild(dlg);
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  dlg.querySelector('[data-x]').addEventListener('click', close);
  document.body.appendChild(mask);
  const first = dlg.querySelector('input,select,textarea'); if (first) setTimeout(() => first.focus(), 60);
  return { el: dlg, body: dlg.querySelector('.dlg-b'), close };
}

export function confirmDlg(title, msg, okText = '确定') {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p class="dim">${msg}</p>`,
      footer: `<button class="btn" data-no>取消</button><button class="btn pri" data-yes>${esc(okText)}</button>`,
    });
    m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-yes]').onclick = () => { m.close(); resolve(true); };
  });
}

/* ============================ 复制 / 骨架 / 空态 ============================ */
export async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch (e) {
    // http 下 clipboard 可能不可用，退回 execCommand
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(label); } catch (_) { toast('复制失败，请手动选中', 'bad'); }
    ta.remove();
  }
}

/** 让所有 [data-copy] 元素可点复制（事件委托，动态插入的也管用） */
export function bindCopy(root = document) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-copy]');
    if (!t) return;
    e.preventDefault();
    copy(t.getAttribute('data-copy'));
  });
}

export const skel = (h = 16, w = '100%') => `<div class="skel" style="height:${h}px;width:${w}"></div>`;
export const empty = (text, sub = '', icon = 'layers') =>
  `<div class="empty">${I(icon, 40)}<b>${esc(text)}</b>${sub ? `<span class="small">${esc(sub)}</span>` : ''}</div>`;

/* ============================ 主题（明暗） ============================ */
// 界面以浅色为主；这里只保留一个「链浏览器深色」的开关位，默认跟随浅色
export function themeMode() { return localStorage.getItem('cj-theme') || 'light'; }
export function setTheme(m) {
  localStorage.setItem('cj-theme', m);
  document.documentElement.setAttribute('data-theme', m);
}

/* ============================ 哈希着色 ============================ */
/** 用哈希本身算一个稳定的色相，同一笔交易每次看到颜色都一样 */
export function hashHue(h) {
  if (!h) return 220;
  return parseInt(String(h).slice(0, 6), 16) % 360;
}
