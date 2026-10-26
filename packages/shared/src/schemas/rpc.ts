import { z } from "zod";

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: RpcErrorObject;
}

export type RpcResponse = RpcSuccess | RpcFailure;

export function isRpcFailure(res: RpcResponse): res is RpcFailure {
  return "error" in res;
}
