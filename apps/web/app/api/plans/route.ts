import { NextResponse } from "next/server";
import { loadEnv, planInputSchema } from "@travel/shared";

// Next resolves env files from apps/web; the repo-root .env is ours to load.
loadEnv();

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://localhost:8000";

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = planInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "INVALID_INPUT",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  let res: Response;
  try {
    res = await fetch(ORCHESTRATOR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message/send",
        params: { input: parsed.data },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "ORCHESTRATOR_UNREACHABLE" }, { status: 502 });
  }

  const body = (await res.json().catch(() => null)) as
    | { result?: { taskId: string; status: string }; error?: { message?: string } }
    | null;

  if (!res.ok || !body?.result) {
    return NextResponse.json(
      { error: body?.error?.message ?? "ORCHESTRATOR_ERROR" },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      taskId: body.result.taskId,
      status: body.result.status,
      eventStream: `/api/plans/${body.result.taskId}/events`,
    },
    { status: 202 },
  );
}
