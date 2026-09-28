import type { ApiResponse } from '@rr/types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  const url = path.startsWith('/') ? path : `/api/${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

/** Thin client for the Motoro API (same-origin via Next.js rewrite). */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, headers } = options;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the Motoro API.', 0, { message: String(err) });
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new ApiError('BAD_RESPONSE', `Unexpected response (HTTP ${response.status}).`, response.status);
  }
  if (!payload.success) {
    throw new ApiError(
      payload.error?.code ?? 'UNKNOWN_ERROR',
      payload.error?.message ?? 'Request failed.',
      response.status,
      payload.error?.details,
      payload.requestId,
    );
  }
  return payload.data;
}

export const apiGet = <T,>(path: string, options?: Omit<ApiOptions, 'method' | 'body'>) =>
  api<T>(path, { ...options, method: 'GET' });

export const apiPost = <T,>(path: string, body?: unknown, options?: Omit<ApiOptions, 'method' | 'body'>) =>
  api<T>(path, { ...options, method: 'POST', body });

export const apiPatch = <T,>(path: string, body?: unknown, options?: Omit<ApiOptions, 'method' | 'body'>) =>
  api<T>(path, { ...options, method: 'PATCH', body });

export const apiDelete = <T,>(path: string, options?: Omit<ApiOptions, 'method' | 'body'>) =>
  api<T>(path, { ...options, method: 'DELETE' });

/** Field-level validation details mapped to form keys. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const out: Record<string, string> = {};
    for (const item of error.details as { path?: string; message?: string }[]) {
      if (item?.path) out[item.path] = item.message ?? 'Invalid value';
    }
    return out;
  }
  return {};
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
