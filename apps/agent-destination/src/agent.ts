import {
  AppErrorCode,
  ModelRouter,
  buildResearchRequest,
  createAgentCard,
  createAgentServer,
  internalError,
  parseParams,
  sectionCallParamsSchema,
  type ModelRun,
  type SectionCallParams,
  type SectionEnvelope,
  type Source,
  type ToolCall,
  type ToolDefinition,
} from "@travel/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { knowledgeChain, knowledgeProvider, knowledgeSourceNames } from "./knowledge/registry";
import type { KnowledgeArticle } from "./knowledge/types";

const VERSION = "0.1.0";
const USER_AGENT = `travel-planner-destination/${VERSION} (architectural skeleton)`;
/** Floor for a worthwhile distillation call — below it the raw extract is the answer (§17.2). */
const MIN_DISTILL_MS = 2_000;
/** Headroom kept for assembling the section response after the model returns. */
const RESPONSE_HEADROOM_MS = 1_500;
const WIKI_HOP_CAP_MS = 10_000;
/** Tool results feed a model prompt — cap what one extract may contribute. */
const TOOL_EXTRACT_CAP = 4_000;

const TOOLS_DEGRADED_WARNING =
  "The model backend does not support research tools — the brief is limited to the pre-fetched reference.";

const searchArgsSchema = z.object({
  query: z.string().min(1).max(300),
  source: z.string().max(60).optional(),
});

const extractArgsSchema = z.object({
  title: z.string().min(1).max(300),
  source: z.string().max(60).optional(),
});

export async function buildDestinationServer(
  opts: { logger?: boolean; router?: ModelRouter } = {},
): Promise<FastifyInstance> {
  const router = opts.router ?? new ModelRouter();
  // Startup config: an unknown KNOWLEDGE_PROVIDERS entry must fail fast (§17.2).
  const chain = knowledgeChain();

  async function destinationHandler(raw: unknown): Promise<{ sectionResult: SectionEnvelope }> {
    const params = parseParams(sectionCallParamsSchema, raw) as SectionCallParams;
    const key = params.section ?? "destination";
    const destination = params.sharedContext.destination;
    if (!destination) {
      throw internalError(
        AppErrorCode.InvalidParams,
        "destination agent requires sharedContext.destination",
        false,
      );
    }

    // Section budget (§6.1/§17.2): every hop below is sized from what is left of it.
    const startedAt = Date.now();
    const remainingMs = (): number | undefined =>
      params.deadlineMs === undefined
        ? undefined
        : Math.max(0, startedAt + params.deadlineMs - Date.now());
    /** What the distiller may spend: the rest of the budget minus response headroom. */
    const distillBudgetMs = (): number | undefined => {
      const left = remainingMs();
      return left === undefined ? undefined : left - RESPONSE_HEADROOM_MS;
    };
    const canDistill = (budget?: number): boolean =>
      budget === undefined || budget >= MIN_DISTILL_MS;
    /** One knowledge hop: at most half of what the section still has, capped (§17.2). */
    const hopBudgetMs = (): number => {
      const left = remainingMs();
      return left === undefined
        ? WIKI_HOP_CAP_MS
        : Math.max(1, Math.min(WIKI_HOP_CAP_MS, Math.floor(left / 2)));
    };
    /** Tool hops run inside the distiller — they may not eat its whole slice. */
    const toolHopMs = (): number => {
      const left = distillBudgetMs();
      return left === undefined
        ? WIKI_HOP_CAP_MS
        : Math.max(1, Math.min(WIKI_HOP_CAP_MS, left));
    };

    const warnings: string[] = [];
    const modelRuns: ModelRun[] = [];
    const override = params.model;
    const researchModel = router.describe("research", override);

    const sources: Source[] = [];
    const addSource = (article: KnowledgeArticle): void => {
      if (sources.some((s) => s.url === article.url)) return;
      sources.push({ title: article.title, url: article.url, retrievedAt: new Date().toISOString() });
    };

    /** Model-facing tools (§6.1) — validated + budgeted here, executed by the router loop. */
    const researchTools: ToolDefinition[] = [
      {
        name: "search_articles",
        description:
          "Search the knowledge sources (Wikivoyage, Wikipedia) for articles matching a query. " +
          "Returns matching titles with their URLs and a short snippet. Call this first when the " +
          "supplied extract does not cover what you need.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search terms, e.g. a city, district, or topic.",
            },
            source: {
              type: "string",
              enum: knowledgeSourceNames(),
              description: "Which source to search (optional; defaults to the first configured source).",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "fetch_extract",
        description:
          "Fetch the plain-text introduction of an article by its exact title (as returned by " +
          "search_articles). Use this to ground the brief in a specific article.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Exact article title, e.g. \"Paris\".",
            },
            source: {
              type: "string",
              enum: knowledgeSourceNames(),
              description: "Which source holds the article (optional; defaults to the first configured source).",
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
    ];

    /** Resolve the model's `source` argument — unknown names are reported back (§6.1). */
    const resolveSource = (name?: string): (typeof chain)[number] => {
      if (name === undefined) {
        const first = chain[0];
        if (!first) throw new Error("no knowledge source is configured");
        return first;
      }
      const provider = knowledgeProvider(name);
      if (!provider) {
        throw new Error(
          `unknown source "${name}" (available: ${knowledgeSourceNames().join(", ")})`,
        );
      }
      return provider;
    };

    const executeTool = async (call: ToolCall): Promise<string> => {
      if (call.name === "search_articles") {
        const args = searchArgsSchema.safeParse(call.arguments);
        if (!args.success) {
          throw new Error(
            `invalid arguments for search_articles: ${args.error.issues
              .map((i) => `${i.path.join(".") || "args"} ${i.message}`)
              .join("; ")}`,
          );
        }
        const provider = resolveSource(args.data.source);
        const hits = await provider.search(args.data.query, {
          userAgent: USER_AGENT,
          timeoutMs: toolHopMs(),
        });
        if (hits.length === 0) {
          return `No articles matched "${args.data.query}" in ${provider.name}.`;
        }
        return hits
          .map((h) => `${h.title} — ${h.url}${h.snippet ? `\n  ${h.snippet}` : ""}`)
          .join("\n");
      }

      if (call.name === "fetch_extract") {
        const args = extractArgsSchema.safeParse(call.arguments);
        if (!args.success) {
          throw new Error(
            `invalid arguments for fetch_extract: ${args.error.issues
              .map((i) => `${i.path.join(".") || "args"} ${i.message}`)
              .join("; ")}`,
          );
        }
        const provider = resolveSource(args.data.source);
        const article = await provider.fetchArticle(args.data.title, {
          userAgent: USER_AGENT,
          timeoutMs: toolHopMs(),
        });
        if (!article) {
          return `No article titled "${args.data.title}" in ${provider.name}.`;
        }
        addSource(article);
        return article.extract.slice(0, TOOL_EXTRACT_CAP);
      }

      throw new Error(`unknown tool "${call.name}"`);
    };

    const distill = async (
      extract: string,
      budgetMs?: number,
    ): Promise<{ brief: string; highlights: string[] }> => {
      try {
        const result = await router.complete<{ brief: string; highlights: string[] }>({
          ...buildResearchRequest(destination, extract),
          override,
          ...(budgetMs !== undefined ? { deadlineMs: budgetMs } : {}),
          tools: researchTools,
          executeTool,
        });
        modelRuns.push({
          stage: "destination",
          provider: result.provider,
          model: result.model,
          status: "done",
          usage: result.usage,
          estimated: result.provider === "mock",
          ts: new Date().toISOString(),
        });
        if (result.toolsDegraded) warnings.push(TOOLS_DEGRADED_WARNING);
        return { brief: result.value?.brief ?? "", highlights: result.value?.highlights ?? [] };
      } catch (err) {
        modelRuns.push({
          stage: "destination",
          provider: researchModel.provider,
          model: researchModel.model,
          status: "failed",
          estimated: false,
          ts: new Date().toISOString(),
        });
        throw err;
      }
    };

    // Baseline pre-fetch (§17.2): walk the configured source chain — Wikivoyage
    // first, Wikipedia behind it — until one yields an article. A failing source
    // is skipped, never fatal.
    let article: KnowledgeArticle | null = null;
    for (const provider of chain) {
      try {
        const hits = await provider.search(destination, {
          userAgent: USER_AGENT,
          timeoutMs: hopBudgetMs(),
        });
        const first = hits[0];
        if (!first) continue;
        const found = await provider.fetchArticle(first.title, {
          userAgent: USER_AGENT,
          timeoutMs: hopBudgetMs(),
        });
        if (found) {
          article = found;
          break;
        }
      } catch {
        // source unreachable/misbehaving — try the next one in the chain
      }
    }
    if (article) addSource(article);

    let brief: string;
    let highlights: string[] = [];

    if (article) {
      const budget = distillBudgetMs();
      if (!canDistill(budget)) {
        // Budget too tight to call a model — ship the grounded raw extract (§17.2).
        brief = article.extract.slice(0, 600);
        warnings.push(
          "Section time budget too tight for model distillation; showing the raw reference extract.",
        );
      } else {
        try {
          const distilled = await distill(article.extract, budget);
          brief = distilled.brief || article.extract.slice(0, 600);
          highlights = distilled.highlights;
        } catch {
          brief = article.extract.slice(0, 600);
          warnings.push("Model distillation unavailable; showing the raw reference extract.");
        }
      }
    } else {
      const budget = distillBudgetMs();
      if (!canDistill(budget)) {
        brief = `Reference material for ${destination} is currently unavailable.`;
      } else {
        try {
          const distilled = await distill(`No reference material found for ${destination}.`, budget);
          brief = distilled.brief || `Reference material for ${destination} is unavailable.`;
          highlights = distilled.highlights;
        } catch {
          brief = `Reference material for ${destination} is currently unavailable.`;
        }
      }
    }

    // Coverage is decided after distillation: a tool-fetched article grounds the
    // brief even when the pre-fetch chain came up empty.
    const coverage: "grounded" | "ungrounded" = sources.length > 0 ? "grounded" : "ungrounded";
    if (coverage === "ungrounded") {
      warnings.push(
        "No reference article matched this destination; research below is model-only (ungrounded).",
      );
    }

    const data = { coverage, brief, highlights, sources, warnings };
    return { sectionResult: { key, status: "completed", data, meta: { modelRuns } } };
  }

  const port = Number(process.env.AGENT_DESTINATION_PORT ?? 8001);
  const card = createAgentCard({
    name: "destination-research",
    description:
      "Researches a travel destination using Wikivoyage and Wikipedia, distilling a grounded brief with sources and highlights.",
    version: VERSION,
    baseUrl: `http://localhost:${port}`,
    skills: [
      {
        id: "destination-research",
        name: "Destination Research",
        description: "Overview, highlights, and sources for the intended destination.",
        tags: ["destination", "research", "wikivoyage", "wikipedia"],
        examples: ["Research five days in Paris"],
      },
    ],
  });

  return createAgentServer({
    card,
    handlers: { "message/send": destinationHandler },
    logger: opts.logger ?? true,
  });
}
