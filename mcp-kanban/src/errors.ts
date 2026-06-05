export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'IDENTITY_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PLANE_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class McpError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly traceId: string | undefined;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    httpStatus?: number;
    traceId?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'McpError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus ?? defaultHttpStatusFor(opts.code);
    this.traceId = opts.traceId;
  }

  toJSON(): { error: { code: ErrorCode; message: string; trace_id?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.traceId !== undefined ? { trace_id: this.traceId } : {}),
      },
    };
  }
}

function defaultHttpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'IDENTITY_REQUIRED':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'PLANE_UNAVAILABLE':
      return 502;
    case 'STORAGE_UNAVAILABLE':
      return 502;
    case 'INTERNAL':
      return 500;
  }
}

export class PlaneError extends McpError {
  readonly planeStatus: number | undefined;
  constructor(opts: {
    message: string;
    planeStatus?: number;
    traceId?: string;
    cause?: unknown;
  }) {
    super({
      code:
        opts.planeStatus === 404
          ? 'NOT_FOUND'
          : opts.planeStatus === 429
            ? 'RATE_LIMITED'
            : 'PLANE_UNAVAILABLE',
      message: opts.message,
      ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = 'PlaneError';
    this.planeStatus = opts.planeStatus;
  }
}
