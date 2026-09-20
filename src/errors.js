export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.details = details;
  }
}

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

export class AuthorizationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = 403;
    this.details = details;
  }
}
