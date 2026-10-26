import { z } from "zod";

import { TRIP_MAX_DAYS } from "../duration";

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date YYYY-MM-DD");

/** Runtime model choice sent by the UI and honoured for the whole plan (§6.1). */
export const modelChoiceSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(200),
});

export type ModelChoiceInput = z.infer<typeof modelChoiceSchema>;

export const planInputSchema = z
  .object({
    query: z.string().min(1).max(4000),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    travelerCount: z.number().int().min(1).max(50).default(1),
    preferences: z.record(z.unknown()).optional(),
    model: modelChoiceSchema.optional(),
    // --- Optional HR validation (§13 reserved fields, §17.5) ---
    /** Set by the UI's "Connect to HR portal" button; gates the `hr` section dispatch. */
    requestHrValidation: z.boolean().optional(),
    /** Mandatory once HR is connected. Canonical employee number, e.g. `E0001`. */
    employeeId: z
      .string()
      .regex(/^E\d{4}$/i, "expected format E0001 (E + 4 digits)")
      .optional(),
    /** Optional human-readable name; the HR agent resolves `employeeId` first, then this. */
    employeeName: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.requestHrValidation === true && !value.employeeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["employeeId"],
        message: "employeeId is required when requestHrValidation is set",
      });
    }
    // Structural date checks (§13). Deliberately time-independent: "is the trip
    // already over" needs a clock, so the UI preflight owns that call and this
    // stays a plain contract check on direct API traffic.
    if (value.startDate && value.endDate) {
      const start = Date.parse(`${value.startDate}T00:00:00Z`);
      const end = Date.parse(`${value.endDate}T00:00:00Z`);
      const days = Math.round((end - start) / 86_400_000) + 1;
      if (end < start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must not be before startDate",
        });
      } else if (days > TRIP_MAX_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: `trip may not exceed ${TRIP_MAX_DAYS} days`,
        });
      }
    }
  });

export type PlanInput = z.infer<typeof planInputSchema>;

export const sharedContextSchema = z.object({
  destination: z.string().optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  travelers: z.number().int().min(1).default(1),
  interests: z.array(z.string()).default([]),
});

export type SharedContext = z.infer<typeof sharedContextSchema>;

export const planStatusSchema = z.enum([
  "created",
  "parsing",
  "dispatching",
  "running",
  "synthesizing",
  "completed",
  "failed",
  "cancelled",
]);

export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  section: z.string().optional(),
});

export type PlanError = z.infer<typeof planErrorSchema>;

export const tokenUsageSchema = z.object({
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type TokenUsageCounts = z.infer<typeof tokenUsageSchema>;

/**
 * One model invocation for a plan stage (intent / section / synthesis).
 * `status: "running"` frames are announced before a call and are not persisted;
 * completed/failed runs accumulate on `PlanState.modelRuns`.
 */
export const modelRunSchema = z.object({
  stage: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["running", "done", "failed"]),
  usage: tokenUsageSchema.optional(),
  /** True when counts are estimated (mock provider) rather than backend-reported. */
  estimated: z.boolean().default(false),
  ts: z.string(),
});

export type ModelRun = z.infer<typeof modelRunSchema>;

export const planStateSchema = z.object({
  planId: z.string().min(1),
  status: planStatusSchema,
  input: planInputSchema,
  sharedContext: sharedContextSchema.optional(),
  sections: z.record(z.string(), z.unknown()).default({}),
  errors: z.array(planErrorSchema).default([]),
  modelRuns: z.array(modelRunSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PlanState = z.infer<typeof planStateSchema>;

export const planEventTypeSchema = z.enum([
  "plan.created",
  "plan.status",
  "intent.parsed",
  "section.started",
  "section.completed",
  "section.failed",
  "model.usage",
  "plan.completed",
  "plan.failed",
  "plan.cancelled",
]);

export type PlanEventType = z.infer<typeof planEventTypeSchema>;

export const planEventSchema = z.object({
  id: z.number().int().positive(),
  planId: z.string(),
  type: planEventTypeSchema,
  data: z.unknown(),
  ts: z.string(),
});

export type PlanEvent = z.infer<typeof planEventSchema>;
