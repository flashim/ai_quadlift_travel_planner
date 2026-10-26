import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError, z, type ZodTypeAny } from "zod";
import { agentCardSchema, type AgentCard } from "../schemas/agent-card";
import { rpcRequestSchema, type RpcResponse } from "../schemas/rpc";
import { RpcError, RpcCode, AppErrorCode, invalidParams, methodNotFound } from "./errors";

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export interface AgentServerOptions {
  card: AgentCard;
  handlers: Record<string, RpcHandler>;
  logger?: boolean;
  corsOrigin?: boolean | string[];
  /** Optional extra routes (e.g. orchestrator SSE). */
  extraRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /**
   * Optional health override. §9 allows `/health` to report `"degraded"`; the default
   * is the historical hardcoded `"ok"`, so agents that do not pass this are unchanged.
   * Used by the budget agent when its cost catalog is unreadable (§17.4) — it stays up
   * and degrades instead of exiting, because `concurrently -k` would take the stack down.
   */
  health?: () => { status: "ok" | "degraded" };
}

export const CARD_CONTENT_TYPE = "application/a2a+json";

export async function createAgentServer(opts: AgentServerOptions): Promise<FastifyInstance> {
  const card = agentCardSchema.parse(opts.card);
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(cors, {
    origin: opts.corsOrigin ?? true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  const cardHandler = async (_req: unknown, reply: { header: (k: string, v: string) => { send: (b: unknown) => unknown } }) =>
    reply.header("content-type", CARD_CONTENT_TYPE).send(card);

  app.get("/.well-known/agent.json", cardHandler);
  app.get("/.well-known/agent-card.json", cardHandler);

  app.get("/health", async () => ({
    status: opts.health ? opts.health().status : ("ok" as const),
    version: card.version,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.post("/", async (req, reply) => {
    const id = extractId(req.body);
    const parsed = rpcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.send(rpcError(id, RpcCode.InvalidRequest, "Invalid JSON-RPC request"));
    }
    const { method, params } = parsed.data;
    const handler = opts.handlers[method];
    if (!handler) {
      const err = methodNotFound(method);
      return reply.send(rpcError(id, err.rpcCode, err.message, err.data));
    }
    try {
      const result = await handler(params);
      return reply.send({ jsonrpc: "2.0", id: id ?? null, result });
    } catch (err) {
      if (err instanceof RpcError) {
        return reply.send(rpcError(id, err.rpcCode, err.message, err.data));
      }
      if (err instanceof ZodError) {
        return reply.send(
          rpcError(id, RpcCode.InvalidParams, "Invalid params", {
            code: AppErrorCode.InvalidParams,
            retryable: false,
            issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          }),
        );
      }
      req.log.error({ err }, "unhandled rpc error");
      return reply.send(
        rpcError(id, RpcCode.InternalError, "Internal error", {
          code: AppErrorCode.Internal,
          retryable: true,
        }),
      );
    }
  });

  if (opts.extraRoutes) await opts.extraRoutes(app);
  return app;
}

function extractId(body: unknown): string | number | null {
  if (body && typeof body === "object" && "id" in body) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

/** Helper: validate params against a Zod schema, mapping failures to RpcError. */
export function parseParams<S extends ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw invalidParams(
      "Invalid params",
      { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
    );
  }
  return result.data;
}
