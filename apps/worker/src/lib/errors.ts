/** Typed application error with a stable machine-readable code. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const errors = {
  validation: (message = 'The provided data is invalid.', details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, 400, details),
  unauthorized: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message, 401),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError('FORBIDDEN', message, 403),
  notFound: (message = 'Resource not found.') => new AppError('NOT_FOUND', message, 404),
  conflict: (code: string, message: string) => new AppError(code, message, 409),
  rateLimited: (message = 'Too many requests. Please slow down.') =>
    new AppError('RATE_LIMITED', message, 429),
  invalidTransition: (from: string, to: string) =>
    new AppError(
      'INVALID_STATUS_TRANSITION',
      `Cannot move from ${from} to ${to}.`,
      409,
      { from, to },
    ),
  internal: (message = 'Something went wrong. Please try again.') =>
    new AppError('INTERNAL_ERROR', message, 500),
  unavailable: (code: string, message: string, status = 503) =>
    new AppError(code, message, status),
};

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
