/* =====================================================================================
   接口封装。前端拿到的每一条数据都来自后端，页面里没有任何硬编码的假数据。
   ===================================================================================== */
const BASE = '';

async function req(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + url, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  if (!r.ok || (data && data.ok === false)) {
    const msg = (data && data.msg) || `请求失败（HTTP ${r.status}）`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

export const API = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b === undefined ? {} : b),
};

/* ---------- 用户端 ---------- */
export const me = () => API.get('/api/me');
export const login = (u, p) => API.post('/api/auth/login', { username: u, password: p });
export const register = (o) => API.post('/api/auth/register', o);
export const logout = () => API.post('/api/auth/logout');
export const today = (day) => API.get('/api/today' + (day ? '?day=' + day : ''));
export const checkin = (device) => API.post('/api/checkin', { device });
export const checkins = (days) => API.get('/api/checkins?days=' + (days || 42));
export const heatmap = (days) => API.get('/api/heatmap?days=' + (days || 84));
export const tasks = (q) => API.get('/api/tasks?' + new URLSearchParams(q || {}));
export const addTask = (o) => API.post('/api/tasks', o);
export const doneTask = (id) => API.post(`/api/tasks/${id}/done`);
export const undoTask = (id) => API.post(`/api/tasks/${id}/undo`);
export const skipTask = (id) => API.post(`/api/tasks/${id}/skip`);
export const delTask = (id) => API.post(`/api/tasks/${id}/delete`);
export const templates = () => API.get('/api/templates');
export const addTpl = (o) => API.post('/api/templates', o);
export const toggleTpl = (id) => API.post(`/api/templates/${id}/toggle`);
export const delTpl = (id) => API.post(`/api/templates/${id}/delete`);
export const ledger = (q) => API.get('/api/ledger?' + new URLSearchParams(q || {}));
export const reconcile = () => API.get('/api/reconcile');
export const badges = () => API.get('/api/badges');
export const claimBadge = (id) => API.post(`/api/badges/${id}/claim`);
export const claims = () => API.get('/api/claims');
export const rewards = (cat) => API.get('/api/rewards' + (cat ? '?category=' + cat : ''));
export const redeem = (id, qty) => API.post(`/api/rewards/${id}/redeem`, { qty });
export const redemptions = () => API.get('/api/redemptions');
export const donations = () => API.get('/api/donations');
export const donate = (o) => API.post('/api/donations', o);
export const stakes = () => API.get('/api/stakes');
export const newStake = (o) => API.post('/api/stakes', o);
export const bumpStake = (id) => API.post(`/api/stakes/${id}/bump`);
export const settleStake = (id) => API.post(`/api/stakes/${id}/settle`);
export const teams = () => API.get('/api/teams');
export const team = (id) => API.get(`/api/teams/${id}`);
export const newTeam = (o) => API.post('/api/teams', o);
export const joinTeam = (code) => API.post('/api/teams/join', { code });
export const leaderboard = (type) => API.get('/api/leaderboard?type=' + (type || 'points'));
export const announcements = () => API.get('/api/announcements');
export const summary = () => API.get('/api/stats/summary');
export const pub = () => API.get('/api/public');
export const verify = (code) => API.get('/api/verify/' + encodeURIComponent(code));
export const verifySamples = () => API.get('/api/verify/samples');
export const verifyQr = (code) => '/api/verify/' + encodeURIComponent(code) + '/qr.svg';

/* ---------- 链浏览器 ---------- */
export const chainStats = () => API.get('/api/chain/stats');
export const chainBlocks = (p, size) => API.get(`/api/chain/blocks?page=${p || 1}&size=${size || 20}`);
export const chainBlock = (h) => API.get('/api/chain/block/' + h);
export const chainTxs = (q) => API.get('/api/chain/txs?' + new URLSearchParams(q || {}));
export const chainTx = (id) => API.get('/api/chain/tx/' + id);
export const chainPool = () => API.get('/api/chain/pool');
export const chainAddr = (a) => API.get('/api/chain/address/' + encodeURIComponent(a));
export const chainValidate = () => API.get('/api/chain/validate');
export const chainProof = (id) => API.get('/api/chain/proof/' + id);
export const chainDifficulty = () => API.get('/api/chain/difficulty');
export const tamperOptions = () => API.get('/api/chain/tamper/options');
export const tamper = (o) => API.post('/api/chain/tamper', o);
export const tamperRestore = () => API.post('/api/chain/tamper/restore');

/* ---------- 管理端 ---------- */
export const admOverview = () => API.get('/api/admin/overview');
export const admUsers = (q) => API.get('/api/admin/users?' + new URLSearchParams(q || {}));
export const admUser = (id) => API.get('/api/admin/users/' + id);
export const admUserStatus = (id, status) => API.post(`/api/admin/users/${id}/status`, { status });
export const admAdjust = (o) => API.post('/api/admin/adjust', o);
export const admRules = () => API.get('/api/admin/rules');
export const admSaveRule = (o) => API.post('/api/admin/rules', o);
export const admRewards = () => API.get('/api/admin/rewards');
export const admAddReward = (o) => API.post('/api/admin/rewards', o);
export const admUpdReward = (id, o) => API.post(`/api/admin/rewards/${id}/update`, o);
export const admRedemptions = (q) => API.get('/api/admin/redemptions?' + new URLSearchParams(q || {}));
export const admRedemptionStatus = (id, status) => API.post(`/api/admin/redemptions/${id}/status`, { status });
export const admRisk = (q) => API.get('/api/admin/risk?' + new URLSearchParams(q || {}));
export const admHandleRisk = (id, o) => API.post(`/api/admin/risk/${id}/handle`, o);
export const admRiskSweep = () => API.post('/api/admin/risk/sweep');
export const admChain = () => API.get('/api/admin/chain');
export const admMine = (maxTx) => API.post('/api/admin/chain/mine', { maxTx });
export const admDifficulty = (d) => API.post('/api/admin/chain/difficulty', { difficulty: d });
export const admReconcile = () => API.get('/api/admin/reconcile');
export const admAnnouncements = () => API.get('/api/admin/announcements');
export const admAddAnnounce = (o) => API.post('/api/admin/announcements', o);
export const admDelAnnounce = (id) => API.post(`/api/admin/announcements/${id}/delete`);
export const admAudit = (q) => API.get('/api/admin/audit?' + new URLSearchParams(q || {}));
export const admAnalytics = (days) => API.get('/api/admin/analytics?days=' + (days || 21));
