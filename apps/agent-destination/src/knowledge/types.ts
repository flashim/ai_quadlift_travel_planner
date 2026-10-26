import { z } from "zod";

/** Options every knowledge hop receives — the §6.2 fetch layer enforces them. */
export interface KnowledgeFetchOpts {
  userAgent: string;
  /** Total budget for this hop (search or extract), sliced from the section deadline. */
  timeoutMs?: number;
}

/** One resolved article (search hit or destination baseline). */
export interface KnowledgeArticle {
  provider: string;
  title: string;
  url: string;
  extract: string;
}

/** One search result — titles + snippets are what the model sees (§6.1). */
export interface KnowledgeSearchHit {
  provider: string;
  title: string;
  url: string;
  snippet?: string;
}

/**
 * A knowledge source the destination agent may consult (§17.2). Implementations
 * are stateless: all SSRF/timeout/backoff/cache guarantees come from the shared
 * `fetchJson` layer (§6.2).
 */
export interface KnowledgeProvider {
  /** Registry name — also the `source` value the model passes to the tools. */
  readonly name: string;
  /** `srsearch`-style lookup; empty array when nothing matched. */
  search(query: string, opts: KnowledgeFetchOpts): Promise<KnowledgeSearchHit[]>;
  /** Exact-title extract; `null` when the source has no such article. */
  fetchArticle(title: string, opts: KnowledgeFetchOpts): Promise<KnowledgeArticle | null>;
}

/** Action-API `list=search` payload (Wikivoyage + Wikipedia). */
export const actionSearchSchema = z.object({
  query: z
    .object({
      search: z
        .array(z.object({ title: z.string(), snippet: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

/** Strip the `<span class="searchmatch">` markup search snippets come wrapped in. */
export function plainSnippet(snippet?: string): string | undefined {
  if (!snippet) return undefined;
  const plain = snippet
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  return plain || undefined;
}

/** Canonical wiki article URL for a title. */
export function wikiUrl(host: string, title: string): string {
  return `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
