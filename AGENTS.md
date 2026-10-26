# AGENTS.md — repository operating rules

Monorepo for the multi-agent travel planner. See `ARCHITECTURE.md` for the full
specification; this file is the day-to-day operating manual.

## Commands

```bash
npm install              # workspace install
npm run dev              # web (3000) + orchestrator (8000) + agents (8001/8002/8003/8004)
npm run teardown         # stop every service, free 3000/8000/8001/8002/8003/8004
npm run teardown -- --docker  # + docker compose down
npm run typecheck        # tsc --noEmit in every workspace
npm run lint             # eslint .
npm test                 # vitest (schemas, registry, model router, agent contracts)
npm run build            # typecheck + next build
npm run agents:doctor    # fetch every agent card + /health, exit non-zero on failure
                         # (any status other than "ok", including "degraded")
npm run db:seed          # (re)seed the budget + hr agents' read-only cost catalogs (§17.4, §17.5)
docker compose up --build  # containerized profile (ARCHITECTURE §3.2)
```

`npm run dev`/`npm run start` run `scripts/teardown.sh` first (`predev`/`prestart`),
so a stale stack is stopped instead of failing with `EADDRINUSE`. The script only
kills processes owned by this checkout; a foreign process on the port aborts the
start with a clear error (exit 1) instead of touching it.

## Layout

- `apps/web` — Next.js UI + Plan API BFF (SSE proxy)
- `apps/orchestrator` — plan state machine, registry dispatch, synthesis (port 8000)
- `apps/agent-destination` — Wikipedia research (8001)
- `apps/agent-weather` — wttr.in forecast (8002)
- `apps/agent-budget` — seeded SQLite cost catalog, **no model calls** (8003)
- `apps/agent-hr` — seeded SQLite leave balances, **no model calls**, opt-in via
  `requiresField` (8004)
- `packages/shared` — Zod schemas, A2A server/client, registry loader,
  `PlanRepository` (§10), `ModelProvider` layer (§6.1)
- `config/agents.json` — agent registry (source of truth for delegation)

## Rules

- All cross-service payloads go through Zod schemas in `packages/shared`; agents are
  stateless and MUST NOT touch the plan store.
- Never hardcode agent URLs — read the registry (`loadRegistry()`), which honours the
  `AGENT_<NAME>_BASE_URL` override used by Docker Compose.
- All LLM access goes through `ModelRouter` (role routing + fallback chain). Never call
  a model HTTP API directly from an app.
- Client components import `@travel/shared/schemas` or `@travel/shared/tripInput`, never
  the package root — the root pulls fastify and node built-ins into the browser bundle.
- Validate before you send: the UI runs `preflightTripInput()` in the browser ahead of
  `POST /api/plans`, so an incomplete or impossible request never reaches the intent
  model or an agent (ARCHITECTURE §13).
- `.env` and `*.db` are gitignored; commit only `.env.example`.

## Adding an agent (ARCHITECTURE §17.0)

1. `apps/agent-<name>` using `createAgentServer` (card + `/health` + JSON-RPC).
2. Section schemas in `packages/shared/src/schemas`.
3. Registry entry in `config/agents.json` with a port from 8001–8049. Add
   `requiresField` when the section must stay out of plans that did not opt in, and
   `warnOnFailure` when its failure reason must be shown to the user (§17.5).
4. Contract test (happy path + malformed params).
5. Document it in `ARCHITECTURE.md` §17.

An agent MUST NOT touch the plan store; it MAY keep its own read-only reference
data (the budget agent's `COST_DB` and the hr agent's `EMPLOYEE_DB` are the
templates, §17.4 / §17.5).

## Switching model providers (ARCHITECTURE §6.1)

```bash
MODEL_PROVIDER=ollama   # local default
MODEL_PROVIDER=groq GROQ_API_KEY=... MODEL_MODEL=openai/gpt-oss-20b
MODEL_PROVIDER=openai OPENAI_API_KEY=... MODEL_MODEL=gpt-4o-mini
MODEL_FALLBACK_CHAIN=ollama,mock   # mock keeps the skeleton runnable offline
# per-role: MODEL_INTENT_PROVIDER / MODEL_RESEARCH_PROVIDER / MODEL_SYNTHESIS_PROVIDER
# or pick a model per plan at runtime in the UI header (no restart; uses /api/meta catalog)
```

## Verifying a change

```bash
npm run typecheck && npm run lint && npm test
npm run agents:doctor   # with npm run dev running in another terminal
```
