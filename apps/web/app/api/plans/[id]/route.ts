import { NextResponse } from "next/server";
import { loadEnv } from "@travel/shared";

// Next resolves env files from apps/web; the repo-root .env is ours to load.
loadEnv();

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://localhost:8000";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const res = await fetch(ORCHESTRATOR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "orchestrator/plan:get",
        params: { taskId: id },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: { plan: unknown }; error?: { message?: string; data?: { code?: string } } }
      | null;
    if (!body?.result) {
      const code = body?.error?.data?.code ?? "ORCHESTRATOR_ERROR";
      return NextResponse.json({ error: code }, { status: code === "PLAN_NOT_FOUND" ? 404 : 502 });
    }
    return NextResponse.json(body.result);
  } catch {
    return NextResponse.json({ error: "ORCHESTRATOR_UNREACHABLE" }, { status: 502 });
  }
}
