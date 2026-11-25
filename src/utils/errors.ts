export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(
    message: string,
    options: { statusCode?: number; code?: string; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.retryable = options.retryable ?? false;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", retryable: false, cause });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, { statusCode: 401, code: "UNAUTHORIZED", retryable: false });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, { statusCode: 403, code: "FORBIDDEN", retryable: false });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, { statusCode: 409, code: "CONFLICT", retryable: false });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, { statusCode: 404, code: "NOT_FOUND", retryable: false });
  }
}

export class SmartFlowApiError extends AppError {
  constructor(message: string, statusCode: number, cause?: unknown) {
    const retryable = statusCode === 429 || statusCode >= 500;
    super(message, { statusCode, code: "SMARTFLOW_API_ERROR", retryable, cause });
  }
}

export class PermanentJobError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 422, code: "PERMANENT_JOB_ERROR", retryable: false, cause });
  }
}

export class TransientJobError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 503, code: "TRANSIENT_JOB_ERROR", retryable: true, cause });
  }
}

