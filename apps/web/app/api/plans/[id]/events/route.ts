import { loadEnv } from "@travel/shared";

// Next resolves env files from apps/web; the repo-root .env is ours to load.
loadEnv();

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

/** SSE proxy: browser ↔ web BFF ↔ orchestrator (avoids cross-origin EventSource). */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const upstream = new URL(`${ORCHESTRATOR_URL}/plans/${id}/events`);

  const lastEventId = req.headers.get("last-event-id");
  const sinceParam = new URL(req.url).searchParams.get("since");
  const since = lastEventId ?? sinceParam;
  if (since) upstream.searchParams.set("since", since);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      headers: { accept: "text/event-stream" },
      signal: req.signal,
    });
  } catch {
    return new Response("orchestrator unreachable", { status: 502 });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    return new Response("event stream unavailable", { status: 502 });
  }

  const reader = upstreamRes.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
