import type { SharedContext } from "../../schemas/plan";
import type { SectionEnvelope } from "../../schemas/section";
import {
  intentResultSchema,
  itinerarySchema,
  researchResultSchema,
} from "../../schemas/section";
import type { ModelAdapter, ModelResult, ResolvedModelConfig } from "../types";

/**
 * Deterministic offline adapter. Used directly (`MODEL_PROVIDER=mock`) or as the
 * last entry of `MODEL_FALLBACK_CHAIN` so the skeleton always runs without a
 * live model backend. Structured outputs are built heuristically and then
 * validated by the router against the same Zod schema as real backends.
 */
export const mockAdapter: ModelAdapter = {
  name: "mock",
  supports: () => true,
  async complete(req, cfg: ResolvedModelConfig): Promise<ModelResult> {
    const content = req.messages.map((m) => m.content).join("\n");
    const toolMessages = req.messages.filter((m) => m.role === "tool");

    // Deterministic tool round (§6.1): call the first offered tool exactly once,
    // then answer from its result — so the tool loop is exercised offline too.
    if (req.tools?.length && toolMessages.length === 0) {
      const first = req.tools[0]!;
      const prompt = Math.ceil(content.length / 4);
      return {
        text: "",
        toolCalls: [
          { id: "mock-call-1", name: first.name, arguments: mockToolArgs(first.name, content) },
        ],
        provider: "mock",
        model: cfg.model || "mock",
        usage: { prompt, completion: 8, total: prompt + 8 },
      };
    }

    let value: unknown;
    switch (req.role) {
      case "intent":
        value = mockIntent(content);
        break;
      case "research":
        // After a tool round the reference material arrives as tool output.
        value = mockResearch(
          toolMessages.length ? withToolExtract(content, toolMessages) : content,
        );
        break;
      case "synthesis":
        value = mockSynthesis(content);
        break;
    }
    const text = JSON.stringify(value);
    // Estimated accounting (≈4 chars/token) so the UI token counter works offline.
    const prompt = Math.ceil(content.length / 4);
    const completion = Math.ceil(text.length / 4);
    return {
      text,
      provider: "mock",
      model: cfg.model || "mock",
      usage: { prompt, completion, total: prompt + completion },
    };
  },
};

// --- intent ---

function mockIntent(content: string): unknown {
  const query = block(content, "TRAVEL_REQUEST:", ["START_DATE:"]) ?? "";
  const startLine = line(content, "START_DATE:");
  const endLine = line(content, "END_DATE:");
  const travelersLine = line(content, "TRAVELERS:");
  const prefsLine = block(content, "PREFERENCES:", []) ?? "{}";

  const isoDates = [...query.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]!);
  const startDate = startLine && startLine !== "unknown" ? startLine : isoDates[0];
  const endDate = endLine && endLine !== "unknown" ? endLine : isoDates[1];

  let interests: string[] = [];
  try {
    const prefs = JSON.parse(prefsLine) as Record<string, unknown>;
    if (Array.isArray(prefs.interests)) {
      interests = prefs.interests.filter((i): i is string => typeof i === "string");
    }
  } catch {
    // preferences are best-effort
  }

  return intentResultSchema.parse({
    destination: extractDestination(query),
    startDate,
    endDate,
    travelers: Number.parseInt(travelersLine ?? "1", 10) || 1,
    interests,
  });
}

function extractDestination(query: string): string | undefined {
  const stopAhead =
    /(?=\s+(?:from|between|for|with|during|on|in\s+\d{4}-\d{2}-\d{2})\b|[,.!?]|$)/i;
  const match = query.match(new RegExp(`\\b(?:in|to)\\s+(.+?)${stopAhead.source}`, "i"));
  if (!match?.[1]) return undefined;
  const cleaned = match[1]
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^\d/.test(cleaned)) return undefined;
  return cleaned;
}

// --- research ---

function mockResearch(content: string): unknown {
  const destination = line(content, "DESTINATION:") ?? "the destination";
  const extract = block(content, "EXTRACT:", []) ?? "";
  const sentences = extract
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const brief =
    sentences.slice(0, 2).join(" ") ||
    `${destination}: no reference material was available to summarize.`;
  return researchResultSchema.parse({
    brief: brief.slice(0, 600),
    highlights: sentences.slice(2, 7).map((s) => truncate(s, 120)),
  });
}

// --- synthesis ---

function mockSynthesis(content: string): unknown {
  const ctx = safeJson<SharedContext>(block(content, "SHARED_CONTEXT:", ["DURATION_DAYS:"]) ?? "{}");
  const duration = Number.parseInt(line(content, "DURATION_DAYS:") ?? "3", 10) || 3;
  const sections = safeJson<Record<string, SectionEnvelope>>(
    block(content, "SECTION_DATA:", []) ?? "{}",
  );

  const destination = ctx.destination ?? "your destination";
  const destSection = pick(sections, "destination");
  const weatherSection = pick(sections, "weather");
  const budgetSection = pick(sections, "budget");
  const dest =
    destSection?.status === "completed" && destSection.data
      ? (destSection.data as { brief?: string; highlights?: string[] })
      : null;
  const weather =
    weatherSection?.status === "completed" && weatherSection.data
      ? (weatherSection.data as {
          coverage?: string;
          days?: { date: string; condition: string; minC: number; maxC: number }[];
          disclaimers?: string[];
        })
      : null;
  const budget =
    budgetSection?.status === "completed" && budgetSection.data
      ? (budgetSection.data as { usd?: { total?: number }; currency?: string })
      : null;
  const hrSection = pick(sections, "hr");
  const hr =
    hrSection?.status === "completed" && hrSection.data
      ? (hrSection.data as {
          employeeName?: string;
          remainingDays?: number;
          tripDays?: number;
          verdict?: string;
        })
      : null;

  const days = Array.from({ length: duration }, (_, i) => {
    const idx = i + 1;
    const weatherDay = weather?.days?.[i];
    const highlight = dest?.highlights?.[i % Math.max(dest.highlights.length, 1)];
    return {
      index: idx,
      date: addDays(ctx.startDate, i),
      title: highlight ? truncate(highlight, 60) : `Day ${idx} in ${destination}`,
      morning: dest?.brief
        ? truncate(dest.brief, 220)
        : `Start the day in ${destination} — orient yourself and plan the morning around your interests.`,
      afternoon: weatherDay
        ? `Afternoon plan (${weatherDay.condition}, ${weatherDay.minC}–${weatherDay.maxC}°C): ` +
          (highlight ?? `explore ${destination}'s highlights at a relaxed pace.`)
        : `Afternoon: ${highlight ?? `explore ${destination} at a relaxed pace`}.`,
      evening: weatherDay
        ? `Evening in ${destination}: dinner and a stroll — expect ${weatherDay.condition.toLowerCase()}.`
        : `Evening: local dinner and downtime in ${destination}.`,
    };
  });

  const warnings = [
    ...(weather?.disclaimers ?? []),
    ...(destSection?.status === "completed" && destSection.data
      ? ((destSection.data as { warnings?: string[] }).warnings ?? [])
      : []),
    ...sectionsErrors(sections),
    "Draft itinerary generated by the offline mock model; set a live MODEL_PROVIDER for richer output.",
  ].filter(Boolean);

  return itinerarySchema.parse({
    summary:
      `${duration} days in ${destination}` +
      (ctx.travelers > 1 ? ` for ${ctx.travelers} travelers` : "") +
      (dest?.brief ? `. ${truncate(dest.brief, 240)}` : ".") +
      (typeof budget?.usd?.total === "number"
        ? ` Estimated trip cost: ${Math.round(budget.usd.total)} ${budget.currency ?? "USD"}.`
        : "") +
      (hr
        ? ` Leave status for ${hr.employeeName ?? "the employee"}: ${
            hr.verdict === "compliant"
              ? `compliant — ${hr.remainingDays} day(s) left after reserving ${hr.tripDays}`
              : `insufficient balance — ${hr.tripDays} day(s) needed, ${hr.remainingDays} available`
          }.`
        : // the check was asked for but could not run: say so in the summary, §17.5
        hrSection?.status === "failed"
          ? ` Leave status check unavailable: ${
              hrSection.error?.message ?? "the HR agent did not answer"
            }.`
          : ""),
    days,
    sources:
      (destSection?.status === "completed" &&
        (destSection.data as { sources?: [] } | undefined)?.sources) ||
      [],
    assumptions: [
      "No flights, transfers, or accommodations are booked or priced by this plan.",
      ...(budget ? ["Cost figures are catalog estimates, not quotes or bookings."] : []),
      ...(hr
        ? ["Leave status is an HR advisory against the stored balance; no leave is booked."]
        : []),
      "Daily plan assumes one destination base unless noted.",
    ],
    warnings,
  });
}

// --- helpers ---

/** Plausible arguments for the first offered tool (kept stable for tests). */
function mockToolArgs(toolName: string, content: string): Record<string, unknown> {
  const destination = line(content, "DESTINATION:") ?? "the destination";
  if (toolName === "fetch_extract") return { title: destination, source: "wikivoyage" };
  return { query: destination, source: "wikivoyage" };
}

/** Re-run mock research on tool output: keep DESTINATION, replace EXTRACT. */
function withToolExtract(content: string, toolMessages: { content: string }[]): string {
  const destination = line(content, "DESTINATION:") ?? "the destination";
  const extract = toolMessages
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);
  return `DESTINATION: ${destination}\nEXTRACT:\n${extract}`;
}

function pick(sections: Record<string, SectionEnvelope>, key: string): SectionEnvelope | undefined {
  if (sections[key]) return sections[key];
  for (const v of Object.values(sections)) if (v?.key === key) return v;
  return undefined;
}

function sectionsErrors(sections: Record<string, SectionEnvelope>): string[] {
  return Object.values(sections)
    .filter((s) => s?.status === "failed")
    .map((s) => `Section "${s.key}" unavailable: ${s.error?.message ?? "failed"}`);
}

function block(content: string, start: string, stops: string[]): string | undefined {
  const startIdx = content.indexOf(start);
  if (startIdx === -1) return undefined;
  let body = content.slice(startIdx + start.length);
  for (const stop of stops) {
    const idx = body.indexOf(stop);
    if (idx !== -1) body = body.slice(0, idx);
  }
  return body.replace(/^\n/, "").trimEnd();
}

function line(content: string, prefix: string): string | undefined {
  const match = content.match(new RegExp(`^${escapeRegExp(prefix)}\\s*(.*)$`, "m"));
  return match?.[1]?.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

export function addDays(iso: string | undefined, offset: number): string | undefined {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
