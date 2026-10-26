# Travel Planner

A multi-agent travel planner. You describe a trip in plain language; a Next.js UI asks an
orchestrator to research the destination (Wikivoyage/Wikipedia), pull a forecast
(open-meteo → OpenWeather → Tomorrow.io → wttr.in), price it from a local cost catalog,
optionally check your HR leave balance, and synthesize a day-by-day itinerary.

Everything after the UI is plain HTTP + JSON-RPC over A2A agent cards — no framework
magic. Each specialist is an independent service that owns one section of the plan.

| Service | Port | What it does |
|---|---|---|
| `apps/web` | 3000 | Next.js UI + Plan API BFF (SSE proxy) |
| `apps/orchestrator` | 8000 | Plan state machine, registry dispatch, synthesis |
| `apps/agent-destination` | 8001 | Wikivoyage/Wikipedia research |
| `apps/agent-weather` | 8002 | Forecast with graceful provider fallback |
| `apps/agent-budget` | 8003 | Read-only SQLite cost catalog, no model calls |
| `apps/agent-hr` | 8004 | Read-only leave balances, opt-in, no model calls |

`config/agents.json` is the source of truth for which agents exist and how they are
reached; the shared Zod schemas in `packages/shared` are the contract between all of them.

## See it in action

[**Voyage — Multi-Agent Travel Planner.pdf**](./Voyage%20%E2%80%94%20Multi-Agent%20Travel%20Planner.pdf)
— a 7-page print of one live run in a browser:

- **p1** the request form: query with example prompts, date and traveller controls, the
  input-preflight hint, and the optional "Connect to HR portal" panel;
- **p2–3** the finished itinerary: summary and meta line, the weather strip with its
  coverage warnings, the "About Europe" research extract, the cost estimate, and the
  leave-status card;
- **p3–6** the day-by-day plan (morning / afternoon / evening per day);
- **p6–7** warnings, assumptions, and the sources the plan was grounded on.

It is an honest capture, degradation warnings and all — the run it shows fell through
to the offline `mock` model and had no OpenWeather/Tomorrow keys, so you can see what a
partially-configured install looks like before you change a single variable.

## Prerequisites

- **Node.js ≥ 24** and npm (the agents use the built-in `node:sqlite`; no native deps).
- **Free ports** `3000` and `8000`–`8004`.
- **A model backend is optional.** Any of: local Ollama, a Groq/OpenAI/Anthropic/Gemini
  key, or neither — the `mock` fallback keeps the whole skeleton runnable offline and
  labels its output as a draft.
- Internet access is only needed for live Wikipedia/wttr.in data; both sections degrade
  to warnings when offline.

## Quick start

```bash
# 1. install the workspace
npm install

# 2. configure — optional; every variable has a working default
cp .env.example .env
# edit .env only if you want a cloud model (e.g. GROQ_API_KEY=...)

# 3. run everything (web + orchestrator + all four agents)
npm run dev

# 4. in a second terminal — verify every agent card and /health
npm run agents:doctor              # 5 rows, all "ok", exit code 0
```

Open <http://localhost:3000> and describe a trip.

Notes:

- `npm run dev` runs `scripts/teardown.sh` first, so a stale stack is stopped for you.
  A port occupied by a *foreign* process aborts the start with a clear error instead of
  killing it.
- The budget and HR agents **seed their own SQLite catalogs on first start** —
  `npm run db:seed` is only needed to rebuild them from scratch.
- Stop everything with `npm run teardown` (add `-- --docker` to also
  `docker compose down`).

## Choosing a model

`.env` ships with the local-first default and a safety chain:

```bash
MODEL_PROVIDER=ollama                      # ollama | groq | openai | anthropic | gemini | mock
MODEL_FALLBACK_CHAIN=ollama,groq,mock      # walked in order when a provider fails/times out
MODEL_TIMEOUT_MS=60000                     # per-call deadline that triggers the next candidate
```

- **No hardware?** Set `GROQ_API_KEY=…` and Groq answers every role; its live model list
  also appears in the UI's model picker.
- **No keys either?** The chain lands on `mock` and the plan still completes, clearly
  marked as an offline draft.
- Per-role overrides (`MODEL_INTENT_PROVIDER`, `MODEL_RESEARCH_PROVIDER`,
  `MODEL_SYNTHESIS_PROVIDER`) and the header picker let you switch models **per plan,
  without restarting**.

## Using the app

1. **Describe the trip in prose.** Dates and counts in free text are understood:
   `"Plan a family trip to Kyoto for four, first week of December, temples and food"`.
2. **Review what the app understood.** Before anything is sent, the input preflight
   (ARCHITECTURE §13) parses prose dates (`5–8 December`, `early December`,
   `December 2027`) and traveller counts (`solo`, `couple of us`, `family of four`) —
   a month without a year resolves to the nearest upcoming occurrence, and an explicit
   count in the text overrides the travellers field. Every assumption is shown as a note.
3. **Missing essentials stop the submit** with the message on the offending field: no
   dates, an end date before the start, a trip longer than 30 days, a start already in
   the past, travellers outside 1–50, or (with HR connected) a missing/malformed
   employee id. Nothing is created and no model or agent is called.
4. **Watch the progress rows**: parsing → destination → weather → budget → (HR) →
   composing. `Cancel` appears while the plan runs and aborts the remaining stages.
5. **Read the itinerary**: summary, day cards, weather strip with coverage notes, cost
   estimate in USD + local currency, sources with timestamps, assumptions and warnings.

### Optional: HR leave check

Toggle **"Connect to HR portal"** and enter an employee id (`E` + 4 digits) — the
synthetic catalog is `E0001`–`E0013`:

- `E0001` (Ada Lovelace, 20 days remaining) → a five-day trip is **compliant**.
- `E0002` (Grace Hopper, 2 days remaining) → **insufficient balance**, shown as a
  warning, never a failure.
- Unknown id → a 400 that names the value; the plan is not created.

## Commands

```bash
npm run dev            # web + orchestrator + all agents (hot reload)
npm run start          # same, from an existing `npm run build`
npm run teardown       # stop every service and free the ports
npm run db:seed        # (re)seed the budget + hr read-only catalogs
npm run agents:doctor  # fetch every agent card + /health; non-zero on any failure
npm run typecheck      # tsc --noEmit across every workspace
npm run lint           # eslint .
npm test               # vitest — schemas, registry, model router, agent contracts
npm run build          # typecheck + next build (stop `npm run dev` first)
docker compose up --build                      # containerized profile (§3.2)
docker compose --profile local up              # + an Ollama service
```

`npm run build` and the dev stack must not run at the same time — the build overwrites
`.next/` while the dev server is serving from it.

## Configuration

`.env.example` documents every variable. The ones that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web port; agents use `AGENT_*_PORT` (8001–8004) |
| `AGENTS_REGISTRY_PATH` | `./config/agents.json` | Which agents exist and where |
| `AGENT_*_BASE_URL` | per registry entry | Override to retarget an agent (used by Compose) |
| `WEATHER_PROVIDERS` | `open-meteo,openweather,tomorrow,wttr` | Provider fallback chain |
| `KNOWLEDGE_PROVIDERS` | `wikivoyage,wikipedia` | Research source order |
| `MODEL_PROVIDER` / `MODEL_FALLBACK_CHAIN` | `ollama` / `ollama,groq,mock` | Model routing (§6.1) |
| `PLAN_TIMEOUT_MS` | `300000` | Outer plan budget; per-section deadlines are smaller |
| `COST_DB_PATH` / `HR_DB_PATH` | `./data/*.db` | Read-only agent catalogs |
| `PLAN_STORE` | `memory` | `memory` (default) or the future `prisma` phase |

Services load the repo-root `.env` themselves, so `cp .env.example .env` is a starting
point rather than a requirement.

## Docker

```bash
docker compose up --build   # only 3000 is published; the rest stay on the compose network
```

The compose file injects `AGENT_*_BASE_URL` overrides pointing at the container names and
keeps the SQLite catalogs in named volumes (`budget-data`, `hr-data`). Point
`OLLAMA_BASE_URL` at `http://host.docker.internal:11434` to use an Ollama running on the
host, or `docker compose --profile local up` to run one in a container.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on start | `npm run teardown`; a foreign process on 3000/8000–8004 aborts the start on purpose |
| `agents:doctor` exits non-zero, `/health` is `degraded` | An agent's SQLite catalog is missing or unwritable — run `npm run db:seed` |
| Every itinerary says "offline mock" | No reachable model backend: run Ollama, or set `GROQ_API_KEY` |
| A plan id returns 404 | The store is in-memory by default; ids do not survive a restart |
| Weather card warns about the date range | The forecast horizon is ~16 days; the nearest available days are shown |
| Destination card says `ungrounded` | Wikipedia/Wikivoyage returned nothing; the rest of the plan is unaffected |
| A section failed but the plan completed | Expected: specialists are optional, and failures surface as itinerary warnings |

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the full specification: system context (§3),
  model layer (§6), UI/API contract and input preflight (§13), agent contracts (§17),
  testing strategy (§19).
- [`AGENTS.md`](./AGENTS.md) — repository operating rules: how to run, verify, and add
  a new agent without touching the ones that already work.
