import { z } from "zod";
import { isoDateSchema, modelRunSchema } from "./plan";

export const sectionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
});

export type SectionError = z.infer<typeof sectionErrorSchema>;

export const sectionEnvelopeSchema = z.object({
  key: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  data: z.unknown().optional(),
  error: sectionErrorSchema.optional(),
  /** Side-channel metadata (e.g. model runs performed inside the agent). */
  meta: z.object({ modelRuns: z.array(modelRunSchema).optional() }).optional(),
});

export type SectionEnvelope = z.infer<typeof sectionEnvelopeSchema>;

// --- destination section (agent-destination, §17.2) ---

export const sourceSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  retrievedAt: z.string(),
});

export type Source = z.infer<typeof sourceSchema>;

export const destinationSectionSchema = z.object({
  coverage: z.enum(["grounded", "ungrounded"]),
  brief: z.string(),
  highlights: z.array(z.string()).default([]),
  sources: z.array(sourceSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type DestinationSection = z.infer<typeof destinationSectionSchema>;

// --- weather section (agent-weather, §17.3) ---

export const weatherDaySchema = z.object({
  date: isoDateSchema,
  minC: z.number(),
  maxC: z.number(),
  condition: z.string(),
  precipMm: z.number().optional(),
  windKmph: z.number().optional(),
});

export type WeatherDay = z.infer<typeof weatherDaySchema>;

export const weatherSectionSchema = z.object({
  location: z.string(),
  coverage: z.enum(["forecast", "outside-forecast"]),
  /** Registry name of the provider that answered (§6.2). */
  provider: z.string().optional(),
  asOf: z.string(),
  days: z.array(weatherDaySchema).default([]),
  disclaimers: z.array(z.string()).default([]),
});

export type WeatherSection = z.infer<typeof weatherSectionSchema>;

// --- budget section (agent-budget, §17.4) ---

/** Whole-trip cost broken down by category, in one currency. */
export const budgetBreakdownSchema = z.object({
  hotel: z.number(),
  food: z.number(),
  transport: z.number(),
  activities: z.number(),
  total: z.number(),
});

export type BudgetBreakdown = z.infer<typeof budgetBreakdownSchema>;

export const budgetSectionSchema = z.object({
  /** Cost-catalog key that was matched, or `"default"`. */
  location: z.string(),
  /** `false` when no row matched the destination and the default profile was used. */
  matched: z.boolean().default(true),
  days: z.number().int().min(1),
  nights: z.number().int().min(0),
  travelers: z.number().int().min(1),
  /** Local currency of the matched profile; `fx` is local units per 1 USD. */
  currency: z.string(),
  fx: z.number().positive(),
  /** Reference rates in USD: `hotel` per night, the rest per person per day. */
  rates: z.object({
    hotel: z.number(),
    food: z.number(),
    transport: z.number(),
    activities: z.number(),
  }),
  usd: budgetBreakdownSchema,
  local: budgetBreakdownSchema,
  disclaimers: z.array(z.string()).default([]),
});

export type BudgetSection = z.infer<typeof budgetSectionSchema>;

// --- HR leave status (§17.5) ---

export const hrSectionSchema = z.object({
  /** The identifier the lookup ran against (`employeeId`, or `employeeName` when no id was sent). */
  employeeId: z.string(),
  employeeName: z.string(),
  department: z.string(),
  /** Contracted annual entitlement in days. */
  entitlementDays: z.number().int().min(0),
  usedDays: z.number().int().min(0),
  remainingDays: z.number().int(),
  /** Trip length for the plan, from the shared duration source (§17.1 / §17.4). */
  tripDays: z.number().int().min(1),
  /** Days left after reserving `tripDays`; may be negative. */
  balanceAfter: z.number().int(),
  compliant: z.boolean(),
  verdict: z.enum(["compliant", "insufficient-balance"]),
  disclaimers: z.array(z.string()).default([]),
});

export type HrSection = z.infer<typeof hrSectionSchema>;

// --- final itinerary (orchestrator synthesis, §17.1) ---

export const itineraryDaySchema = z.object({
  index: z.number().int().positive(),
  date: isoDateSchema.optional(),
  title: z.string(),
  morning: z.string(),
  afternoon: z.string(),
  evening: z.string(),
});

export type ItineraryDay = z.infer<typeof itineraryDaySchema>;

export const itinerarySchema = z.object({
  summary: z.string(),
  days: z.array(itineraryDaySchema).min(1),
  sources: z.array(sourceSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

export type Itinerary = z.infer<typeof itinerarySchema>;

// --- model output schemas (§6.1 structured outputs) ---

export const intentResultSchema = z.object({
  destination: z.string().optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  travelers: z.number().int().min(1).optional(),
  interests: z.array(z.string()).default([]),
});

export type IntentResult = z.infer<typeof intentResultSchema>;

export const researchResultSchema = z.object({
  brief: z.string(),
  highlights: z.array(z.string()).default([]),
});

export type ResearchResult = z.infer<typeof researchResultSchema>;
