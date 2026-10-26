# syntax=docker/dockerfile:1
# Multi-stage, one build target per service (ARCHITECTURE §3.2).
#   docker build --target orchestrator -t travel-orchestrator .
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV CI=true

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/agent-destination/package.json apps/agent-destination/
COPY apps/agent-weather/package.json apps/agent-weather/
COPY apps/agent-budget/package.json apps/agent-budget/
COPY apps/agent-hr/package.json apps/agent-hr/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build -w @travel/web

# --- runtime targets ---

FROM build AS web
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@travel/web"]

FROM build AS orchestrator
ENV NODE_ENV=production ORCHESTRATOR_PORT=8000
EXPOSE 8000
CMD ["npx", "tsx", "apps/orchestrator/src/index.ts"]

FROM build AS agent-destination
ENV NODE_ENV=production AGENT_DESTINATION_PORT=8001
EXPOSE 8001
CMD ["npx", "tsx", "apps/agent-destination/src/index.ts"]

FROM build AS agent-weather
ENV NODE_ENV=production AGENT_WEATHER_PORT=8002
EXPOSE 8002
CMD ["npx", "tsx", "apps/agent-weather/src/index.ts"]

FROM build AS agent-budget
ENV NODE_ENV=production AGENT_BUDGET_PORT=8003 COST_DB_PATH=/app/data/costs.db
EXPOSE 8003
CMD ["npx", "tsx", "apps/agent-budget/src/index.ts"]

FROM build AS agent-hr
ENV NODE_ENV=production AGENT_HR_PORT=8004 HR_DB_PATH=/app/data/hr.db
EXPOSE 8004
CMD ["npx", "tsx", "apps/agent-hr/src/index.ts"]
