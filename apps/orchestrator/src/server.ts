import type { FastifyInstance } from "fastify";
import {
  AppErrorCode,
  ModelRouter,
  createAgentCard,
  createAgentServer,
  createPlanParamsSchema,
  createPlanRepository,
  internalError,
  loadRegistry,
  parseParams,
  taskIdParamsSchema,
  type PlanEvent,
  type PlanState,
} from "@travel/shared";
import { EventHub } from "./events";
import { createWorkflow } from "./workflow";

const VERSION = "0.1.0";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// JSON-RPC-ish code for a missing plan on the SSE route
const RpcCode404 = -32004;

export async function buildOrchestratorServer(
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const repo = createPlanRepository();
  const registry = loadRegistry();
  const router = new ModelRouter();
  const hub = new EventHub();
  const workflow = createWorkflow({ repo, registry, router, hub });

  function writeEvent(reply: { raw: { write: (chunk: string) => unknown } }, event: PlanEvent): void {
    reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const card = createAgentCard({
    name: "orchestrator",
    description:
      "Coordinates travel plans: parses intent, holds plan state, delegates sections to specialist agents, consolidates results, and formats the final itinerary.",
    version: VERSION,
    baseUrl: `http://localhost:${process.env.ORCHESTRATOR_PORT ?? 8000}`,
    skills: [
      {
        id: "parse-intent",
        name: "Intent Parser",
        description: "Extracts destination, dates, travelers, and interests from a request.",
        tags: ["intent", "parse"],
        examples: ["Plan five days in Paris from 2026-10-05 to 2026-10-09"],
      },
      {
        id: "coordinate-plan",
        name: "Plan Coordinator",
        description: "Holds plan state and delegates sections to registry agents.",
        tags: ["orchestration", "state"],
        examples: ["Create and track a travel plan"],
      },
      {
        id: "format-itinerary",
        name: "Itinerary Synthesis",
        description: "Consolidates section results into a formatted day-by-day itinerary.",
        tags: ["synthesis", "itinerary"],
        examples: ["Produce the final itinerary"],
      },
    ],
  });

  return createAgentServer({
    card,
    logger: opts.logger ?? true,
    handlers: {
      // create a plan (called by the web BFF)
      "message/send": async (raw) => {
        const params = parseParams(createPlanParamsSchema, raw);
        const planId = crypto.randomUUID();
        const now = new Date().toISOString();
        const plan: PlanState = {
          planId,
          status: "created",
          input: params.input,
          sections: {},
          errors: [],
          modelRuns: [],
          createdAt: now,
          updatedAt: now,
        };
        await repo.create(plan);
        const created = await repo.appendEvent({
          planId,
          type: "plan.created",
          data: { taskId: planId, status: "created" },
          ts: now,
        });
        hub.publish(created);
        workflow.start(planId);
        return { taskId: planId, status: "created" };
      },

      "tasks/cancel": async (raw) => {
        const { taskId } = parseParams(taskIdParamsSchema, raw);
        const cancelled = await workflow.cancel(taskId);
        if (!cancelled) {
          const plan = await repo.get(taskId);
          if (!plan) {
            throw internalError(AppErrorCode.PlanNotFound, `Plan not found: ${taskId}`, false);
          }
        }
        return { taskId, cancelled };
      },

      "orchestrator/plan:get": async (raw) => {
        const { taskId } = parseParams(taskIdParamsSchema, raw);
        const plan = await repo.get(taskId);
        if (!plan) {
          throw internalError(AppErrorCode.PlanNotFound, `Plan not found: ${taskId}`, false);
        }
        return { plan };
      },
    },

    // SSE stream for the web BFF (§13 event catalog)
    extraRoutes: (instance) => {
      instance.get("/plans/:id/events", async (req, reply) => {
        const { id } = req.params as { id: string };
        const plan = await repo.get(id);
        if (!plan) {
          return reply.code(404).send({
            jsonrpc: "2.0",
            id: null,
            error: { code: RpcCode404, message: "PLAN_NOT_FOUND" },
          });
        }

        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const query = req.query as { since?: string };
        const since =
          Number.parseInt(String(req.headers["last-event-id"] ?? query.since ?? "0"), 10) || 0;

        let maxWritten = 0;
        const write = (event: PlanEvent): void => {
          if (event.id <= maxWritten) return;
          maxWritten = event.id;
          writeEvent(reply, event);
        };

        // subscribe first, then replay, to avoid a gap
        const buffer: PlanEvent[] = [];
        let live = false;
        const unsubscribe = hub.subscribe(id, (event) => {
          if (live) write(event);
          else buffer.push(event);
        });

        try {
          for (const event of await repo.listEvents(id, since)) write(event);
          live = true;
          for (const event of buffer) write(event);

          const heartbeat = setInterval(() => {
            reply.raw.write(": ping\n\n");
          }, 15_000);

          req.raw.on("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
            reply.raw.end();
          });

          const current = (await repo.get(id))!;
          if (TERMINAL.has(current.status)) {
            write({
              id: maxWritten + 1,
              planId: id,
              type: "plan.status",
              data: { status: current.status, terminal: true },
              ts: new Date().toISOString(),
            });
          }
        } catch {
          unsubscribe();
          reply.raw.end();
        }
      });
    },
  });
}
