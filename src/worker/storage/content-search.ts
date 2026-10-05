import { requireDataBucket } from "./r2";
import { getBin, listBins, type BinRecord } from "./bins";
import { isExpired } from "./bin-state";

export type ContentMatch = {
  binId: string;
  name: string;
  path: string;
  matchType: "key" | "value";
  snippet: string;
};

export type ContentSearchResult = {
  items: ContentMatch[];
  total: number;
};

const MAX_BINS_SCANNED = 100;
const MAX_READ_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_DEPTH = 64;
const MAX_NODES_PER_BIN = 10000;

export async function searchJsonContent(
  env: Env,
  query: string,
  mode: "keys" | "all" = "all",
): Promise<ContentSearchResult> {
  const q = query.trim().toLowerCase();
  if (!q) return { items: [], total: 0 };

  const allBins = await listBins(env);
  const eligibleBins = allBins.filter(
    (b) =>
      b.contentSearchMode &&
      b.contentSearchMode !== "off" &&
      (mode === "keys" || b.contentSearchMode === "all" || b.contentSearchMode === "keys") &&
      !isExpired(b, Date.now()) &&
      !b.deletedAt,
  );

  if (eligibleBins.length > MAX_BINS_SCANNED) {
    throw new Error("content_search_limit_exceeded");
  }

  let totalBytes = 0;
  const matches: ContentMatch[] = [];

  // Limit concurrency to 8
  const concurrency = 8;
  for (let i = 0; i < eligibleBins.length; i += concurrency) {
    const chunk = eligibleBins.slice(i, i + concurrency);
    const records = await Promise.all(chunk.map((b) => getBin(env, b.id)));

    for (const record of records) {
      if (!record || !record.value) continue;

      totalBytes += record.meta.size;
      if (totalBytes > MAX_READ_BYTES) {
        throw new Error("content_search_limit_exceeded");
      }

      const effectiveMode =
        mode === "keys" || record.meta.contentSearchMode === "keys" ? "keys" : "all";

      let nodeCount = 0;

      function traverse(val: unknown, currentPath: string, depth: number) {
        if (depth > MAX_DEPTH) return;
        nodeCount++;
        if (nodeCount > MAX_NODES_PER_BIN) {
          throw new Error("content_search_limit_exceeded");
        }

        if (val === null || val === undefined) return;

        if (typeof val === "object") {
          if (Array.isArray(val)) {
            for (let idx = 0; idx < val.length; idx++) {
              traverse(val[idx], `${currentPath}/${idx}`, depth + 1);
            }
          } else {
            for (const [k, v] of Object.entries(val)) {
              const nextPath = `${currentPath}/${k}`;
              // Check object key
              if (k.toLowerCase().includes(q)) {
                matches.push({
                  binId: record!.meta.id,
                  name: record!.meta.name,
                  path: nextPath,
                  matchType: "key",
                  snippet: k.slice(0, 120),
                });
              }
              traverse(v, nextPath, depth + 1);
            }
          }
        } else if (effectiveMode === "all") {
          // Check scalar value
          const str = String(val);
          if (str.toLowerCase().includes(q)) {
            matches.push({
              binId: record!.meta.id,
              name: record!.meta.name,
              path: currentPath,
              matchType: "value",
              snippet: str.slice(0, 120),
            });
          }
        }
      }

      traverse(record.value, "", 0);
    }
  }

  return {
    items: matches,
    total: matches.length,
  };
}
