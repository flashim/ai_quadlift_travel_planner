import {
  AppErrorCode,
  ModelRouter,
  RpcError,
  buildIntentRequest,
  buildSynthesisRequest,
  durationDays,
  internalError,
  rpcCall,
  sectionCallResultSchema,
  sectionProviders,
  type AgentRegistry,
  type IntentResult,
  type Itinerary,
  type ModelChoice,
  type ModelRun,
  type PlanError,
  type PlanEvent,
  type PlanEventType,
  type PlanInput,
  type PlanRepository,
  type PlanState,
  type RegistryEntry,
  type SectionEnvelope,
  type SectionCallResult,
  type SharedContext,
} from "@travel/shared";
import type { EventHub } from "./events";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class PlanCancelledError extends Error {
  constructor() {
    super("plan cancelled");
    this.name = "PlanCancelledError";
  }
}

export interface WorkflowDeps {
  repo: PlanRepository;
  registry: AgentRegistry;
  router: ModelRouter;
  hub: EventHub;
}

export interface Workflow {
  start(planId: string): void;
  cancel(planId: string): Promise<boolean>;
}

export function createWorkflow(deps: WorkflowDeps): Workflow {
  const { repo, registry, router, hub } = deps;
  const cancelled = new Set<string>();

  async function emit(planId: string, type: PlanEventType, data: unknown): Promise<PlanEvent> {
    const event = await repo.appendEvent({
      planId,
      type,
      data,
      ts: new Date().toISOString(),
    });
    hub.publish(event);
    return event;
  }

  async function setStatus(planId: string, status: PlanState["status"]): Promise<void> {
    await repo.update(planId, { status });
    await emit(planId, "plan.status", { status });
  }

  function ensureNotCancelled(planId: string): void {
    if (cancelled.has(planId)) throw new PlanCancelledError();
  }

  async function runSection(
    planId: string,
    sectionKey: string,
    agent: RegistryEntry,
    ctx: SharedContext,
    input: PlanInput,
    signal: AbortSignal,
    model?: ModelChoice,
  ): Promise<void> {
    await emit(planId, "section.started", { section: sectionKey, agent: agent.name });
    let envelope: SectionEnvelope;

    try {
      const res = await rpcCall<SectionCallResult>(
        agent.baseUrl,
        "message/send",
        {
          planId,
          section: sectionKey,
          sharedContext: ctx,
          // The original request rides along with the parsed context, so a section
          // that must reproduce an orchestrator-derived value (the budget agent's
          // trip length, §17.4) reads the same inputs the orchestrator does.
          input,
          // The section's whole time budget (§6.1): the agent must answer within it,
          // including any model calls it makes along the way.
          deadlineMs: agent.timeoutMs,
          ...(model ? { model } : {}),
        },
        { timeoutMs: agent.timeoutMs, signal },
      );
      envelope = sectionCallResultSchema.parse(res).sectionResult;
      envelope.key = sectionKey;
    } catch (err) {
      ensureNotCancelled(planId);
      const appCode =
        err instanceof RpcError ? (err.appCode ?? AppErrorCode.Internal) : AppErrorCode.Internal;
      const message = err instanceof Error ? err.message : "section failed";
      envelope = {
        key: sectionKey,
        status: "failed",
        error: { code: appCode, message, retryable: err instanceof RpcError ? err.retryable : true },
      };
      if (agent.required) {
        await storeAndEmit(planId, envelope);
        throw internalError(
          AppErrorCode.SectionFailed,
          `Required section "${sectionKey}" failed: ${message}`,
          false,
          { section: sectionKey },
        );
      }
    }

    await storeAndEmit(planId, envelope);
    if (envelope.status === "failed" && agent.warnOnFailure) {
      // Opt-in (§17.5): the reason must reach the itinerary summary, not just the
      // section. plan.errors merge into itinerary.warnings at synthesis, and the
      // prompt tells the model to repeat it verbatim.
      await pushError(planId, {
        code: envelope.error?.code ?? AppErrorCode.SectionFailed,
        message: `Section "${sectionKey}" unavailable: ${
          envelope.error?.message ?? "the agent did not answer"
        }`,
        retryable: envelope.error?.retryable ?? false,
        section: sectionKey,
      });
    }
    if (envelope.status === "failed" && agent.required) {
      throw internalError(
        AppErrorCode.SectionFailed,
        `Required section "${sectionKey}" reported failure`,
        false,
        { section: sectionKey },
      );
    }
  }

  async function storeAndEmit(planId: string, envelope: SectionEnvelope): Promise<void> {
    // Functional patch: sections run in parallel, and a get-then-spread-then-update
    // would let one section's stale snapshot overwrite another's merge.
    await repo.update(planId, (plan) => ({
      sections: { ...plan.sections, [envelope.key]: envelope },
    }));
    // Model runs performed inside the agent (e.g. destination distillation).
    if (envelope.meta?.modelRuns) {
      for (const run of envelope.meta.modelRuns) await recordModelRun(planId, run);
    }
    await emit(planId, envelope.status === "completed" ? "section.completed" : "section.failed", {
      section: envelope.key,
      status: envelope.status,
      error: envelope.error,
    });
  }

  async function pushError(planId: string, error: PlanError): Promise<void> {
    await repo.update(planId, (plan) => ({ errors: [...plan.errors, error] }));
  }

  /** Transient "working with X" frame — emitted before a model call, not persisted. */
  async function announceModel(
    planId: string,
    stage: string,
    cfg: { provider: string; model: string },
  ): Promise<void> {
    await emit(planId, "model.usage", {
      run: {
        stage,
        provider: cfg.provider,
        model: cfg.model,
        status: "running",
        estimated: cfg.provider === "mock",
        ts: new Date().toISOString(),
      } satisfies ModelRun,
    });
  }

  /** Persist a finished model run (tokens, provider that actually answered). */
  async function recordModelRun(planId: string, run: ModelRun): Promise<void> {
    await repo.update(planId, (plan) => ({ modelRuns: [...plan.modelRuns, run] }));
    await emit(planId, "model.usage", { run });
  }

  function doneRun(
    stage: string,
    r: { provider: string; model: string; usage?: { prompt: number; completion: number; total: number } },
  ): ModelRun {
    return {
      stage,
      provider: r.provider,
      model: r.model,
      status: "done",
      usage: r.usage,
      estimated: r.provider === "mock",
      ts: new Date().toISOString(),
    };
  }

  async function run(planId: string): Promise<void> {
    // Overall plan budget — an outer safety net only. Every stage has its own
    // deadline (model calls: MODEL_TIMEOUT_MS via the adapter; sections: the
    // registry timeoutMs), so this MUST be larger than their sum or a slow
    // provider burns the whole budget and aborts the stages that follow.
    const signal = AbortSignal.any([
      AbortSignal.timeout(Number(process.env.PLAN_TIMEOUT_MS ?? 300_000)),
      abortSignalFor(planId),
    ]);
    try {
      const plan = await repo.get(planId);
      if (!plan) throw internalError(AppErrorCode.PlanNotFound, `Plan not found: ${planId}`, false);

      // --- 1. intent parsing (§17.1, built-in) ---
      await setStatus(planId, "parsing");
      await announceModel(planId, "intent", router.describe("intent", plan.input.model));
      const intent = await router.complete<IntentResult>({
        ...buildIntentRequest(plan.input),
        override: plan.input.model,
        signal,
      });
      if (!intent.value) {
        throw internalError(
          AppErrorCode.ModelOutputInvalid,
          "Intent parsing returned no structured result",
          false,
        );
      }
      const ctx: SharedContext = {
        destination: intent.value.destination,
        startDate: intent.value.startDate ?? plan.input.startDate,
        endDate: intent.value.endDate ?? plan.input.endDate,
        travelers: intent.value.travelers ?? plan.input.travelerCount,
        interests: intent.value.interests,
      };
      await repo.update(planId, { sharedContext: ctx });
      await recordModelRun(planId, doneRun("intent", intent));
      await emit(planId, "intent.parsed", { sharedContext: ctx });
      ensureNotCancelled(planId);

      // --- 2. dispatch (registry-driven, §17.0) ---
      await setStatus(planId, "dispatching");
      // `requiresField` keeps an opt-in agent (HR, §17.5) out of every plan the user
      // did not ask for — without the orchestrator naming a section.
      const providers = [...sectionProviders(registry).entries()].filter(([, agent]) => {
        if (!agent.requiresField) return true;
        return Boolean((plan.input as Record<string, unknown>)[agent.requiresField]);
      });

      if (!ctx.destination) {
        await pushError(planId, {
          code: AppErrorCode.InvalidParams,
          message:
            "No destination detected in your request — try adding \"in <city>\" (e.g. \"5 days in Paris\").",
          retryable: false,
        });
      } else if (providers.length > 0) {
        await setStatus(planId, "running");
        const results = await Promise.allSettled(
          providers.map(([sectionKey, agent]) =>
            runSection(planId, sectionKey, agent, ctx, plan.input, signal, plan.input.model),
          ),
        );
        ensureNotCancelled(planId);
        const fatal = results.find(
          (r) => r.status === "rejected" && !(r.reason instanceof PlanCancelledError),
        );
        if (fatal && fatal.status === "rejected") throw fatal.reason;
      }

      // --- 3. synthesis + formatting (same agent, §17.1) ---
      ensureNotCancelled(planId);
      await setStatus(planId, "synthesizing");
      await announceModel(planId, "synthesis", router.describe("synthesis", plan.input.model));
      const latest = (await repo.get(planId))!;
      const duration = computeDuration(plan.input, latest.sharedContext);
      const sections = latest.sections as Record<string, SectionEnvelope>;
      const synth = await router.complete<Itinerary>({
        ...buildSynthesisRequest(latest.sharedContext ?? ctx, duration, sections),
        override: plan.input.model,
        signal,
      });
      if (!synth.value) {
        throw internalError(
          AppErrorCode.ModelOutputInvalid,
          "Synthesis returned no itinerary",
          false,
        );
      }
      await recordModelRun(planId, doneRun("synthesis", synth));

      const itinerary: Itinerary = {
        ...synth.value,
        warnings: dedupe([
          ...synth.value.warnings,
          ...latest.errors.map((e) => e.message),
        ]),
      };
      await repo.update(planId, (cur) => ({
        sections: {
          ...cur.sections,
          synthesis: { key: "synthesis", status: "completed", data: itinerary },
        },
      }));
      await setStatus(planId, "completed");
      const done = (await repo.get(planId))!;
      await emit(planId, "plan.completed", { plan: done });
    } catch (err) {
      const plan = await repo.get(planId);
      if (!plan || TERMINAL.has(plan.status)) return;

      if (err instanceof PlanCancelledError || cancelled.has(planId)) {
        await setStatus(planId, "cancelled");
        await emit(planId, "plan.cancelled", { planId });
        return;
      }

      const appCode =
        err instanceof RpcError ? (err.appCode ?? AppErrorCode.Internal) : AppErrorCode.Internal;
      const message = err instanceof Error ? err.message : "plan failed";
      await repo.update(planId, (cur) => ({
        errors: [
          ...cur.errors,
          { code: appCode, message, retryable: err instanceof RpcError ? err.retryable : false },
        ],
      }));
      await setStatus(planId, "failed");
      const failed = (await repo.get(planId))!;
      await emit(planId, "plan.failed", { plan: failed });
    }
  }

  const controllers = new Map<string, AbortController>();

  function abortSignalFor(planId: string): AbortSignal {
    let controller = controllers.get(planId);
    if (!controller) {
      controller = new AbortController();
      controllers.set(planId, controller);
    }
    return controller.signal;
  }

  return {
    start(planId: string): void {
      void run(planId).finally(() => controllers.delete(planId));
    },
    async cancel(planId: string): Promise<boolean> {
      const plan = await repo.get(planId);
      if (!plan) return false;
      if (TERMINAL.has(plan.status)) return false;
      cancelled.add(planId);
      controllers.get(planId)?.abort();
      const current = (await repo.get(planId))!;
      if (!TERMINAL.has(current.status)) {
        await repo.update(planId, { status: "cancelled" });
        await emit(planId, "plan.cancelled", { planId });
      }
      return true;
    },
  };
}

/**
 * Trip length for the day grid. Delegates to the shared implementation so the
 * itinerary grid and the budget agent's pricing (§17.4) always agree.
 */
export function computeDuration(input: PlanInput, ctx?: SharedContext): number {
  return durationDays(input, ctx);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
