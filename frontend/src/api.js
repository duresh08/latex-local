// Thin client for the local LaTeX Lab server.

const tokenMeta = document.querySelector('meta[name="latexlab-token"]');
const TOKEN = tokenMeta ? tokenMeta.content : '';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function request(method, path, { query, json, body, raw } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
    url += `?${params}`;
  }
  const headers = { 'X-LatexLab-Token': TOKEN };
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (err) {
    throw new ApiError('Lost connection to LaTeX Lab. Is the LaTeX Lab window (the black console) still running?', 0);
  }
  if (raw) {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error || res.statusText, res.status, data);
    }
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || res.statusText || 'Request failed', res.status, data);
  return data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, json = {}, query) => request('POST', path, { json, query }),
  put: (path, json = {}) => request('PUT', path, { json }),
  upload: (path, query, body) => request('POST', path, { query, body }),
  raw: (path, query) => request('GET', path, { query, raw: true }),
};
