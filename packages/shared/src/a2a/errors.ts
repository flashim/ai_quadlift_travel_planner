export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const AppErrorCode = {
  AgentUnreachable: "AGENT_UNREACHABLE",
  AgentTimeout: "AGENT_TIMEOUT",
  InvalidParams: "INVALID_PARAMS",
  SectionFailed: "SECTION_FAILED",
  ModelUnavailable: "MODEL_UNAVAILABLE",
  ModelOutputInvalid: "MODEL_OUTPUT_INVALID",
  UpstreamRateLimited: "UPSTREAM_RATE_LIMITED",
  UpstreamInvalidResponse: "UPSTREAM_INVALID_RESPONSE",
  PlanNotFound: "PLAN_NOT_FOUND",
  PlanCancelled: "PLAN_CANCELLED",
  Internal: "INTERNAL",
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

export class RpcError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RpcError";
  }

  get appCode(): AppErrorCode | undefined {
    return this.data?.code as AppErrorCode | undefined;
  }

  get retryable(): boolean {
    return this.data?.retryable === true;
  }
}

export function invalidParams(message: string, details?: Record<string, unknown>): RpcError {
  return new RpcError(RpcCode.InvalidParams, message, {
    code: AppErrorCode.InvalidParams,
    retryable: false,
    ...details,
  });
}

export function methodNotFound(method: string): RpcError {
  return new RpcError(RpcCode.MethodNotFound, `Method not found: ${method}`, {
    code: AppErrorCode.InvalidParams,
    retryable: false,
  });
}

export function internalError(
  code: AppErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): RpcError {
  return new RpcError(RpcCode.InternalError, message, { code, retryable, ...details });
}

export function isAppError(code: string): code is AppErrorCode {
  return Object.values(AppErrorCode).includes(code as AppErrorCode);
}
