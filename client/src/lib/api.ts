// Thin fetch wrapper. Cookies are HttpOnly and same-site, so the client never
// sees the session token.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the server says our session is gone. */
export const sessionEvents = new EventTarget();

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body instanceof Blob ? { 'Content-Type': body.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', 'You appear to be offline.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) sessionEvents.dispatchEvent(new Event('expired'));
    throw new ApiError(res.status, data.error || 'error', data.message || 'Something went wrong.', data);
  }
  return data as T;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
