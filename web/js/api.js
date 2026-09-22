// Thin fetch wrapper: JSON in/out, errors carry a readable message.
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    let msg = r.statusText;
    if (data && typeof data.detail === 'string') msg = data.detail;
    else if (data && Array.isArray(data.detail)) msg = data.detail.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('; ');
    throw new Error(msg);
  }
  return data;
}
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
};
