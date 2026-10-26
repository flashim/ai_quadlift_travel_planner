import { z } from "zod";
import { modelChoiceSchema, modelRunSchema, planInputSchema, sharedContextSchema } from "./plan";

/** `message/send` params when invoking a specialist agent (§9). */
export const sectionCallParamsSchema = z.object({
  planId: z.string().optional(),
  section: z.string().optional(),
  sharedContext: sharedContextSchema,
  /**
   * The original user request, forwarded unchanged alongside `sharedContext` (the
   * query-parsing output). Sections that derive values the orchestrator also has to
   * derive — the budget agent's trip length (§17.4) — read it here so both sides
   * agree on the same inputs without duplicating the parsing contract.
   */
  input: planInputSchema.optional(),
  /** Per-plan runtime model choice — forwarded so agents use the same model. */
  model: modelChoiceSchema.optional(),
  /** Section time budget in ms (the agent's registry timeoutMs) — agents must answer within it (§6.1/§9). */
  deadlineMs: z.number().int().positive().optional(),
});

export type SectionCallParams = z.infer<typeof sectionCallParamsSchema>;

/** `message/send` result when invoking a specialist agent. */
export const sectionCallResultSchema = z.object({
  sectionResult: z.object({
    key: z.string(),
    status: z.enum(["completed", "failed"]),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean().default(false),
      })
      .optional(),
    meta: z.object({ modelRuns: z.array(modelRunSchema).optional() }).optional(),
  }),
});

export type SectionCallResult = z.infer<typeof sectionCallResultSchema>;

/** `message/send` params on the orchestrator (create a plan). */
export const createPlanParamsSchema = z.object({
  input: planInputSchema,
});

export type CreatePlanParams = z.infer<typeof createPlanParamsSchema>;

export const createPlanResultSchema = z.object({
  taskId: z.string(),
  status: z.string(),
});

export const taskIdParamsSchema = z.object({ taskId: z.string().min(1) });

export const planGetResultSchema = z.object({
  plan: z.unknown().nullable(),
});
