import type { PlanEvent, PlanState } from "../schemas/plan";

/**
 * Persistence boundary (§10). The skeleton ships {@link MemoryPlanRepository};
 * a Prisma-backed implementation with the same semantics lands in the DB phase.
 * The append-only event shape (monotonic per-plan `id`) MUST stay identical so
 * switching stores is a configuration change (`PLAN_STORE`), not a code change.
 */
export type PlanPatch = Partial<PlanState> | ((current: PlanState) => Partial<PlanState>);

export interface PlanRepository {
  create(plan: PlanState): Promise<void>;
  /**
   * Apply a patch. The functional form receives a snapshot of the current plan
   * and MUST be used for any read-modify-write of shared fields (e.g. merging
   * `sections` from parallel section calls) — resolving it against the live
   * state inside a single synchronous update is what makes concurrent writers
   * safe. A plain object patch overwrites the listed fields as before.
   */
  update(planId: string, patch: PlanPatch): Promise<void>;
  get(planId: string): Promise<PlanState | null>;
  appendEvent(evt: Omit<PlanEvent, "id">): Promise<PlanEvent>;
  listEvents(planId: string, sinceId?: number): Promise<PlanEvent[]>;
}

export class MemoryPlanRepository implements PlanRepository {
  private plans = new Map<string, PlanState>();
  private events = new Map<string, PlanEvent[]>();
  private counters = new Map<string, number>();

  async create(plan: PlanState): Promise<void> {
    if (this.plans.has(plan.planId)) {
      throw new Error(`Plan already exists: ${plan.planId}`);
    }
    this.plans.set(plan.planId, structuredClone(plan));
    this.events.set(plan.planId, []);
    this.counters.set(plan.planId, 0);
  }

  async update(planId: string, patch: PlanPatch): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    // Resolve the functional form synchronously, before yielding to the event
    // loop: two interleaved read-modify-writes both observe the same live
    // state, so neither can overwrite the other's merge (unlike get-then-update).
    const resolved =
      typeof patch === "function" ? patch(structuredClone(plan)) : patch;
    Object.assign(plan, resolved, { updatedAt: new Date().toISOString() });
    this.plans.set(planId, plan);
  }

  async get(planId: string): Promise<PlanState | null> {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : null;
  }

  async appendEvent(evt: Omit<PlanEvent, "id">): Promise<PlanEvent> {
    const next = (this.counters.get(evt.planId) ?? 0) + 1;
    this.counters.set(evt.planId, next);
    const event: PlanEvent = { ...evt, id: next };
    const list = this.events.get(evt.planId);
    if (!list) throw new Error(`Plan not found: ${evt.planId}`);
    list.push(event);
    return event;
  }

  async listEvents(planId: string, sinceId = 0): Promise<PlanEvent[]> {
    const list = this.events.get(planId);
    if (!list) throw new Error(`Plan not found: ${planId}`);
    return list.filter((e) => e.id > sinceId).map((e) => structuredClone(e));
  }
}

/** Factory: `PLAN_STORE=memory` today; `prisma` is the future DB phase (§10). */
export function createPlanRepository(store = process.env.PLAN_STORE ?? "memory"): PlanRepository {
  switch (store) {
    case "memory":
      return new MemoryPlanRepository();
    case "prisma":
      throw new Error(
        "PLAN_STORE=prisma is not implemented yet (future DB phase, ARCHITECTURE §10)",
      );
    default:
      throw new Error(`Unknown PLAN_STORE: ${store}`);
  }
}
