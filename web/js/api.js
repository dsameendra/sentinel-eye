// Thin fetch wrapper: JSON in/out, errors carry a readable message.

/** The session ended or never existed (401 / WebSocket 4401): go to the sign-in page, then come back here. */
let leaving = false;
export function signInAgain() {
  if (leaving) return;
  leaving = true;
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}

/** Set by main.js: an admin who must set up two-factor first (403 code 2fa_required). */
export const authHooks = { needs2fa: () => {} };

async function handle(r) {
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    if (r.status === 401 && data?.code === 'auth_required') signInAgain();
    if (r.status === 403 && data?.code === '2fa_required') authHooks.needs2fa();
    let msg = r.statusText;
    if (data && typeof data.detail === 'string') msg = data.detail;
    else if (data && Array.isArray(data.detail)) msg = data.detail.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('; ');
    const err = new Error(msg);
    err.status = r.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return handle(r);
}

/** GET a JSON URL with the same sign-in/error handling as `api` — for call sites that build their own URLs. */
export const getJSON = (url) => call('GET', url);

export const api = {
  settings: () => call('GET', '/api/settings'),
  saveSettings: (s) => call('PUT', '/api/settings', s),
  saveDisplay: (d) => call('PUT', '/api/display', d),
  test: (connection, channel, kind, path = '') => call('POST', '/api/test', { connection, channel, kind, path }),
  discover: (connection) => call('POST', '/api/discover', { connection }),
  status: () => call('GET', '/api/status'),
  createBookmark: (b) => call('POST', '/api/bookmarks', b),
  deleteBookmark: (id) => call('DELETE', `/api/bookmarks/${id}`),
  createExport: (b) => call('POST', '/api/export', b),
  exportStatus: (jobId) => call('GET', `/api/export/${jobId}`),
  createEnhance: (b) => call('POST', '/api/enhance', b),
  enhanceStatus: (jobId) => call('GET', `/api/enhance/${jobId}`),
  enhanceOcr: (jobId, which) => call('POST', `/api/enhance/${jobId}/ocr`, { which }),
};

// Sign-in (app/auth_api.py). Kept apart from `api` above so the login page can import it without the rest.
export const authApi = {
  me: () => call('GET', '/api/auth/me'),
  login: (username, password, remember) => call('POST', '/api/auth/login', { username, password, remember }),
  loginTotp: (challenge, code) => call('POST', '/api/auth/login/totp', { challenge, code }),
  logout: () => call('POST', '/api/auth/logout'),
  changePassword: (current, next) => call('POST', '/api/auth/password', { current, new: next }),
  totpBegin: () => call('POST', '/api/auth/totp/begin'),
  totpConfirm: (code) => call('POST', '/api/auth/totp/confirm', { code }),
  totpDisable: (password) => call('POST', '/api/auth/totp/disable', { password }),
  totpRecovery: (password) => call('POST', '/api/auth/totp/recovery', { password }),
  sessions: () => call('GET', '/api/auth/sessions'),
  revokeSession: (id) => call('DELETE', `/api/auth/sessions/${id}`),
  revokeOtherSessions: () => call('POST', '/api/auth/sessions/revoke-others'),
  pairStart: () => call('POST', '/api/auth/pair/start'),
  pairPoll: (deviceCode) => call('POST', '/api/auth/pair/poll', { device_code: deviceCode }),
  pairApprove: (code, role, label) => call('POST', '/api/auth/pair/approve', { code, role, label }),
  users: () => call('GET', '/api/auth/admin/users'),
  createUser: (username, password, role) => call('POST', '/api/auth/admin/users', { username, password, role }),
  updateUser: (id, patch) => call('PATCH', `/api/auth/admin/users/${id}`, patch),
  deleteUser: (id) => call('DELETE', `/api/auth/admin/users/${id}`),
  setUserPassword: (id, password) => call('POST', `/api/auth/admin/users/${id}/password`, { password }),
  resetUser2fa: (id) => call('POST', `/api/auth/admin/users/${id}/reset-2fa`),
  revokeUserSessions: (id) => call('POST', `/api/auth/admin/users/${id}/revoke-sessions`),
  devices: () => call('GET', '/api/auth/admin/devices'),
  updateDevice: (id, patch) => call('PATCH', `/api/auth/admin/devices/${id}`, patch),
  deleteDevice: (id) => call('DELETE', `/api/auth/admin/devices/${id}`),
  allSessions: () => call('GET', '/api/auth/admin/sessions'),
  revokeAnySession: (id) => call('DELETE', `/api/auth/admin/sessions/${id}`),
  config: () => call('GET', '/api/auth/admin/config'),
  saveConfig: (patch) => call('PUT', '/api/auth/admin/config', patch),
  audit: (limit = 200) => call('GET', `/api/auth/admin/audit?limit=${limit}`),
};
