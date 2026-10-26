import {
  AppErrorCode,
  budgetSectionSchema,
  createAgentCard,
  createAgentServer,
  internalError,
  parseParams,
  resolveDuration,
  sectionCallParamsSchema,
  type BudgetSection,
  type SectionCallParams,
  type SectionEnvelope,
} from "@travel/shared";
import type { FastifyInstance } from "fastify";
import { estimateCost } from "./catalog";
import { openCatalog, type CatalogHandle } from "./db";

const VERSION = "0.1.0";

/**
 * Deterministic cost estimate (§17.4). No model call: the inputs come from the
 * query-parsing output (`sharedContext`) plus the original request (`input`), and the
 * answer is arithmetic over the cost catalog.
 */
function budgetHandler(catalog: CatalogHandle) {
  return async (raw: unknown): Promise<{ sectionResult: SectionEnvelope }> => {
    const params = parseParams(sectionCallParamsSchema, raw) as SectionCallParams;
    const destination = params.sharedContext.destination;
    if (!destination) {
      throw internalError(
        AppErrorCode.InvalidParams,
        "budget agent requires sharedContext.destination",
        false,
      );
    }

    // Trip length from the same shared implementation the orchestrator's day grid
    // uses (§17.1) — parsed dates, then the original request's dates, then a
    // duration stated in the query, then 3 with a disclaimer.
    const { days, source } = resolveDuration(params.input ?? {}, params.sharedContext);
    const nights = Math.max(0, days - 1);
    const travelers = params.sharedContext.travelers ?? params.input?.travelerCount ?? 1;

    const { location, matched, profile } = catalog.lookup(destination);
    const { usd, local } = estimateCost(profile, days, nights, travelers);

    const disclaimers: string[] = [];
    if (!matched) {
      disclaimers.push(
        `No cost profile for "${destination}" in the catalog; using the default profile.`,
      );
    }
    if (source === "default") {
      disclaimers.push(
        `No travel dates or stated duration were provided; pricing a ${days}-day trip.`,
      );
    }
    disclaimers.push(
      `Cost figures are catalog estimates (${profile.currency}, ${profile.fx} local units per 1 USD), ` +
        "not quotes; actual prices vary by season and area.",
    );

    const data = budgetSectionSchema.parse({
      location,
      matched,
      days,
      nights,
      travelers,
      currency: profile.currency,
      fx: profile.fx,
      rates: {
        hotel: profile.hotel,
        food: profile.food,
        transport: profile.transport,
        activities: profile.activities,
      },
      usd,
      local,
      disclaimers,
    } satisfies BudgetSection);

    return {
      sectionResult: { key: params.section ?? "budget", status: "completed", data },
    };
  };
}

export async function buildBudgetServer(
  opts: { logger?: boolean; dbPath?: string } = {},
): Promise<FastifyInstance> {
  const port = Number(process.env.AGENT_BUDGET_PORT ?? 8003);

  // Never throws: an unusable catalog means a degraded /health and a failed section,
  // not a dead process (which `concurrently -k` would propagate to the whole stack).
  const catalog = openCatalog(opts.dbPath);
  if (!catalog.usable) console.error(`[agent-budget] cost catalog unusable: ${catalog.error}`);

  const card = createAgentCard({
    name: "budget",
    description:
      "Estimates per-day and whole-trip costs from the built-in cost catalog, in USD and the destination's local currency.",
    version: VERSION,
    baseUrl: `http://localhost:${port}`,
    skills: [
      {
        id: "budget-estimate",
        name: "Budget Estimate",
        description: "Per-day and whole-trip cost in USD and local currency, with the assumptions used.",
        tags: ["budget", "cost", "pricing", "estimate"],
        examples: ["Estimate the cost of five days in Paris for two travelers"],
      },
    ],
  });

  const app = await createAgentServer({
    card,
    handlers: { "message/send": budgetHandler(catalog) },
    logger: opts.logger ?? true,
    health: () => ({ status: catalog.usable ? "ok" : "degraded" }),
  });
  app.addHook("onClose", async () => catalog.close());
  return app;
}
