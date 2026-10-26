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

const HOST = "en.wikivoyage.org";

const extractsSchema = z.object({
  query: z
    .object({
      pages: z
        .record(
          z.object({
            title: z.string().optional(),
            extract: z.string().optional(),
            missing: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * Wikivoyage (primary research source, §17.2): Action API search + intro
 * extract through the shared §6.2 fetch layer. Destinations without an article
 * are a `null` — the chain then falls through to the next source.
 */
export const wikivoyage: KnowledgeProvider = {
  name: "wikivoyage",

  async search(query, opts: KnowledgeFetchOpts): Promise<KnowledgeSearchHit[]> {
    const url =
      `https://${HOST}/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=` +
      encodeURIComponent(query);
    const body = (await fetchJson(url, {
      provider: "wikivoyage",
      userAgent: opts.userAgent,
      allowedHosts: [HOST],
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      schema: actionSearchSchema,
    })) as z.infer<typeof actionSearchSchema>;
    return (body.query?.search ?? []).map((hit) => {
      const snippet = plainSnippet(hit.snippet);
      return {
        provider: "wikivoyage",
        title: hit.title,
        url: wikiUrl(HOST, hit.title),
        ...(snippet !== undefined ? { snippet } : {}),
      };
    });
  },

  async fetchArticle(title, opts): Promise<KnowledgeArticle | null> {
    const url =
      `https://${HOST}/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json` +
      `&exlimit=1&titles=${encodeURIComponent(title)}`;
    const body = (await fetchJson(url, {
      provider: "wikivoyage",
      userAgent: opts.userAgent,
      allowedHosts: [HOST],
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      schema: extractsSchema,
    })) as z.infer<typeof extractsSchema>;
    const pages = body.query?.pages ?? {};
    const page = Object.values(pages)[0];
    const extract = (page?.extract ?? "").trim();
    if (!extract) return null; // no such article (missing page) — degrade, don't fail
    const resolvedTitle = page?.title ?? title;
    return {
      provider: "wikivoyage",
      title: resolvedTitle,
      url: wikiUrl(HOST, resolvedTitle),
      extract,
    };
  },
};
