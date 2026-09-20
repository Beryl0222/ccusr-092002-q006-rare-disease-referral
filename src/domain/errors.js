// 业务错误与 HTTP 状态映射。
export class AppError extends Error {
  constructor(message, { status = 400, code = "bad_request" } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 422, code: "validation_failed" });
    this.details = details;
  }
}

export class MaterialIncompleteError extends AppError {
  constructor(missing, message = "转诊必要材料不完整") {
    super(message, { status: 422, code: "material_incomplete" });
    this.details = { missing_materials: missing };
  }
}

export class NotFoundError extends AppError {
  constructor(message = "资源不存在") {
    super(message, { status: 404, code: "not_found" });
  }
}

export class ConflictError extends AppError {
  constructor(message = "状态冲突，资源已被其他操作更新") {
    super(message, { status: 409, code: "conflict" });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "无权访问该资源") {
    super(message, { status: 403, code: "forbidden" });
  }
}

export class ConsentError extends AppError {
  constructor(message, reason) {
    super(message, { status: 403, code: "consent_required" });
    this.details = { reason };
  }
}
