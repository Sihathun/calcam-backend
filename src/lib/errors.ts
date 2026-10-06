export interface ErrorDetail {
  path: string;
  issue: string;
}

/** An error that is safe to show to the client. Everything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: ErrorDetail[]) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') =>
  new AppError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Not allowed') =>
  new AppError(403, code, message);
export const notFound = (code = 'NOT_FOUND', message = 'Resource not found') =>
  new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string, details?: ErrorDetail[]) =>
  new AppError(422, code, message, details);

/** Raised by the analyzer or queue when a retry could succeed (network, 429, 5xx). */
export class TransientError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientError';
  }
}
