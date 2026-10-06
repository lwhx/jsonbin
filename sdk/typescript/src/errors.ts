export class JsonBinError extends Error {
  statusCode: number;
  data: unknown;

  constructor(message: string, statusCode: number, data?: unknown) {
    super(message);
    this.name = "JsonBinError";
    this.statusCode = statusCode;
    this.data = data;
  }
}

export class AuthenticationError extends JsonBinError {
  constructor(message = "Unauthorized", data?: unknown) {
    super(message, 401, data);
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends JsonBinError {
  constructor(message = "Permission Denied", data?: unknown) {
    super(message, 403, data);
    this.name = "PermissionDeniedError";
  }
}

export class NotFoundError extends JsonBinError {
  constructor(message = "Resource Not Found", data?: unknown) {
    super(message, 404, data);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends JsonBinError {
  constructor(message = "Conflict", data?: unknown) {
    super(message, 409, data);
    this.name = "ConflictError";
  }
}

export class EtagConflictError extends ConflictError {
  constructor(message = "ETag Conflict", data?: unknown) {
    super(message, data);
    this.statusCode = 412;
    this.name = "EtagConflictError";
  }
}

export class ValidationError extends JsonBinError {
  constructor(message = "Validation Error", data?: unknown) {
    super(message, 422, data);
    this.name = "ValidationError";
  }
}

export class LockedError extends JsonBinError {
  constructor(message = "Resource Locked", data?: unknown) {
    super(message, 423, data);
    this.name = "LockedError";
  }
}

export class PreconditionRequiredError extends JsonBinError {
  constructor(message = "Precondition (If-Match) Required", data?: unknown) {
    super(message, 428, data);
    this.name = "PreconditionRequiredError";
  }
}

export class RateLimitError extends JsonBinError {
  retryAfter: number;

  constructor(message = "Rate Limit Exceeded", retryAfter = 60, data?: unknown) {
    super(message, 429, data);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class ServerError extends JsonBinError {
  constructor(message = "Internal Server Error", statusCode = 500, data?: unknown) {
    super(message, statusCode, data);
    this.name = "ServerError";
  }
}

export function mapHttpError(status: number, body: any, headers?: Headers): JsonBinError {
  const message = body?.error || body?.message || `HTTP ${status}`;
  switch (status) {
    case 401:
      return new AuthenticationError(message, body);
    case 403:
      return new PermissionDeniedError(message, body);
    case 404:
      return new NotFoundError(message, body);
    case 409:
      return new ConflictError(message, body);
    case 412:
      return new EtagConflictError(message, body);
    case 422:
      return new ValidationError(message, body);
    case 423:
      return new LockedError(message, body);
    case 428:
      return new PreconditionRequiredError(message, body);
    case 429: {
      const retryAfter = Number(headers?.get("Retry-After") || 60);
      return new RateLimitError(message, retryAfter, body);
    }
    default:
      if (status >= 500) return new ServerError(message, status, body);
      return new JsonBinError(message, status, body);
  }
}
