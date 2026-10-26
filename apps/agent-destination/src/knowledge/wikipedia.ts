import { z } from "zod";
import { fetchJson } from "@travel/shared";
import {
  actionSearchSchema,
  plainSnippet,
  wikiUrl,
  type KnowledgeArticle,
  type KnowledgeFetchOpts,
  type KnowledgeProvider,
  type KnowledgeSearchHit,
} from "./types";

const HOST = "en.wikipedia.org";

const summarySchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  extract: z.string().optional(),
  content_urls: z
    .object({
      desktop: z.object({ page: z.string().optional() }).optional(),
    })
    .optional(),
});

/**
 * Wikipedia (secondary research source, §17.2): Action API title resolution +
 * REST summary extract through the shared §6.2 fetch layer. A descriptive
 * User-Agent is required by Wikimedia policy.
 */
export const wikipedia: KnowledgeProvider = {
  name: "wikipedia",

  async search(query, opts: KnowledgeFetchOpts): Promise<KnowledgeSearchHit[]> {
    const url =
      `https://${HOST}/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=` +
      encodeURIComponent(query);
    const body = (await fetchJson(url, {
      provider: "wikipedia",
      userAgent: opts.userAgent,
      allowedHosts: [HOST],
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      schema: actionSearchSchema,
    })) as z.infer<typeof actionSearchSchema>;
    return (body.query?.search ?? []).map((hit) => {
      const snippet = plainSnippet(hit.snippet);
      return {
        provider: "wikipedia",
        title: hit.title,
        url: wikiUrl(HOST, hit.title),
        ...(snippet !== undefined ? { snippet } : {}),
      };
    });
  },

  async fetchArticle(title, opts): Promise<KnowledgeArticle | null> {
    // REST summary resolves redirects server-side — one hop per fetch (§17.2).
    const url = `https://${HOST}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    let body: unknown;
    try {
      body = await fetchJson(url, {
        provider: "wikipedia",
        userAgent: opts.userAgent,
        allowedHosts: [HOST],
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        schema: summarySchema,
        maxAttempts: 2,
      });
    } catch (err) {
      if (err && typeof err === "object" && "data" in err) {
        const status = (err as { data?: { status?: number } }).data?.status;
        // 404 = no such article — a legitimate miss, not a broken upstream.
        if (status === 404) return null;
      }
      throw err;
    }
    const parsed = body as z.infer<typeof summarySchema>;
    const extract = (parsed.extract ?? "").trim();
    if (!extract) return null;
    const resolvedTitle = parsed.title ?? title;
    return {
      provider: "wikipedia",
      title: resolvedTitle,
      url:
        parsed.content_urls?.desktop?.page ?? wikiUrl(HOST, resolvedTitle),
      extract,
    };
  },
};
