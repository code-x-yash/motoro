import type { ApiFailure, ApiSuccess } from '@rr/types';

export function ok<T>(data: T, requestId: string, status = 200, headers?: HeadersInit): Response {
  const body: ApiSuccess<T> = { success: true, data, error: null, requestId };
  return Response.json(body, { status, headers });
}

export function fail(
  code: string,
  message: string,
  requestId: string,
  status = 400,
  details?: unknown,
): Response {
  const body: ApiFailure = {
    success: false,
    data: null,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    requestId,
  };
  return Response.json(body, { status });
}

export function noContent(requestId: string): Response {
  return new Response(null, { status: 204, headers: { 'x-request-id': requestId } });
}
