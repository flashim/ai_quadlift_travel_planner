# Travel Planner Agentic Application Architecture

This document is the guideline for building the travel planner application: a multi-agent
system in which a user submits a natural-language travel requirement and receives a
well-formatted itinerary produced by a set of discoverable, independently hosted agents.

## 1. Goals And Boundaries

### Goals

- Accept a natural-language travel request through a browser UI input.
- Extract and confirm destination, dates, duration, traveler details, and preferences.
- Run an agentic workflow: one orchestrator agent parses the user query, holds the plan
  state, delegates sections to specialist agents, consolidates their results, and formats
  the final itinerary.
- Serve every agent as a separate service on its own port starting at 8000, with a
  published agent card so agents are discoverable at runtime.
- Keep the agent roster **extensible**: adding or removing a specialist MUST NOT require
  changes to the orchestrator core (registry-driven, see §17.0).
- Retrieve live weather from **Open-Meteo** (configurable provider chain, wttr.in
  fallback) and destination research grounded in **Wikipedia**.
- Provide a friendly Next.js UX that captures the request, shows live progress, and
  summarizes the itinerary.
- Support **any local or cloud LLM** behind one adapter with per-role routing and
  fallback (see §6.1).

### Boundaries

- No booking, payment, or ticketing flows.
- HR leave validation and cost estimation ship as the optional `hr` (§17.5) and
  `budget` (§17.4) agents; both are advisory only and never block a plan.
- Not a security boundary: containers are a development/deployment convenience (§3.1).

## 2. Normative Terms

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** express implementation requirements.

## 3. System Context

```text
Browser
  |
  v
Next.js App Router (:3000)
  |  create/read/cancel/retry plans, SSE events, UI
  v
Plan API (BFF)
  |  A2A-style JSON-RPC 2.0 over HTTP
  v
Orchestrator Agent (:8000)  <---- owns PlanState, holds all workflow state
  |        |          |
  |        |          +---------> ModelProvider (local or cloud, role-routed)  [§6.1]
  |        |                       intent parsing + itinerary synthesis
  |        |
  |        +-- section:destination --> Destination Research Agent (:8001) --> Wikipedia API
  |        +-- section:weather ------> Weather Agent (:8002) --------------> Open-Meteo / wttr.in (§6.2 chain)
  |        +-- section:budget ------> Budget Agent (:8003) ----------------> SQLite cost catalog (§17.4)
  |
  +----------- section:hr (opt-in) -> HR Agent (:8004) -------------------> SQLite leave balances (§17.5)
  |
  +-- future agents (:8005+) registered in config/agents.json
```

### 3.1 Port Allocation

| Service | Port | Notes |
|---|---|---|
| Next.js web (dev) | 3000 | UI + Plan API (BFF) |
| Orchestrator Agent | 8000 | Fixed. Includes intent parsing and synthesis/formatting |
| Budget Agent | 8003 | Read-only SQLite cost catalog (§17.4); `required: false` |
| HR Agent | 8004 | Read-only SQLite leave balances (§17.5); `required: false`, `requiresField` |
| Specialist agent pool | 8001–8049 | Assigned sequentially as agents are added; recorded in `config/agents.json` |
| Reserved (future) | 8050–8059 | Deferred features (§8) |
| Ollama (local default) | 11434 | When `MODEL_PROVIDER=ollama` |

`config/agents.json` is the **single source of truth** for which agents exist and where
they live. Ports MUST be unique; the registry (not hardcoded constants) drives all
orchestrator delegation.

### 3.2 Containerized Development And Deployment

Target: **single-host Docker Compose**. One host runs `docker compose up --build` and
serves the whole system. The repository MUST provide the following, in two stages.

#### Stage 0 (skeleton, no database required)

- **One multi-stage `Dockerfile`** with a build target per service (`web`, `orchestrator`,
  `agent-destination`, `agent-weather`, …). Shared base + dependency layers so all images
  build from the same cache; targets are added as agents are added (§17.0).
- **`docker-compose.yml`** with one service per registry agent on a private bridge
  network:
  - Only the web port (`3000`) is published in the default profile. Agents (8000+) stay
    internal — discoverable by the orchestrator over the compose network, not the host.
  - A `dev` profile MAY publish 8000–8002 for direct agent-card inspection.
  - `depends_on` with `condition: service_healthy`; healthchecks use Node one-liners
    (`node -e "fetch('http://localhost:800N/health')…"`) because slim images ship no curl.
- **Registry override rule:** `config/agents.json` keeps `http://localhost:800N` URLs for
  host development; compose injects per-agent env overrides
  `AGENT_<NAME>_BASE_URL=http://<service>:800N` (e.g. `AGENT_WEATHER_BASE_URL=http://agent-weather:8002`).
  The same registry file works on the host and in containers — no config forks.
- **Next.js** builds with `output: 'standalone'` to keep the web image minimal.
- **Ollama** is a `local` compose profile only; **host mode is the documented default**
  (containers add GPU complexity and CPU-only overhead).
- `.dockerignore` excluding `.env`, SQLite runtime files, model artifacts, test output,
  and secrets.
- Liveness and readiness health checks for the app, each agent, and Ollama.

#### Which mode when

Docker is **not required for day-to-day development**. Choose the mode by activity:

| Mode | Command | When to use |
|---|---|---|
| **Primary dev loop (host)** | `npm run dev` | Everyday coding — fast hot reload, agents/cards directly on `localhost:8000+`, Ollama on the host with no container overhead |
| **Stage 0 compose** | `docker compose up --build` | Demos, deployment parity, and CI image builds (catches Dockerfile/drift) |
| **Stage 1 compose** | same, plus named volume + `PLAN_STORE=prisma` | Actual single-host deployment (§3.2) |
| **CI** | `docker compose build` + host-run tests | Clean-environment verification (§5.1) |

Containerized development (bind-mounted dev containers) is optional and slower on
macOS/Windows; host `npm run dev` for development plus Compose for CI/deployment is the
recommended split.

#### Stage 1 (when the database lands — §10)

- Add a **named volume** for the SQLite file and set `PLAN_STORE=prisma`.
- Nothing else in the compose file or application code changes.

#### Deployment boundary

SQLite is single-writer and single-host — correct for this Compose topology. Running
multiple orchestrator replicas requires Postgres behind the same `PlanRepository`
interface (`@prisma/adapter-pg`), not a redesign; that swap is out of scope until needed.

Containers are a development and deployment convenience, not a security boundary. Images
MUST run as a non-root user (`USER node`), secrets MUST be injected at runtime, and
internal services MUST NOT be exposed publicly by default.

## 4. Project Structure

npm workspaces monorepo, one language (TypeScript) across UI and all agents:

```text
/
├── ARCHITECTURE.md
├── package.json                    # workspaces: apps/*, packages/*
├── .env.example
├── AGENTS.md                       # repository operating rules
├── config/
│   └── agents.json                 # agent registry (source of truth, §17.0)
├── packages/
│   └── shared/
│       ├── src/schemas/            # Zod: PlanState, section payloads, RPC envelopes
│       ├── src/a2a/                # agent card builder, JSON-RPC server/client, errors
│       └── src/model/              # ModelProvider interface + provider adapters [§6.1]
├── apps/
│   ├── web/                        # Next.js App Router (3000)
│   ├── orchestrator/               # 8000 — state machine, delegation, synthesis
│   ├── agent-destination/          # 8001 — Wikipedia research
│   ├── agent-weather/              # 8002 — weather providers (open-meteo, wttr)
│   ├── agent-budget/               # 8003 — SQLite cost catalog (§17.4, no LLM)
│   └── agent-hr/                   # 8004 — SQLite leave balances (§17.5, no LLM)
├── Dockerfile                      # multi-stage, one target per service (§3.2)
└── docker-compose.yml
```

Shared code lives in `packages/shared`; agents MUST NOT duplicate schemas or RPC logic.

## 5. Technology Decisions

- **Web:** Next.js App Router and React with TypeScript.
- **Agents:** Node.js 20 LTS+, Fastify, TypeScript — same toolchain as the web app.
- **Runtime:** Node.js 20 LTS or newer.
- **Persistence:** behind the `PlanRepository` interface (§10). The skeleton ships the
  in-memory implementation (`PLAN_STORE=memory`); SQLite is **deferred to a later phase**
  as a placeholder — when it lands: SQLite via Prisma (Rust-free, driver adapters), committed migrations.
- **ORM (when DB lands):** Prisma `prisma-client` generator with `prisma/schema.prisma`.
  Re-evaluated Jan 2026 (Prisma 7.x): Rust-free by default (~90% smaller client, no engine
  binary in images), typed client, migrations, Studio — simplifies development; SQLite via
  `@prisma/adapter-better-sqlite3`, Postgres later via `@prisma/adapter-pg` (config swap, no code change).
- **Validation:** Zod for HTTP, A2A, model output, and provider payloads.
- **Agent transport:** A2A-style JSON-RPC 2.0 over HTTP (§9).
- **Model layer:** `ModelProvider` adapter with local (Ollama) and cloud backends, role-routed with fallback (§6.1).
- **Testing:** Vitest for unit/integration/contract tests and Playwright for browser tests.
- **Streaming:** Server-Sent Events with persisted event IDs and reconnect support.

`.env` files, model artifacts, and secrets MUST NOT be committed.

### 5.1 Development Prerequisites

#### Required software

- Node.js 24+ and npm 10+ (`node:sqlite` backs the budget and hr agents' catalogs, §17.4, §17.5).
- Git.
- Optional: Docker + Docker Compose for the containerized profile.
- Optional (local models): Ollama with at least one pulled model.

#### Required project dependencies

Installed by `npm install` at the workspace root: Next.js, React, Fastify, Zod,
Vitest, Playwright, and the shared workspace packages. Prisma CLI/Client is added only
in the deferred DB phase (§10).

#### Ollama prerequisites

- `ollama serve` reachable at `OLLAMA_BASE_URL` (default `http://localhost:11434`).
- At least one instruct model pulled (e.g. `ollama pull llama3.1:8b`).
- Cloud mode requires none of the above.

#### Minimum hardware guidance

- Cloud-model mode: any machine that runs Node and a browser.
- Local-model mode: 16 GB RAM recommended for 7–8B models; GPU optional.

#### Environment setup

- Copy `.env.example` → `.env`; set `MODEL_PROVIDER`, role overrides, `PLAN_STORE`, `AGENTS_REGISTRY_PATH`, and any API keys.
- No database step in the skeleton: `PLAN_STORE` defaults to `memory` (§10).
  `npm run db:migrate` becomes required only after the Prisma phase lands.

#### Ports and local services

3000 (web), 8000 (orchestrator), 8001+ (specialists per registry), 11434 (Ollama, optional).
All ports MUST be free before `npm run dev`.

#### Initialization checklist

1. `npm install`
2. `cp .env.example .env` and edit
3. `npm run agents:doctor` — verifies registry entries, fetches every agent card, checks `/health`
4. `npm run dev` — or `docker compose up --build` for the containerized profile (§3.2)
5. (Future, DB phase only) `npm run db:migrate` with `PLAN_STORE=prisma`

#### CI and clean-environment prerequisites

CI MUST run from a clean checkout: install, typecheck, lint, unit/contract tests,
build, and Playwright tests with stubbed model and provider servers (no live
Wikipedia/wttr.in/LLM calls required in CI).

## 6. Provider Adapter Architecture

### 6.1 ModelProvider (multi-backend, role-based)

All LLM access goes through one interface. Backends are pluggable; the active backend
and model are switchable by configuration — no code changes.

```ts
// packages/shared/src/model/types.ts (shape, not final code)
type ModelRole = "intent" | "research" | "synthesis";
type ModelCapability = "json-schema" | "tools";

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema for arguments
}

interface ModelRequest {
  role: ModelRole;
  messages: ModelMessage[];              // may include assistant tool_calls + tool result turns
  jsonSchema?: ZodType;          // structured output requirement
  signal?: AbortSignal;
  deadlineMs?: number;
  override?: { provider: string; model: string };  // per-plan runtime choice (UI selector)
  tools?: ToolDefinition[];               // offered to the model (§6.1 tool loop)
  executeTool?: (call: ToolCall) => Promise<string>;  // required with `tools` — caller owns execution
}

interface ModelAdapter {
  readonly name: string;                          // "ollama" | "groq" | "openai" | "anthropic" | "gemini" | "mock"
  supports(cap: ModelCapability): boolean;        // "json-schema" | "tools" (streaming reserved)
  complete(req: ModelRequest, cfg: ModelConfig): Promise<ModelResult>;  // may return toolCalls instead of text
}
```

**Built-in adapters (MUST ship in the skeleton):**

| Adapter | Covers | Endpoint style |
|---|---|---|
| `ollama` | Local models (default) | Ollama `/api/chat` |
| `groq` | Groq cloud (`GROQ_API_KEY`, `GROQ_MODEL`) | OpenAI-compatible `/openai/v1/chat/completions` |
| `openai` | OpenAI, and any OpenAI-compatible endpoint via `OPENAI_BASE_URL` (Azure OpenAI, vLLM, LM Studio, llama.cpp server, OpenRouter, Mistral, DeepSeek, …) | `/v1/chat/completions` |
| `anthropic` | Claude models | `/v1/messages` |
| `gemini` | Google Gemini | generateContent |

**Role-based routing.** Each `ModelRole` resolves its backend/model independently, so a
cheap local model can parse intent while a stronger cloud model synthesizes:

```env
MODEL_PROVIDER=ollama                # default backend for all roles
MODEL_INTENT_PROVIDER=ollama
MODEL_INTENT_MODEL=qwen3:8b
MODEL_RESEARCH_PROVIDER=openai
MODEL_RESEARCH_MODEL=gpt-4o-mini
MODEL_SYNTHESIS_PROVIDER=anthropic
MODEL_SYNTHESIS_MODEL=claude-sonnet-4
MODEL_FALLBACK_CHAIN=ollama,openai   # tried in order on failure
```

**Normative behavior:**

- Resolution order for a role: per-plan `PlanInput.model` (runtime UI choice) → role-specific provider/model → `MODEL_PROVIDER`/`MODEL_MODEL` → first entry of `MODEL_FALLBACK_CHAIN`.
- The UI selector lists models from `GET /api/meta` (live catalog: Groq `/models` when `GROQ_API_KEY` is set, Ollama `/api/tags`, plus the offline mock). The chosen `{provider, model}` travels with the plan (`PlanInput.model`), is forwarded to specialist agents in the section call, and applies from the next run — no restart.
- Fallback candidates use a model that provider can actually serve (its configured default, e.g. `GROQ_MODEL`/`MODEL_MODEL`) rather than inheriting the selected provider's model id.
- If a role's request requires a capability (e.g. `json-schema`) the resolved adapter does not support, the adapter MUST walk the fallback chain before failing.
- Structured outputs MUST be validated with the caller's Zod schema; one invalid model output MUST trigger at most one retry with the validation errors appended, then a stable `MODEL_OUTPUT_INVALID` error.
- All calls MUST honor `AbortSignal` and the request deadline.
- **Deadline slicing.** `ModelRequest.deadlineMs` is an absolute budget (the section's
  registry `timeoutMs`, forwarded with each dispatch, §9/§12). The router splits what is
  left of it across the remaining fallback candidates — each call gets
  `min(MODEL_TIMEOUT_MS, remaining, ceil(remaining / candidates left))` with the
  schema-repair retry re-slicing the same share — and enforces the slice with an
  `AbortSignal.timeout` composed onto the caller's signal. A share below 250 ms is not
  started and yields a retryable `MODEL_UNAVAILABLE` ("budget exhausted"), so a slow
  first candidate can never starve the rest of the chain.
- **Tool loop (function calling).** When `ModelRequest.tools` is set, the router runs
  the model's tool calls inside the same deadline slice instead of returning text:
  1. `tools` without `executeTool` is a programming error (`INVALID_PARAMS`) — the
     router never executes tools itself; the caller (agent) owns SSRF/budget/validation.
  2. Each round re-slices the candidate's remaining slice fairly across the rounds
     left, so a chatty model cannot starve the chain. Round cap is
     `MODEL_TOOL_ROUNDS` (default 3); when it is reached the request is retried
     **tool-free**, forcing a final answer.
  3. Only tool names present in `tools` are executed. A hallucinated name or a
     throwing `executeTool` becomes a `TOOL_ERROR: …` result message fed back to the
     model — never a failed model call, never a side effect outside the allowlist.
  4. Token usage is aggregated across every round of one `complete()` call.
  5. **Degradation.** If no chain candidate advertises `supports("tools")`, the router
     strips `tools`/`executeTool` up front and completes the plain request, returning
     `toolsDegraded: true` so the caller can warn the user. If a capable backend fails
     anyway, the router retries **once** without tools and, if that succeeds, returns
     `toolsDegraded: true`; if both attempts fail the original error is rethrown.
     Tool problems never turn a working section into a failed one.
  6. Schema-repair retries are tool-free: repair fixes formatting, it is not a
     research round.
- Adding a new backend = implement `ModelAdapter`, register it in the adapter registry, document its env vars. The adapter registry is keyed by name; selection is config-driven.

### 6.2 External data adapters

- **Shared HTTP layer.** All upstream calls go through `fetchJson()` in
  `packages/shared/src/http/fetch.ts`, which enforces the guarantees below for
  *every* adapter (weather **and** knowledge): allowlisted hosts only (SSRF-safe),
  a total request timeout composed with the caller's `AbortSignal`, bounded retries
  with exponential backoff on 429/5xx/transient errors, response caching, and Zod
  validation of upstream payloads before anything is cached.
- **`WeatherProvider`** — weather upstream clients used by the weather agent (§17.3),
  behind a name-keyed registry (`weatherProviderRegistry`); selection is
  config-driven via `WEATHER_PROVIDERS` (comma-separated fallback chain, default
  `open-meteo,openweather,tomorrow,wttr`). Implemented: `open-meteo` (geocoding +
  16-day forecast), `openweather` (`OPENWEATHER_API_KEY`), `tomorrow`
  (`TOMORROW_API_KEY`, tomorrow.io v4), `wttr` (wttr.in / wttr.is). Providers that
  require a key declare `requiredEnv`; when it is unset the registry *skips* them
  with a reason (surfaced as a section disclaimer) instead of failing — and if the
  configured chain then has no runnable provider, the keyless defaults take over.
  Unknown names and an empty chain still fail fast. Adding a backend = implement
  `WeatherProvider`, register it in the registry, document its env vars — no
  orchestrator changes.
- **`KnowledgeProvider`** — knowledge sources used by the destination agent (§17.2):
  `wikivoyage` (Action API search + intro extracts) and `wikipedia` (Action API
  search + REST summary), chain configured via `KNOWLEDGE_PROVIDERS` (default
  `wikivoyage,wikipedia`). Both are exposed to the model as research tools (§6.1).
  Unknown names fail fast.
- **No adapter (budget, hr):** the budget (§17.4) and hr (§17.5) agents talk to no
  external service — their sources are local read-only SQLite files seeded at startup
  (`COST_DB_PATH`, `HR_DB_PATH`).

## 7. Domain And Workflow

### 7.1 PlanState

The orchestrator is the **sole owner** of plan state; specialist agents are stateless.

```ts
interface PlanState {
  planId: string;
  status: PlanStatus;
  input: { query: string; startDate?: string; endDate?: string; travelerCount: number; preferences?: Record<string, unknown> };
  sharedContext?: { destination?: string; dates?: { start: string; end: string }; travelers: number; interests: string[] };
  sections: Record<SectionKey, SectionResult>;   // filled by agents, §17.0
  errors: PlanError[];
  createdAt: string; updatedAt: string;
}

type PlanStatus = "created" | "parsing" | "dispatching" | "running" | "synthesizing" | "completed" | "failed" | "cancelled";
```

State is written through the `PlanRepository` (§10) after every transition. With
`PLAN_STORE=prisma` a restart or SSE reconnect never loses progress; with the skeleton's
default `memory` store durability is process-scoped (§10.1).

### 7.2 State sharing rule

The orchestrator sends an explicit, versioned `sharedContext` slice in each specialist
call and receives a Zod-validated `SectionResult` back. Specialists MUST NOT read the
plan store (§10) or other agents' sections.

### 7.3 Sequence

```text
1. UI  -> POST /api/plans                (202 + taskId + eventStream)
2. Orchestrator creates PlanState, emits plan.created
3. Orchestrator parses intent (ModelProvider, role=intent) -> sharedContext, emits intent.parsed
4. Orchestrator builds dispatch plan from config/agents.json (enabled agents by section)
5. Parallel: destination agent (§17.2), weather agent (§17.3), ... future sections
   -> each emits section.started / section.completed | section.failed
6. Orchestrator consolidates all SectionResults
7. Orchestrator synthesizes and formats the itinerary (ModelProvider, role=synthesis)
   -> emits plan.completed with the full itinerary artifact
8. UI renders progress and the final itinerary from the SSE stream
```

Steps 5 MUST run in parallel with per-section deadlines; a failed optional section MUST
NOT discard successful sections (§12).

### 7.4 Event catalog (SSE)

`plan.created`, `plan.status`, `intent.parsed`, `section.started`, `section.completed`,
`section.failed`, `model.usage`, `plan.completed`, `plan.failed`, `plan.cancelled` — each with
`planId`, monotonic `eventId`, `ts`, and a typed `data` payload. `model.usage` carries a
`ModelRun` (stage, provider, model, status, token usage) so the UI can show which model is
working and the running token total; completed runs persist on `PlanState.modelRuns`.

## 8. Deferred Features And Extension Points

Cost analysis ships as the `budget` agent (§17.4) and HR leave validation as the
optional `hr` agent (§17.5). Both are opt-in/degraded-by-design rather than deferred.
Still open:

- **Prisma persistence (§10)** — `PLAN_STORE=memory` today.
- **Retry / history / copy-download UI affordances (§13)** beyond cancel and re-plan.

Adding another specialist later:

- Allocate a port from 8050–8059 (or extend the 8001–8049 pool) and add a registry
  entry (§17.0) — no orchestrator code change for dispatch. Use `requiresField` when
  the section must stay out of plans that did not ask for it (the §17.5 pattern).
- Each new agent still MUST satisfy the full A2A contract (§9).

## 9. A2A Contract

Every agent exposes:

- `GET /.well-known/agent.json` and `GET /.well-known/agent-card.json` — the same
  versioned agent card (dual-publish for v0.x/v1.0 clients), `Content-Type: application/a2a+json`.
- `GET /health` — `{ status: "ok" | "degraded", version, uptimeSec }`.
- `POST /` — validated JSON-RPC 2.0.

**Agent card fields (Zod-validated):** `name`, `description`, `version`, `url` (base
invocation URL), `capabilities` (`streaming`, `pushNotifications`), `skills[]` with
`{ id, name, description, tags, examples }`, `defaultInputModes`,
`defaultOutputModes`.

**JSON-RPC methods:**

| Method | Where | Purpose |
|---|---|---|
| `message/send` | all agents | Synchronous invoke: `{ planId, section, sharedContext, model?, deadlineMs }` → `{ sectionResult }` |
| `tasks/cancel` | orchestrator only | Cancel an in-flight plan |
| `orchestrator/plan:get` | orchestrator | Read current PlanState snapshot (UI/API) |

**Error object codes (stable):** `AGENT_UNREACHABLE`, `AGENT_TIMEOUT`,
`INVALID_PARAMS`, `SECTION_FAILED`, `MODEL_UNAVAILABLE`, `MODEL_OUTPUT_INVALID`,
`UPSTREAM_RATE_LIMITED`, `UPSTREAM_INVALID_RESPONSE`, `PLAN_NOT_FOUND`,
`PLAN_CANCELLED`, `INTERNAL`. Errors MUST be retryable-flagged and MUST NOT contain
stack traces, prompts, credentials, or raw upstream payloads.

**Discovery:** at startup the orchestrator loads `config/agents.json`, fetches each
enabled agent's card, validates it, health-checks it, and caches the result (refresh on
a timer and on `SIGHUP`). If a card is unreachable the registry `baseUrl` is used as a
fallback and the agent is marked `degraded`. Delegation targets come from the registry —
never from hardcoded URLs.

## 10. Persistence Layer (Placeholder For Future Implementation)

Database implementation is **deferred to a later development phase**. The skeleton MUST
ship the interface plus an in-memory store so nothing else in the system needs to change
when persistence lands.

### 10.1 PlanRepository interface (ship now, in `packages/shared`)

```ts
interface PlanRepository {
  create(plan: PlanState): Promise<void>;
  update(planId: string, patch: Partial<PlanState>): Promise<void>;
  get(planId: string): Promise<PlanState | null>;
  appendEvent(evt: PlanEvent): Promise<void>;
  listEvents(planId: string, sinceId?: number): Promise<PlanEvent[]>;
}
```

Selected by `PLAN_STORE`:

| Value | Implementation | Status |
|---|---|---|
| `memory` (default) | `MemoryPlanRepository` — process-local `Map` | **Skeleton** |
| `prisma` | `PrismaPlanRepository` over SQLite | **Future placeholder** |

The event append-only shape (`PlanEvent.id` monotonic per plan) MUST be identical in both
implementations, so switching stores is a configuration change — zero orchestrator rework.

**Known limitations while `PLAN_STORE=memory`:**

- No durability across process restart (plans are lost).
- SSE `Last-Event-ID` replay works only while the process lives.
- These limitations are accepted for the skeleton; §15's restart-resume criterion is
  conditional on `PLAN_STORE=prisma`.

### 10.2 Future schema (normative preview for the Prisma phase)

- **`Plan`** — `id`, `status`, `input` (JSON), `sharedContext` (JSON), `sections` (JSON), `errors` (JSON), timestamps.
- **`PlanEvent`** — `id` (monotonic per plan, used as SSE `id:`), `planId`, `type`, `data` (JSON), `ts`. Enables `Last-Event-ID` replay.
- **`AgentInvocation`** — `id`, `planId`, `agent`, `section`, `status`, `durationMs`, `errorCode?`. For observability and retry of a single section.

### 10.3 Prisma evaluation (decision: adopt when the phase lands)

Re-evaluated against current Prisma (7.x, Jan 2026):

- **Rust-free by default** — no query-engine binary in generated client or images
  (~90% smaller), which removes the classic Prisma-in-Docker problem.
- **Driver adapters:** `@prisma/adapter-better-sqlite3` (SQLite) now;
  `@prisma/adapter-pg` (Postgres) later for scale-out — a config swap, not a code change.
- Typed client, `prisma migrate` history, and Prisma Studio fit the TS monorepo and the
  three-table schema with minimal ceremony.
- **Costs:** one `prisma generate` build step and a small learning curve — accepted.

Model/provider payloads and prompts MUST NOT be stored in ordinary tables; if needed for
debugging they go to opt-in, redacted, TTL-bounded storage.

## 11. RAG And Grounding

RAG grounds destination research and synthesis:

- The destination agent retrieves Wikipedia extracts (§17.2) and returns `sources[]`
  (title, URL, retrievedAt) inside its `SectionResult`.
- The final itinerary MUST carry the sources, retrieval timestamps, and an
  `assumptions[]`/`warnings[]` list (e.g. weather outside forecast horizon).
- Model instructions and retrieved content MUST be kept in separate prompt blocks;
  retrieved text is treated as untrusted data, never as instructions.
- The weather agent is deterministic (data transformation only) and SHOULD NOT call an LLM.
- The budget agent (§17.4) is deterministic too: its cost figures come from a local
  read-only catalog, and the model MUST copy them verbatim into the summary rather
  than recomputing them.
- The hr agent (§17.5) is deterministic in the same way: leave balances come from a
  local read-only catalog; the model repeats its verdict (or the reason it could not
  run) verbatim and MUST NOT recalculate balances.

## 12. Reliability And Security

- Validate all external inputs and model/provider outputs with Zod.
- Use request-scoped deadlines, `AbortSignal`, bounded retries, exponential backoff, and cancellation.
- Persist partial results; one provider failure MUST NOT erase successful sections.
- Sections are classified `required` (intent, synthesis — inside the orchestrator) or
  `optional` (specialists). An optional section failure degrades the plan with a warning.
- SSRF-safe provider configuration (allowlisted hosts), TLS verification, allowed origins, request limits, and internal A2A credentials.
- Redact personal data, prompts, credentials, and provider payloads from ordinary logs.
- Sanitize rendered Markdown and never render unsanitized HTML in the UI.
- Keep model instructions separate from retrieved content (§11).
- Separate liveness and readiness checks for the app, each agent, Ollama, and (DB phase) the database; a degraded optional agent or model backend MUST NOT make the whole application appear unavailable.
- Map internal failures to stable error codes (§9) with safe, retryable, actionable user messages.
- Never return stack traces, SQL, prompts, credentials, or internal URLs to the browser.

## 13. UI And API Contract

The UI MUST provide:

- Friendly natural-language query input with example prompts, plus optional date,
  traveler-count, and preference controls, and an opt-in **"Connect to HR portal"**
  control that reveals the mandatory employee id (§17.5).
- Editable extracted intent and a clarification state when the query is ambiguous.
- Live progress per stage: parsing, destination research, weather, budget, HR (only
  when connected), composing.
- Final itinerary: day-by-day plan, weather strip with coverage notes, cost estimate,
  leave status, sources with timestamps, assumptions, and warnings; copy/download
  actions.
- Retry, cancellation, refresh/reconnect, history, and partial-result states.

Required API capabilities:

- Create plan, read plan by task ID, stream persisted events with SSE and
  `Last-Event-ID` reconnect, cancel active plan, retry a failed specialist section, health status.

### Pre-dispatch input preflight

Before the form is allowed to call `POST /api/plans`, the UI runs
`preflightTripInput()` (`packages/shared/src/tripInput.ts`) in the browser. The check is
pure and needs no model, so an unevaluatable request costs **zero tokens and zero agent
calls**.

- **Free text is read, not ignored.** Prose dates (`2026-12-05`, `5–8 December`,
  `first week of December`, `early December`, `December`) and prose traveller counts
  (`family of four`, `couple of us`, `solo`, `6 people`) are parsed out of `query`.
  A month without a year resolves to the **nearest upcoming occurrence**. An explicit
  count in the text **overrides** the traveler field; text dates win over the date
  fields, and a stated duration only fills gaps the text and fields left open. Every
  assumption is surfaced to the user as a note before anything is sent, and the
  reconciled `startDate` / `endDate` / `travelerCount` are written back into the form.
- **Missing or impossible essentials block submit** with a message on the offending
  field: no dates at all, no end date, end before start, a trip longer than
  `TRIP_MAX_DAYS`, a start date already in the past, travelers outside 1–50, and — when
  HR is connected — a missing or malformed employee id.
- **Direct API traffic gets the same structural contract.** `planInputSchema` rejects
  `endDate < startDate` and trips longer than `TRIP_MAX_DAYS` (both time-independent);
  "already started" stays a UI-side decision because it needs a clock.

### Canonical HTTP payloads

`POST /api/plans` MUST accept:

```json
{
  "query": "Plan five days in Paris from 2026-10-05 to 2026-10-09",
  "startDate": "2026-10-05",
  "endDate": "2026-10-09",
  "travelerCount": 2,
  "preferences": { "pace": "relaxed", "interests": ["food", "museums"] }
}
```

It MUST return `202 Accepted`:

```json
{
  "taskId": "task-id",
  "status": "created",
  "eventStream": "/api/plans/task-id/events"
}
```

Optional HR fields (`employeeId`, `employeeName`, `requestHrValidation`) are implemented
as `planInputSchema` fields: `requestHrValidation: true` requires a canonical
`employeeId` (`E0001`) and is what opts the plan into the §17.5 HR check. The UI
supplies them behind its "Connect to HR portal" control; a plan without them never
calls the HR agent.

## 14. Delivery Sequence

Skeleton-first; each step leaves the app runnable:

1. Scaffold the monorepo, `packages/shared` (schemas, A2A server/client, ModelProvider interface, `PlanRepository` + memory store §10), `.env.example`.
2. Agent skeletons: card + `/health` + `message/send` echo on 8000/8001/8002, registry loading + `agents:doctor`.
3. Orchestrator: PlanState machine, dispatch from registry, event log, SSE endpoint.
4. Containerization (Stage 0, §3.2): multi-target `Dockerfile`, `docker-compose.yml`, healthchecks, `AGENT_*_BASE_URL` overrides.
5. Next.js UI: input → progress → result wired to SSE; stub sections render placeholders.
6. Real integrations: weather agent → Open-Meteo (configurable `WEATHER_PROVIDERS`
   chain), destination agent → Wikipedia.
7. ModelProvider adapters (ollama/openai/anthropic/gemini/openai-compatible) + role routing; intent parsing and synthesis in the orchestrator.
8. Hardening: tests, observability, AGENTS.md, acceptance run.
9. **(Future DB phase, §10)** `PrismaPlanRepository` + migrations + compose named volume (`PLAN_STORE=prisma`); enables restart-resume and cross-restart SSE replay.

## 15. Acceptance Criteria

**Minimal runnable (skeleton):**

- A user query produces, end to end, an itinerary containing a destination brief, a weather section (or an honest `outside-forecast` notice), and a day-by-day plan.
- The default configuration runs **with no database** (`PLAN_STORE=memory`) — no `db:migrate` step.
- `docker compose up --build` serves the full journey on a single host with only port `3000` published (agents reachable only over the compose network).
- All registered agent cards are fetchable at their ports and pass Zod validation; `npm run agents:doctor` passes.
- SSE progress events appear in the UI in order; reconnect with `Last-Event-ID` replays missed events **within a live process** — cross-restart replay applies when `PLAN_STORE=prisma`.
- Switching `MODEL_PROVIDER` (or a single `MODEL_*_PROVIDER` role override) changes the model backend with no code change.

**Extensibility:**

- Adding a dummy specialist agent requires only a new workspace, a registry entry, and a section schema — zero edits to orchestrator dispatch code (verified by a test that registers a stub agent at runtime).
- Killing any one specialist yields a completed-but-degraded plan with a visible warning; the other sections survive.

**Persistence phase (when §10 lands):**

- Restarting the orchestrator mid-plan resumes from persisted `PlanState`; SSE replay works across restarts — via the same `PlanRepository` interface, no orchestrator changes.

## 16. User Experience Contract

- First paint under 2 seconds; no blank screens while agents work.
- Progress uses plain language ("Checking the forecast for Paris…") with a cancel action always available.
- Empty, loading, partial, error, and offline states are designed, not defaulted.
- Itinerary is scannable: summary card → day cards → weather → sources; collapses gracefully on mobile.
- Notifications are concise, accessible (ARIA live regions), non-sensitive, and actionable (Retry / Edit query / Dismiss).
- Invalid input is caught before it is sent: the message sits on the field, nothing is
  created server-side, and what the user *did* mean (dates and counts written in prose)
  is shown back to them for confirmation.

## 17. Agent Contracts

### 17.0 Roster, extensibility, and the agent authoring checklist

The roster lives in `config/agents.json`:

```json
{
  "version": 1,
  "agents": [
    { "name": "destination-research", "baseUrl": "http://localhost:8001", "sections": ["destination"], "required": false, "enabled": true, "timeoutMs": 25000 },
    { "name": "weather", "baseUrl": "http://localhost:8002", "sections": ["weather"], "required": false, "enabled": true, "timeoutMs": 10000 },
    { "name": "budget", "baseUrl": "http://localhost:8003", "sections": ["budget"], "required": false, "enabled": true, "timeoutMs": 10000 },
    { "name": "hr", "baseUrl": "http://localhost:8004", "sections": ["hr"], "required": false, "enabled": true, "timeoutMs": 10000, "requiresField": "requestHrValidation", "warnOnFailure": true }
  ]
}
```

- `sections` declares which itinerary sections the agent fills; the orchestrator builds
  its dispatch plan from these declarations (plus its built-in `intent` and
  `synthesis` sections). Future agents add entries and ports — no orchestrator core
  changes.
- `required: true` means plan failure if the section fails; otherwise the plan completes degraded.
- `requiresField: "<planInput field>"` (optional) keeps the agent out of every plan
  whose `plan.input` does not carry that field — a boolean opt-in such as §17.5's
  `requestHrValidation`. Entries without it are dispatched for every plan, exactly as
  before.
- `warnOnFailure: true` (optional, default `false`) copies a failed section's reason
  into `plan.errors`, which merge into `itinerary.warnings` and are stated in the
  summary — the degradation notice a user-visible section needs (§17.5).
- Section payload schemas MUST live in `packages/shared/src/schemas/` so the
  orchestrator can validate results without importing agent code.

**Agent authoring checklist (for every new agent):**

1. New workspace `apps/agent-<name>` with Fastify and the shared `createAgentServer` bootstrap (card + health + JSON-RPC).
2. Zod input/output schemas added to `packages/shared`.
3. Handler implements the business logic; **no plan-store access** — stateless against
   `PlanRepository`. An agent MAY keep its own read-only reference data (§17.4, §17.5).
4. Registry entry added to `config/agents.json` with a unique port from the pool.
5. Contract tests: card snapshot, health, happy path, malformed params, timeout.
6. Documented in §17 with its external data sources and failure behavior.

### 17.1 Orchestrator Agent — port 8000

- **Role:** the single coordinator. Parses the user query into `sharedContext`
  (ModelProvider, role `intent`), owns `PlanState`, dispatches sections to registry
  agents in parallel, consolidates results, then **synthesizes and formats** the final
  itinerary (ModelProvider, role `synthesis`).
- **Skills:** `parse-intent`, `coordinate-plan`, `format-itinerary`.
- **State:** writes every transition through `PlanRepository` (§10); exposes `orchestrator/plan:get`;
  publishes SSE events (§7.4).
- **Failure:** per-section deadlines and retries (§12); on unrecoverable failure emits
  `plan.failed` with stable error codes and preserves partial sections for retry.

### 17.2 Destination Research Agent — port 8001

- **Role:** thorough research on the user's destination.
- **Data sources** (`KNOWLEDGE_PROVIDERS` chain, default `wikivoyage,wikipedia` —
  each behind the shared §6.2 fetch layer):
  - **Wikivoyage** (primary): Action API `list=search` (title resolution) and
    `prop=extracts&exintro&explaintext` (intro extract); article URLs of the form
    `https://en.wikivoyage.org/wiki/{title}`.
  - **Wikipedia** (secondary): Action API `list=search` plus REST summary
    `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}`.
  - All requests carry a descriptive `User-Agent`, follow redirects server-side,
    and origin-encode titles. Unknown `KNOWLEDGE_PROVIDERS` entries fail fast at
    startup.
- **Behavior — deterministic pre-fetch baseline (§17.2):** walk the chain until one
  source yields an article (a failing source is skipped, never fatal) → LLM distills
  a structured brief (overview, highlights) → return `SectionResult { brief,
  highlights[], sources[], coverage, warnings[] }`.
- **Behavior — research tools (§6.1):** while distilling, the model may call two
  tools, both executed by the agent (not the router) with Zod-validated arguments,
  allowlisted hosts, and deadline-sliced hops:
  - `search_articles { query, source? }` — titles, URLs and snippets from a source.
  - `fetch_extract { title, source? }` — the plain-text intro of one article; a
    successful fetch also records a `sources[]` entry.
  Tool results are fed back to the model until it answers or the round cap forces a
  tool-free answer.
- **Budget (§6.1):** the dispatch forwards the registry `timeoutMs` as `deadlineMs`.
  Each pre-fetch hop gets at most `min(10s, remaining / 2)`; tool hops are carved out
  of the distiller's slice; distillation gets `remaining − 1.5s` of response headroom
  and is skipped below 2 s — the section then answers `grounded` with the raw extract
  plus a warning (or the ungrounded fallback text) instead of overrunning its deadline.
- **Degradation:** no article anywhere in the chain → LLM-only research flagged
  `coverage: "ungrounded"` with an explicit warning (a tool-fetched article can still
  ground it); model backend without tool support → tools are stripped up front and a
  warning tells the user the brief relies on the pre-fetched reference only
  (`toolsDegraded`); upstream failure → `SECTION_FAILED` (retryable) without blocking
  other sections.

### 17.3 Weather Agent — port 8002

- **Role:** forecast for the destination over the travel dates.
- **Data source:** the configured `WeatherProvider` chain (§6.2) —
  `WEATHER_PROVIDERS` (default `open-meteo,openweather,tomorrow,wttr`), first provider
  that answers wins within a shared time budget:
  - `open-meteo` (default): geocode via
    `GET https://geocoding-api.open-meteo.com/v1/search?name=…`, then
    `GET https://api.open-meteo.com/v1/forecast` (daily weathercode, min/max temps,
    precipitation, wind; `forecast_days=16`; metric units). WMO weather codes map
    to conditions deterministically. Base URLs overridable via
    `OPEN_METEO_BASE_URL` / `OPEN_METEO_GEOCODING_BASE_URL` (their hosts feed the
    §6.2 allowlist).
  - `openweather` (`OPENWEATHER_API_KEY`, optional `OPENWEATHER_BASE_URL`): direct
    geocoding `GET /geo/1.0/direct` + the free 5-day/3-hourly `GET /data/2.5/forecast`,
    aggregated to one entry per calendar day (dominant condition, min/max, wind in km/h).
  - `tomorrow` (`TOMORROW_API_KEY`, optional `TOMORROW_BASE_URL`): tomorrow.io v4
    `GET /v4/weather/forecast` with `timesteps=1d`; its `location` parameter accepts a
    place name, so no separate geocoding hop is needed. Tomorrow.io weather codes map
    deterministically.
  - `wttr`: `GET https://wttr.in/{location}?format=j1&m` (metric), fallback domain
    `wttr.is`.
- **Key-aware graceful degradation:** providers declaring `requiredEnv` are *skipped*
  (with a reason) when the key is missing — the section still answers, and each skip
  is reported as a disclaimer naming the provider and the missing variable. If the
  configured chain ends up with no runnable provider, the keyless defaults
  (`open-meteo,wttr`) take over and that is disclaimed too. Unknown names and an
  empty chain still fail fast (a typo must not silently disable a provider).
- **Behavior:** Zod-validate upstream payloads; map daily min/max temps,
  conditions, wind, precipitation to the travel dates; cache successful responses
  60 minutes keyed by normalized location; bounded retry with exponential backoff
  on 429/5xx/transient failures; fall through to the next configured provider.
- **Normative limitation:** forecast horizons are provider-dependent (open-meteo
  ≈16 days, openweather ≈5 days, tomorrow.io ≈7 days, wttr ≈3 days). If travel dates
  fall outside the provider's horizon the section MUST return
  `coverage: "outside-forecast"` with the nearest available days plus a disclaimer —
  it MUST NOT invent long-range forecasts.
- **Determinism:** no LLM calls; pure data transformation (§11).
- **Extension:** implement `WeatherProvider` (§6.2), register it in
  `weatherProviderRegistry`, document its env vars — the orchestrator and section
  schema are untouched.

### 17.4 Budget Agent — port 8003

- **Role:** estimate what the trip costs. Deterministic by design — **no model calls
  at all** (§11). Every figure is a SQLite lookup plus arithmetic, so the same request
  always produces the same numbers.
- **Skills:** `budget-estimate`.
- **Inputs:** `sharedContext` (parsed destination/travelers) **and the original
  request `input`** — the section call forwards both, so the agent can observe the
  user's own words as well as the parsed intent (§17.1).
- **Trip length:** MUST come from `resolveDuration()` in
  `packages/shared/src/duration.ts`, the same source the orchestrator's day grid
  uses, so the budget and the itinerary can never disagree. The number's origin
  (`parsed-dates` → `input-dates` → `query` → `default`) is reported back and shown
  as a disclaimer when it fell back to the default.
- **Data:** `COST_DB` in `apps/agent-budget/src/catalog.ts` seeds `<repo>/data/costs.db`
  at startup, then reopens it **read-only**. Every price is **USD**; each profile
  carries `fx` (local units per 1 USD), so the payload and the UI card show both
  currencies. Override the file with `COST_DB_PATH`; `npm run db:seed` re-seeds it
  on demand.
- **Lookup ladder:** exact match on the normalized location → substring match inside
  a space-padded copy of every stored location → the `default` profile with
  `matched: false` plus a disclaimer. Unmatched is never an error.
- **Math:** `hotel × nights × travelers` and
  `food/transport/activities × days × travelers`, with `nights = max(0, days - 1)`.
- **Failure:** a missing or broken catalog MUST NOT crash the agent or take down the
  dev stack (`concurrently -k` would). The process starts, `/health` reports
  `degraded` (§9), and each call fails with a non-retryable `INTERNAL` error. The
  registry entry is `required: false`, so the plan still completes and the UI shows
  the reason in place of the card.
- **Runtime:** built on Node's `node:sqlite` (`DatabaseSync`) — no third-party driver,
  hence `engines.node >= 24` (§5.1) and `node:24-bookworm-slim` in the container.
- **Contract:** `budgetSectionSchema` validates the payload; the agent re-parses its
  own result before returning, so an out-of-shape row fails loudly at the source.

### 17.5 HR Agent — port 8004

- **Role:** advisory leave check — "does this employee have enough balance for this
  trip?" Pure SQL against synthetic leave balances, **no model calls at all** (§11),
  so the answer is deterministic and never leaves the machine.
- **Skills:** `leave-status`.
- **Opt-in (two steps, no plan is affected otherwise):**
  1. The UI's **"Connect to HR portal"** control sets `requestHrValidation` on the
     plan input and reveals a **mandatory Employee ID** field (`/^E\d{4}$/i`,
     e.g. `E0001`) plus an optional employee name. It does *not* call HR — it only
     records the intent.
  2. Dispatch: the registry entry's `requiresField: "requestHrValidation"` gate (§17.0)
     lets the `hr` section through as a normal parallel section. Plans without the
     field never dispatch HR and have no `hr` section at all.
- **Inputs:** `sharedContext` (for the destination/travelers shown in progress) and the
  original `input` — `employeeId`/`employeeName`/`requestHrValidation`, forwarded by
  the same `sectionCallParamsSchema.input` path the budget agent uses (§17.4).
- **Identifier ladder:** canonical `employeeId` first (normalized to upper case), then
  a **unique** employee name as a fallback. Two employees sharing a name answer
  `ambiguous` with "supply an employee id" — the agent never guesses. An unknown id or
  name answers `not-found` naming the value.
- **Trip length:** `resolveDuration()` from `packages/shared/src/duration.ts`, the same
  source as the day grid and the budget, so all three agree.
- **Verdict:** `compliant` when `remainingDays - tripDays >= 0`, otherwise
  `insufficient-balance`; `balanceAfter` may be negative. The payload also carries the
  employee identity, department, entitlement/used/remaining days, `tripDays`, and
  disclaimers (advisory only; no leave is requested or booked).
- **Data:** `EMPLOYEE_DB` in `apps/agent-hr/src/catalog.ts` seeds `<repo>/data/hr.db`
  at startup, then reopens it **read-only** (deliberate duplicate name included, so the
  `ambiguous` path is real data rather than a hypothetical). Override with `HR_DB_PATH`;
  `npm run db:seed` re-seeds both agents' catalogs.
- **Failure (graceful by contract):** the reason MUST reach the itinerary. A missing or
  broken database does **not** crash the agent (`concurrently -k` would take the whole
  stack down) — the process boots, `/health` reports `degraded` (§9), and each call
  fails with a non-retryable `INTERNAL` error. Because the entry carries
  `warnOnFailure: true`, the orchestrator copies the reason into `plan.errors`, which
  merge into `itinerary.warnings`; the summary states
  "Leave status check unavailable: …" and the UI shows a "not checked" HR card.
  The plan itself still completes.
- **Presented as:** its own **Leave status** card (identity, entitlement/used/remaining,
  this trip, balance after, verdict badge) plus a one-line verdict inside the itinerary
  summary.
- **Runtime:** `node:sqlite` `DatabaseSync`, read-only — same constraints as §17.4
  (`engines.node >= 24`, `node:24-bookworm-slim`).
- **Contract:** `hrSectionSchema` validates the payload; `planInputSchema` rejects a
  malformed employee id at the BFF before a plan is ever created.

## 18. Development Setup And Commands

Required files:

- `.env.example` — `PLAN_STORE` (default `memory`), `AGENTS_REGISTRY_PATH`, `AGENT_*_BASE_URL` compose overrides, `WEATHER_PROVIDERS` (weather upstream chain, default `open-meteo,wttr`), `MODEL_PROVIDER`, `MODEL_*_PROVIDER`/`MODEL_*_MODEL` role overrides, `MODEL_FALLBACK_CHAIN`, `MODEL_TIMEOUT_MS` (per-call model deadline, default 60s), `PLAN_TIMEOUT_MS` (outer plan budget, default 300s), `COST_DB_PATH` (budget cost catalog, §17.4), `HR_DB_PATH` (HR leave balances, §17.5), `OLLAMA_BASE_URL`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, app URL, internal A2A credentials, and (future DB phase) `DATABASE_URL`.
- `AGENTS.md` — repository operating rules: formatting, type checks, tests, health checks, how to add an agent (§17.0), how to switch model providers (§6.1), how to run Docker Compose (§3.2), and (future DB phase) Prisma migrations.

Canonical commands (defined in the root `package.json`):

```bash
npm run dev            # web + all registry agents concurrently (host, hot reload)
npm run build          # typecheck + build all workspaces
npm run lint           # eslint + prettier --check
npm run typecheck      # tsc --noEmit across workspaces
npm run test           # vitest run
npm run test:e2e       # playwright
npm run agents:doctor  # registry/card/health verification (degraded counts as FAIL)
npm run db:seed        # (re)seed the budget + hr agents' read-only SQLite catalogs (§17.4, §17.5)
docker compose up --build          # containerized profile (Stage 0, §3.2)
docker compose --profile local up  # + Ollama service
npm run db:migrate     # FUTURE (DB phase only): prisma migrate, PLAN_STORE=prisma
```

## 19. Testing Strategy

Every agent and shared boundary MUST have the following coverage:

### Unit and schema tests

- Zod schemas: valid/invalid fixtures for cards, RPC envelopes, section payloads, weather-provider (open-meteo/wttr) and Wikipedia fixtures, model outputs.
- Input preflight (`tripInput.test.ts`): prose date and traveller parsing, text-vs-field
  precedence, nearest-occurrence year roll, and every blocking rule — with an injectable
  clock so the fixtures never go stale.
- Model adapter resolution: role routing, fallback chain, capability gating, output-retry policy — against a fake model server.

### Contract and integration tests

- Card shape + `/health` + `message/send` happy/error paths per agent (spawn on an ephemeral port).
- Weather-provider (open-meteo/wttr) and Wikipedia clients against recorded fixtures; no live calls in CI.
- SSE replay with `Last-Event-ID`.

### Agent fault matrix

| Fault | Expected behavior |
|---|---|
| Specialist unreachable | `AGENT_UNREACHABLE`; optional section degraded, plan completes |
| Specialist timeout | `AGENT_TIMEOUT` at section deadline; other sections unaffected |
| Section `deadlineMs` spent before a fallback could answer | retryable `MODEL_UNAVAILABLE` "budget exhausted" (remaining candidates skipped, §6.1); the destination agent still answers `grounded` with the raw extract when the budget runs out after Wikipedia |
| Malformed section payload | `INVALID_PARAMS`; plan degraded with warning |
| Weather provider 5xx / rate limit | bounded retry with backoff, then the next provider in `WEATHER_PROVIDERS`, else `UPSTREAM_RATE_LIMITED` degradation |
| Budget cost catalog missing or unwritable | agent still boots, `/health` → `degraded` → `agents:doctor` fails; each call returns non-retryable `INTERNAL`; plan completes without a cost card |
| Budget location not in the catalog | `matched: false`, the `default` profile is used, a disclaimer is shown — never an error |
| HR database missing or unwritable | agent still boots, `/health` → `degraded` → `agents:doctor` fails; each call returns non-retryable `INTERNAL`; `warnOnFailure` copies the reason to `plan.errors` → `itinerary.warnings`, the summary says "Leave status check unavailable", plan completes |
| Employee id unknown / name ambiguous | non-retryable `INVALID_PARAMS` naming the value; `warnOnFailure` surfaces it the same way — never a guess |
| Plan did not set `requestHrValidation` | the `requiresField` gate drops HR from dispatch: no `hr` section, no HR call, no HR row in progress |
| HR name lookup collides with another employee | `ambiguous` → "supply an employee id"; the mandatory id field exists precisely to avoid this |
| Trip length absent from intent and query | shared default of 3 days with `source: "default"` surfaced as a disclaimer in both the day grid and the budget card |
| Request has no dates, an inverted range, travelers outside 1–50, or (with HR connected) no employee id | preflight refuses to POST: no plan is created, no model call, no agent call, and the field carries the message |
| Wikipedia no result | `coverage: "ungrounded"`, plan completes |
| Model backend down | walk `MODEL_FALLBACK_CHAIN`, then `MODEL_UNAVAILABLE` → `plan.failed` |
| Model slower than `MODEL_TIMEOUT_MS` (default 60s/call) | per-call deadline fires → walk `MODEL_FALLBACK_CHAIN` (plan completes degraded if a fallback answers) |
| All stages exceed `PLAN_TIMEOUT_MS` (default 300s) | outer plan deadline aborts remaining work → `plan.failed` |
| Invalid model JSON | one schema-repair retry, then `MODEL_OUTPUT_INVALID` |
| Orchestrator restart mid-plan | `PLAN_STORE=prisma`: resumes from persisted `PlanState`, SSE replay works; `memory`: plan lost, UI shows recoverable error |

### End-to-end tests

Playwright against stub agents + fake model server: full journey (query → progress →
itinerary), cancel, retry a section, reconnect, and the "register a dummy agent at
runtime" extensibility check (§15).

## 20. Observability And Failure Logs

- Structured JSON logs (pino) with `planId`, `agent`, `section`, `requestId`, `durationMs` correlation on every hop.
- `AgentInvocation` records (§10.2) are the queryable record of cross-agent calls.
- Redaction: prompts, model outputs, personal data, API keys, and upstream payloads MUST NOT enter ordinary logs.
- Per-agent `/health` plus aggregate readiness via `agents:doctor` and the web health endpoint.
- Failure logs record stable error codes, retry attempts, and final disposition; user-facing messages stay safe and actionable (§12).

## 21. Delivery Checklist

- [ ] Monorepo scaffold, shared schemas, `PlanRepository` + memory store, `.env.example`, `AGENTS.md`
- [ ] Agent bootstrap (card, health, JSON-RPC) reused by all agents
- [ ] Agents on 8000/8001/8002 registered and discoverable; `agents:doctor` green
- [ ] Orchestrator state machine, registry-driven dispatch, SSE with in-process replay
- [ ] Weather via Open-Meteo (configurable `WEATHER_PROVIDERS` chain) with forecast-horizon honesty; destination via Wikipedia with sources
- [ ] ModelProvider with 5 adapters, role routing, fallback chain; provider switch verified
- [ ] Next.js UI: friendly input, live progress, itinerary summary, error/cancel/retry
- [ ] Fault-matrix tests, extensibility test, Playwright journey
- [ ] Docker Stage 0: multi-target Dockerfile, compose with healthchecks, non-root images, `AGENT_*_BASE_URL` overrides, only 3000 published
- [ ] Acceptance run of §15 (skeleton, `PLAN_STORE=memory`)
- [ ] *(Future DB phase, §10)* Prisma schema + migrations (Plan, PlanEvent, AgentInvocation), `PrismaPlanRepository`, compose named volume, restart-resume acceptance

## 22. Source Independence

This document contains the complete product, technical, operational, security, testing, and acceptance requirements. The notebook and previously created template files are historical references only and are not required dependencies for implementation.
