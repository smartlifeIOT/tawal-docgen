const BASE = '/api';

/** Bearer token for every request, set by the auth provider. */
let token: string | null = null;
export const setAuthToken = (value: string | null) => {
  token = value;
};

const authHeaders = (): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

/** A 401 anywhere means the session is gone; drop it and bounce to login
 *  rather than letting every page render its own error. */
function handleUnauthorized(res: Response) {
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    localStorage.removeItem('docgen.token.v1');
    token = null;
    location.assign('/login');
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    handleUnauthorized(res);
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join(', ') : body.message || message;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  get: <T>(path: string) =>
    fetch(`${BASE}${path}`, { headers: authHeaders() }).then((r) => handle<T>(r)),

  send: <T>(path: string, method: string, body?: unknown) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),

  upload: <T>(path: string, file: File, fields: Record<string, string | number | boolean> = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) if (v !== '' && v != null) fd.append(k, String(v));
    return fetch(`${BASE}${path}`, { method: 'POST', body: fd, headers: authHeaders() })
      .then((r) => handle<T>(r));
  },

  /**
   * Multipart with more than one file, or with a pre-built FormData.
   *
   * Exists because hand-rolling `fetch` for these forgets the bearer token —
   * which is exactly how /gcl/scope/create started returning 401.
   */
  /** Several files under one field name, plus scalar fields. */
  uploadMany: <T>(path: string, files: File[], fields: Record<string, string> = {}) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    return fetch(`${BASE}${path}`, { method: 'POST', body: fd, headers: authHeaders() })
      .then((r) => handle<T>(r));
  },

  uploadForm: <T>(path: string, form: FormData) =>
    fetch(`${BASE}${path}`, { method: 'POST', body: form, headers: authHeaders() })
      .then((r) => handle<T>(r)),

  /** Downloads go through fetch too, since <a href> can't carry the bearer token. */
  download: async (path: string, fallbackName = 'download') => {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (!res.ok) {
      handleUnauthorized(res);
      // A failed download still answers with a JSON problem body; show what it
      // says ("regenerate them") rather than a bare status code.
      let message = `Download failed (${res.status})`;
      try {
        const body = await res.json();
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message || message;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="([^"]+)"/i.exec(disposition);
    const name = utf8 ? decodeURIComponent(utf8[1]) : plain ? plain[1] : fallbackName;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    // Bulk archives report what they hold; single-file downloads omit these.
    const count = (header: string) => {
      const v = res.headers.get(header);
      return v === null ? undefined : Number(v);
    };
    return {
      fileName: name,
      included: count('X-Documents-Included'),
      skipped: count('X-Documents-Skipped'),
    };
  },

  /** Opens a PDF in a new tab, again via blob so the token isn't in the URL. */
  openInline: async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (!res.ok) {
      handleUnauthorized(res);
      throw new Error(`Preview failed (${res.status})`);
    }
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  // No fileUrl helper on purpose: an <a href> cannot carry the bearer token, so
  // every such link 401s. Use download() or openInline() instead — they fetch
  // with the header and hand back a blob.
};

export const money = (v: string | number | null | undefined, currency = 'SAR') =>
  `${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export const shortDate = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
};

/** <input type="date"> wants yyyy-mm-dd in local terms; our dates are UTC midnight. */
export const dateInput = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '');
