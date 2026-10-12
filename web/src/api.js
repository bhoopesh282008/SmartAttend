const TOKEN_KEY = 'smartattend.token';

// Browser storage can be blocked (private windows, site settings), so every use is guarded.
export const login = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* the session then lasts until the page is closed */
      memoryToken = token;
    }
  },
  clear() {
    memoryToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};
let memoryToken = null;
const currentToken = () => login.get() ?? memoryToken;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send(path, { method = 'GET', body, signal } = {}) {
  const token = currentToken();
  try {
    return await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check the connection and try again.');
  }
}

async function failure(res) {
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    login.clear();
    window.dispatchEvent(new Event('smartattend:signed-out'));
  }
  return new ApiError(
    res.status,
    data?.error?.code ?? 'error',
    data?.error?.message ?? `The request failed (${res.status}).`,
    data?.error?.details,
  );
}

export async function api(path, options) {
  const res = await send(path, options);
  if (!res.ok) throw await failure(res);
  return res.json();
}

// CSV files are fetched with the sign-in header, then handed to the browser as a download.
export async function downloadCsv(path, fallbackName = 'attendance.csv') {
  const res = await send(path);
  if (!res.ok) throw await failure(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
