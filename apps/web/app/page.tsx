"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// subpath import: the package root pulls fastify into the client bundle (§13 preflight)
import {
  preflightTripInput,
  type PreflightField,
  type PreflightIssue,
} from "@travel/shared/tripInput";
import type {
  BudgetSection,
  DestinationSection,
  HrSection,
  Itinerary,
  ModelRun,
  PlanState,
  WeatherSection,
} from "@travel/shared/schemas";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

type SectionStatus = "pending" | "running" | "done" | "failed";

interface StreamEvent {
  id?: number;
  type: string;
  data: Record<string, unknown>;
}

interface ModelMeta {
  provider: string;
  model: string;
  catalog?: {
    groups: { provider: string; label: string; models: string[] }[];
    configured: { provider: string; model: string };
  };
}

/** Select value format: "" = configured default, else "<provider>::<model>". */
const MODEL_STORAGE_KEY = "voyage:model";

function parseModelChoice(value: string): { provider: string; model: string } | null {
  if (!value) return null;
  const i = value.indexOf("::");
  if (i <= 0 || i === value.length - 2) return null;
  return { provider: value.slice(0, i), model: value.slice(i + 2) };
}

function hasModelOption(catalog: ModelMeta["catalog"], value: string): boolean {
  const choice = parseModelChoice(value);
  if (!choice || !catalog?.groups) return false;
  return catalog.groups.some((g) => g.provider === choice.provider && g.models.includes(choice.model));
}

const EVENT_TYPES = [
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
] as const;

const EXAMPLES = [
  "Plan five days in Paris from 2026-10-05 to 2026-10-09",
  "Three days in Reykjavik, interested in history and food, for 2 travelers",
  "A week in Tokyo from 2026-11-12 to 2026-11-18",
];

/** Canonical employee number, §17.5 — `E` followed by 4 digits. */
const EMPLOYEE_ID_RE = /^E\d{4}$/i;

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [travelers, setTravelers] = useState(2);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [status, setStatus] = useState<string>("");
  const [intentDone, setIntentDone] = useState(false);
  const [sections, setSections] = useState<Record<string, SectionStatus>>({});
  const [connectionNote, setConnectionNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<ModelMeta | null>(null);
  const [modelChoice, setModelChoice] = useState("");
  const [runs, setRuns] = useState<ModelRun[]>([]);
  const [nowLine, setNowLine] = useState<string>("");
  const [dest, setDest] = useState<string>("");
  const [hrConnected, setHrConnected] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  /** Pre-dispatch validation (§13) — nothing is sent while any of these stand. */
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  /** What the request text was read as, shown so the assumption is never silent. */
  const [preflightNotes, setPreflightNotes] = useState<string[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const destRef = useRef<string>("");

  useEffect(() => {
    fetch("/api/meta")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: ModelMeta | null) => {
        if (!m?.provider || !m?.model) return;
        setMeta(m);
        // Restore the last selection — drop it when the model disappeared
        // (e.g. `ollama pull` list changed or the catalog shrank).
        try {
          const saved = window.localStorage.getItem(MODEL_STORAGE_KEY);
          if (saved && hasModelOption(m.catalog, saved)) setModelChoice(saved);
          else if (saved) window.localStorage.removeItem(MODEL_STORAGE_KEY);
        } catch {
          // storage unavailable — selection just doesn't persist
        }
      })
      .catch(() => {
        // header falls back to "…" until a run announces its model
      });
  }, []);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      const data = event.data ?? {};
      switch (event.type) {
        case "plan.status": {
          const s = data.status as string;
          setStatus(s);
          if (s === "parsing") setNowLine("Parsing your request…");
          if (s === "dispatching") setNowLine("Request understood — dispatching specialist agents…");
          if (s === "synthesizing") {
            setNowLine("Composing your itinerary…");
            setSections((prev) => ({ ...prev, synthesis: "running" }));
          }
          break;
        }
        case "intent.parsed": {
          setIntentDone(true);
          const ctx = (data.sharedContext ?? {}) as { destination?: string };
          if (ctx.destination) {
            destRef.current = ctx.destination;
            setDest(ctx.destination);
          }
          break;
        }
        case "section.started": {
          const section = data.section as string;
          const where = destRef.current || "your destination";
          setSections((prev) => ({ ...prev, [section]: "running" }));
          if (section === "destination") {
            setNowLine(`Destination agent: researching ${where} on Wikipedia…`);
          } else if (section === "weather") {
            setNowLine(`Weather agent: checking the forecast for ${where}…`);
          } else if (section === "budget") {
            setNowLine(`Budget agent: pricing the trip for ${where}…`);
          } else if (section === "hr") {
            setNowLine("HR agent: checking your leave balance for this trip…");
          }
          break;
        }
        case "section.completed":
          setSections((prev) => ({ ...prev, [data.section as string]: "done" }));
          break;
        case "section.failed":
          setSections((prev) => ({ ...prev, [data.section as string]: "failed" }));
          break;
        case "model.usage": {
          const run = data.run as ModelRun;
          setRuns((prev) => [
            ...prev.filter((r) => !(r.status === "running" && r.stage === run.stage)),
            run,
          ]);
          if (run.status === "running") setNowLine(runningLine(run));
          break;
        }
        case "plan.completed": {
          const done = data.plan as PlanState;
          setPlan(done);
          setRuns(done.modelRuns ?? []);
          setSections((prev) => ({ ...prev, synthesis: "done" }));
          setStatus("completed");
          setNowLine("");
          setPhase("done");
          setConnectionNote(null);
          closeStream();
          break;
        }
        case "plan.failed": {
          const failed = data.plan as PlanState;
          setPlan(failed);
          setRuns(failed.modelRuns ?? []);
          setStatus("failed");
          setNowLine("");
          setPhase("error");
          const errs = failed.errors;
          setError(errs[errs.length - 1]?.message ?? "The plan could not be completed.");
          closeStream();
          break;
        }
        case "plan.cancelled":
          setPhase("idle");
          setStatus("cancelled");
          setNowLine("");
          setConnectionNote("Plan cancelled.");
          closeStream();
          break;
      }
    },
    [closeStream],
  );

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (phase === "submitting" || phase === "running") return;

      // Pre-dispatch preflight (§13): read the request text, reconcile it with the
      // fields, and refuse to create a plan we could not evaluate. Runs entirely in
      // the browser — an invalid request costs no model tokens and no agent calls.
      const pre = preflightTripInput({
        query,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        travelers,
        hrEnabled: hrConnected,
        employeeId,
        employeeName,
      });
      if (!pre.ok) {
        setError(null);
        setConnectionNote(null);
        setPreflightNotes([]);
        setIssues(pre.issues);
        return;
      }
      setIssues([]);
      setPreflightNotes(pre.notes);
      // Show what was read out of the text so no assumption is silent.
      if ((pre.startDate ?? "") !== startDate) setStartDate(pre.startDate ?? "");
      if ((pre.endDate ?? "") !== endDate) setEndDate(pre.endDate ?? "");
      if (pre.travelerCount !== travelers) setTravelers(pre.travelerCount);

      setError(null);
      setConnectionNote(null);
      setPlan(null);
      setIntentDone(false);
      setSections({});
      setStatus("");
      setRuns([]);
      setNowLine("");
      destRef.current = "";
      setDest("");
      setPhase("submitting");

      let res: Response;
      try {
        const choice = parseModelChoice(modelChoice);
        res = await fetch("/api/plans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: pre.query,
            ...(pre.startDate ? { startDate: pre.startDate } : {}),
            ...(pre.endDate ? { endDate: pre.endDate } : {}),
            travelerCount: pre.travelerCount,
            ...(pre.requestHrValidation
              ? {
                  requestHrValidation: true,
                  employeeId: pre.employeeId,
                  ...(pre.employeeName ? { employeeName: pre.employeeName } : {}),
                }
              : {}),
            ...(choice ? { model: choice } : {}),
          }),
        });
      } catch {
        setPhase("error");
        setError("Could not reach the app server. Is `npm run dev` running?");
        return;
      }

      const body = (await res.json().catch(() => ({}))) as {
        taskId?: string;
        error?: string;
        issues?: string[];
      };

      if (!res.ok || !body.taskId) {
        setPhase("error");
        setError(
          body.issues?.join("; ") ?? body.error ?? `Plan request failed (HTTP ${res.status}).`,
        );
        return;
      }

      setPhase("running");
      taskIdRef.current = body.taskId;
      const es = new EventSource(`/api/plans/${body.taskId}/events`);
      esRef.current = es;
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (ev) => {
          try {
            handleEvent(JSON.parse((ev as MessageEvent).data) as StreamEvent);
          } catch {
            // ignore malformed frames
          }
        });
      }
      es.onerror = () => {
        if (esRef.current) {
          setConnectionNote("Reconnecting to the event stream…");
        }
      };
    },
    [query, startDate, endDate, travelers, modelChoice, phase, handleEvent, hrConnected, employeeId, employeeName],
  );

  const cancel = useCallback(async () => {
    const id = taskIdRef.current;
    if (!id || phase !== "running") return;
    try {
      await fetch(`/api/plans/${id}/cancel`, { method: "POST" });
    } catch {
      setConnectionNote("Cancel request failed.");
    }
  }, [phase]);

  const reset = useCallback(() => {
    closeStream();
    setPhase("idle");
    setPlan(null);
    setError(null);
    setConnectionNote(null);
    setIntentDone(false);
    setSections({});
    setStatus("");
    setRuns([]);
    setNowLine("");
    destRef.current = "";
    setDest("");
    setIssues([]);
    setPreflightNotes([]);
    taskIdRef.current = null;
  }, [closeStream]);

  const running = phase === "running" || phase === "submitting";
  const hrIdValid = EMPLOYEE_ID_RE.test(employeeId.trim());
  const hrReady = !hrConnected || hrIdValid;

  const issueFor = (field: PreflightField): string | undefined =>
    issues.find((i) => i.field === field)?.message;
  // The id input already shows a live format hint — don't repeat it after submit.
  const employeeIdIssue =
    employeeId.trim().length > 0 && !hrIdValid ? undefined : issueFor("employeeId");

  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const selectedModel = parseModelChoice(modelChoice);
  const selectedLabel = selectedModel
    ? `${selectedModel.provider}/${selectedModel.model}`
    : meta
      ? `${meta.provider}/${meta.model}`
      : "…";
  const actualLabel = latestRun ? `${latestRun.provider}/${latestRun.model}` : null;
  const tokenTotal = runs.reduce((sum, r) => sum + (r.usage?.total ?? 0), 0);
  const tokensEstimated = runs.some((r) => r.estimated && r.usage);
  const tokenLabel = runs.some((r) => r.usage)
    ? `${tokensEstimated ? "~" : ""}${tokenTotal.toLocaleString("en-US")}`
    : "—";

  return (
    <div className="container">
      <header className="site-header">
        <h1>Voyage</h1>
        <span className="tag">multi-agent travel planner</span>
        <div className="model-strip" title="Model for new plans — a runtime choice, no restart needed (§6.1)">
          <span>Model</span>
          <select
            className="model-select"
            value={modelChoice}
            onChange={(e) => {
              setModelChoice(e.target.value);
              try {
                window.localStorage.setItem(MODEL_STORAGE_KEY, e.target.value);
              } catch {
                // storage unavailable — keep the selection for this session only
              }
            }}
            aria-label="Model for new plans"
          >
            <option value="">
              {meta ? `default · ${meta.provider}/${meta.model}` : "configured default"}
            </option>
            {(meta?.catalog?.groups ?? []).map((g) => (
              <optgroup key={g.provider} label={g.label}>
                {g.models.map((m) => (
                  <option key={`${g.provider}::${m}`} value={`${g.provider}::${m}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {actualLabel && actualLabel !== selectedLabel ? <b>{actualLabel}</b> : null}
          <span className="strip-sep">·</span>
          <span>Tokens</span>
          <b>{tokenLabel}</b>
        </div>
      </header>

      <section className="card">
        <form onSubmit={submit}>
          <label htmlFor="query">Where to, and when?</label>
          <textarea
            id="query"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIssues([]);
            }}
            placeholder="e.g. Plan five days in Paris from 2026-10-05 to 2026-10-09, relaxed pace, food and museums"
            disabled={running}
            aria-invalid={issueFor("query") !== undefined}
          />
          {issueFor("query") && <div className="field-error">{issueFor("query")}</div>}
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip"
                onClick={() => {
                  setQuery(ex);
                  setIssues([]);
                }}
                disabled={running}
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="field-row">
            <div>
              <label htmlFor="start">Start date</label>
              <input
                id="start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setIssues([]);
                }}
                disabled={running}
                aria-invalid={issueFor("startDate") !== undefined}
              />
              {issueFor("startDate") && <div className="field-error">{issueFor("startDate")}</div>}
            </div>
            <div>
              <label htmlFor="end">End date</label>
              <input
                id="end"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setIssues([]);
                }}
                disabled={running}
                aria-invalid={issueFor("endDate") !== undefined}
              />
              {issueFor("endDate") && <div className="field-error">{issueFor("endDate")}</div>}
            </div>
            <div>
              <label htmlFor="travelers">Travelers</label>
              <input
                id="travelers"
                type="number"
                min={1}
                max={50}
                value={travelers}
                onChange={(e) => {
                  setTravelers(Number(e.target.value) || 1);
                  setIssues([]);
                }}
                disabled={running}
                aria-invalid={issueFor("travelers") !== undefined}
              />
              {issueFor("travelers") && (
                <div className="field-error">{issueFor("travelers")}</div>
              )}
            </div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Dates and traveler counts written in the request are read out for you — e.g.
            “first week of December” or “family of four”.
          </div>
          <div className="hr-connect">
            <label className="hr-toggle" htmlFor="hr-connect">
              <input
                id="hr-connect"
                type="checkbox"
                checked={hrConnected}
                onChange={(e) => {
                  setHrConnected(e.target.checked);
                  setIssues([]);
                }}
                disabled={running}
              />
              <span>Connect to HR portal</span>
            </label>
            <span className="muted">checks your leave balance before you commit to the trip</span>
          </div>
          {hrConnected && (
            <div className="field-row hr-fields">
              <div>
                <label htmlFor="employeeId">Employee ID (required)</label>
                <input
                  id="employeeId"
                  value={employeeId}
                  onChange={(e) => {
                    setEmployeeId(e.target.value);
                    setIssues([]);
                  }}
                  placeholder="E0001"
                  autoComplete="off"
                  disabled={running}
                  aria-invalid={employeeId.trim().length > 0 && !hrIdValid}
                />
                {employeeId.trim().length > 0 && !hrIdValid ? (
                  <div className="field-error">Format: E followed by 4 digits, e.g. E0001.</div>
                ) : (
                  employeeIdIssue && <div className="field-error">{employeeIdIssue}</div>
                )}
              </div>
              <div>
                <label htmlFor="employeeName">Employee name (optional)</label>
                <input
                  id="employeeName"
                  value={employeeName}
                  onChange={(e) => {
                    setEmployeeName(e.target.value);
                    setIssues([]);
                  }}
                  placeholder="Ada Lovelace"
                  autoComplete="off"
                  disabled={running}
                  aria-invalid={issueFor("employeeName") !== undefined}
                />
                {issueFor("employeeName") && (
                  <div className="field-error">{issueFor("employeeName")}</div>
                )}
              </div>
            </div>
          )}
          <div className="actions">
            {!running && (
              <button className="primary" type="submit" disabled={!query.trim() || !hrReady}>
                Plan my trip
              </button>
            )}
            {phase === "running" && (
              <button className="danger" type="button" onClick={cancel}>
                Cancel
              </button>
            )}
            {(phase === "done" || phase === "error") && (
              <button className="ghost" type="button" onClick={reset}>
                Plan another trip
              </button>
            )}
          </div>
        </form>
        {preflightNotes.length > 0 && (
          <div className="preflight-notes">
            {preflightNotes.map((note) => (
              <div key={note} className="note assumption">
                {note}
              </div>
            ))}
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        {connectionNote && <div className="muted" style={{ marginTop: 10 }}>{connectionNote}</div>}
      </section>

      {phase === "running" && (
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Working on it…</h2>
          {nowLine && <div className="now-line">{nowLine}</div>}
          <ProgressSteps
            intentDone={intentDone}
            sections={sections}
            status={status}
            dest={dest}
            hrEnabled={hrConnected || plan?.input.requestHrValidation === true}
          />
        </section>
      )}

      {plan && <ItineraryView plan={plan} />}
    </div>
  );
}

function ProgressSteps({
  intentDone,
  sections,
  status,
  dest,
  hrEnabled,
}: {
  intentDone: boolean;
  sections: Record<string, SectionStatus>;
  status: string;
  dest: string;
  hrEnabled: boolean;
}) {
  const where = dest || "your destination";
  const steps: { label: string; state: SectionStatus; detail?: string }[] = [
    {
      label: "Parsing your request",
      state: intentDone ? "done" : "running",
      detail: intentDone ? undefined : "reading dates, destination, interests",
    },
    {
      label: "Destination research",
      state: sections.destination ?? "pending",
      detail: detailFor(sections.destination, `researching ${where} on Wikipedia`),
    },
    {
      label: "Weather forecast",
      state: sections.weather ?? "pending",
      detail: detailFor(sections.weather, `forecast for ${where} from wttr.in`),
    },
    {
      label: "Cost estimate",
      state: sections.budget ?? "pending",
      detail: detailFor(sections.budget, `pricing ${where} from the cost catalog`),
    },
    ...(hrEnabled
      ? [
          {
            label: "HR leave status",
            state: sections.hr ?? "pending",
            detail: detailFor(sections.hr, "checking the balance against this trip"),
          },
        ]
      : []),
    {
      label: "Composing your itinerary",
      state: sections.synthesis ?? (status === "synthesizing" ? "running" : "pending"),
      detail: detailFor(sections.synthesis, "writing the day-by-day plan"),
    },
  ];

  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.label} className={`step ${s.state}`}>
          <span className="dot">{s.state === "done" ? "✓" : s.state === "failed" ? "!" : "•"}</span>
          <span>{s.label}</span>
          {s.detail && <span className="detail">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function detailFor(state?: SectionStatus, working?: string): string | undefined {
  switch (state) {
    case "running":
      return working ? `${working}…` : "working…";
    case "failed":
      return "unavailable — plan continues";
    case "done":
      return "done";
    default:
      return "queued";
  }
}

function runningLine(run: ModelRun): string {
  const who = `${run.provider}/${run.model}`;
  switch (run.stage) {
    case "intent":
      return `Parsing your request with ${who}…`;
    case "synthesis":
      return `Composing your itinerary with ${who}…`;
    case "destination":
      return `Distilling destination research with ${who}…`;
    default:
      return `Running ${run.stage} with ${who}…`;
  }
}

function ItineraryView({ plan }: { plan: PlanState }) {
  const synth = plan.sections.synthesis as
    | { status: string; data?: Itinerary; error?: { message: string } }
    | undefined;
  const weather = plan.sections.weather as
    | { status: string; data?: WeatherSection; error?: { message: string } }
    | undefined;
  const destination = plan.sections.destination as
    | { status: string; data?: DestinationSection; error?: { message: string } }
    | undefined;
  const budget = plan.sections.budget as
    | { status: string; data?: BudgetSection; error?: { message: string } }
    | undefined;
  const hr = plan.sections.hr as
    | { status: string; data?: HrSection; error?: { message: string } }
    | undefined;
  const hrWanted = plan.input.requestHrValidation === true || hr !== undefined;

  const itinerary = synth?.status === "completed" ? synth.data : undefined;

  return (
    <>
      {itinerary && (
        <section className="card summary-card">
          <span className="badge">{plan.status === "completed" ? "Itinerary ready" : plan.status}</span>
          <h2>{itinerary.summary}</h2>
          <p className="muted">
            {itinerary.days.length} day{itinerary.days.length > 1 ? "s" : ""}
            {plan.sharedContext?.destination ? ` · ${plan.sharedContext.destination}` : ""}
            {plan.sharedContext?.travelers ? ` · ${plan.sharedContext.travelers} traveler(s)` : ""}
          </p>
        </section>
      )}

      {weather?.status === "completed" && weather.data && (
        <section className="card">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Weather</h2>
            {weather.data.coverage === "outside-forecast" && (
              <span className="badge warn">outside forecast horizon</span>
            )}
          </div>
          <div className="weather-strip" style={{ marginTop: 12 }}>
            {weather.data.days.map((d) => (
              <div key={d.date} className="weather-day">
                <div className="muted">{d.date}</div>
                <div className="cond">{d.condition}</div>
                <div>
                  {d.minC}°C → {d.maxC}°C
                </div>
              </div>
            ))}
          </div>
          {weather.data.disclaimers.map((d) => (
            <div key={d} className="note warning" style={{ marginTop: 10 }}>
              {d}
            </div>
          ))}
        </section>
      )}

      {destination?.status === "completed" && destination.data && (
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>
            About {plan.sharedContext?.destination ?? "your destination"}{" "}
            {destination.data.coverage === "ungrounded" && (
              <span className="badge warn">ungrounded</span>
            )}
          </h2>
          <p style={{ margin: "8px 0" }}>{destination.data.brief}</p>
          {destination.data.highlights.length > 0 && (
            <ul className="muted">
              {destination.data.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {destination.data.warnings.map((w) => (
            <div key={w} className="note warning">
              {w}
            </div>
          ))}
        </section>
      )}

      {budget && (
        <section className="card">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Estimated cost</h2>
            {budget.data && <span className="badge">{budget.data.currency}</span>}
            {budget.data && !budget.data.matched && (
              <span className="badge warn">default profile</span>
            )}
          </div>

          {budget.status === "completed" && budget.data ? (
            <>
              <p className="muted" style={{ margin: "8px 0" }}>
                {budget.data.days} day{budget.data.days === 1 ? "" : "s"} · {budget.data.nights}{" "}
                night{budget.data.nights === 1 ? "" : "s"} · {budget.data.travelers} traveler
                {budget.data.travelers === 1 ? "" : "s"}
              </p>
              <div className="budget-grid">
                <div className="budget-row head">
                  <span>Per day (USD)</span>
                  <span>
                    {money(budget.data.rates.food)} food · {money(budget.data.rates.transport)}{" "}
                    transport · {money(budget.data.rates.activities)} activities
                  </span>
                </div>
                <div className="budget-row">
                  <span>Hotel (per night)</span>
                  <span>{money(budget.data.rates.hotel)}</span>
                </div>
                <div className="budget-row total">
                  <span>Trip total</span>
                  <span>
                    {money(budget.data.usd.total)} USD · {money(budget.data.local.total)}{" "}
                    {budget.data.currency}
                  </span>
                </div>
              </div>
              {budget.data.disclaimers.map((d) => (
                <div key={d} className="note warning" style={{ marginTop: 10 }}>
                  {d}
                </div>
              ))}
            </>
          ) : (
            <div className="note warning" style={{ marginTop: 10 }}>
              {budget.error?.message ?? "No cost estimate for this trip."}
            </div>
          )}
        </section>
      )}

      {hrWanted && (
        <section className="card">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Leave status</h2>
            {hr?.status === "completed" && hr.data && (
              <span className={hr.data.compliant ? "badge" : "badge warn"}>
                {hr.data.compliant ? "compliant" : "insufficient balance"}
              </span>
            )}
            {hr?.status !== "completed" && <span className="badge warn">not checked</span>}
          </div>

          {hr?.status === "completed" && hr.data ? (
            <>
              <p className="muted" style={{ margin: "8px 0" }}>
                {hr.data.employeeName} · {hr.data.employeeId} · {hr.data.department}
              </p>
              <div className="hr-grid">
                <div className="hr-row">
                  <span>Annual entitlement</span>
                  <span>{hr.data.entitlementDays} days</span>
                </div>
                <div className="hr-row">
                  <span>Already used</span>
                  <span>{hr.data.usedDays} days</span>
                </div>
                <div className="hr-row">
                  <span>Remaining today</span>
                  <span>{hr.data.remainingDays} days</span>
                </div>
                <div className="hr-row">
                  <span>This trip</span>
                  <span>−{hr.data.tripDays} days</span>
                </div>
                <div className="hr-row total">
                  <span>Balance after the trip</span>
                  <span>{hr.data.balanceAfter} days</span>
                </div>
              </div>
              {hr.data.disclaimers.map((d) => (
                <div key={d} className="note warning" style={{ marginTop: 10 }}>
                  {d}
                </div>
              ))}
            </>
          ) : (
            <div className="note warning" style={{ marginTop: 10 }}>
              {hr?.error?.message ??
                "Your leave balance could not be checked — the trip is unaffected."}
            </div>
          )}
        </section>
      )}

      {itinerary && (
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Day-by-day plan</h2>
          <div className="day-grid">
            {itinerary.days.map((day) => (
              <article key={day.index} className="day-card">
                <h3>
                  Day {day.index} — {day.title}
                </h3>
                {day.date && <div className="date">{day.date}</div>}
                <div className="slot">
                  <b>Morning</b>
                  <span>{day.morning}</span>
                </div>
                <div className="slot">
                  <b>Afternoon</b>
                  <span>{day.afternoon}</span>
                </div>
                <div className="slot">
                  <b>Evening</b>
                  <span>{day.evening}</span>
                </div>
              </article>
            ))}
          </div>

          {itinerary.warnings.length > 0 && (
            <>
              <div className="section-title">Warnings</div>
              <div className="notes">
                {itinerary.warnings.map((w) => (
                  <div key={w} className="note warning">
                    {w}
                  </div>
                ))}
              </div>
            </>
          )}

          {itinerary.assumptions.length > 0 && (
            <>
              <div className="section-title">Assumptions</div>
              <div className="notes">
                {itinerary.assumptions.map((a) => (
                  <div key={a} className="note assumption">
                    {a}
                  </div>
                ))}
              </div>
            </>
          )}

          {itinerary.sources.length > 0 && (
            <>
              <div className="section-title">Sources</div>
              <div className="sources">
                {itinerary.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {!itinerary && plan.status !== "completed" && (
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Plan {plan.status}</h2>
          {plan.errors.length > 0 && (
            <div className="notes">
              {plan.errors.map((e, i) => (
                <div key={i} className="note warning">
                  {e.message}
                </div>
              ))}
            </div>
          )}
          {(synth?.status === "failed" || weather?.status === "failed") && (
            <div className="notes">
              {synth?.error && <div className="note warning">{synth.error.message}</div>}
              {weather?.error && <div className="note warning">{weather.error.message}</div>}
            </div>
          )}
        </section>
      )}
    </>
  );
}
