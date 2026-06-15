import { makeS3SentimentFetcher } from "./actions/_s3SentimentFetcher.ts";

export interface LatestSentiment {
  value: number; // composite sentiment, typically [-1, 1]
  ts: number;    // ms epoch of the latest scored bucket
}

interface SentiBody {
  sentiScores?: Array<{ time: number; value: number; total?: number }>;
}

/**
 * Pure reducer: pick the score with the greatest `time` (seconds epoch) and
 * return it in ms. Exported for unit testing without S3.
 */
export function extractLatestSentiment(body: SentiBody): LatestSentiment | null {
  const scores = body?.sentiScores;
  if (!Array.isArray(scores) || scores.length === 0) return null;
  let best = scores[0];
  for (const s of scores) if (s.time > best.time) best = s;
  return { value: best.value, ts: best.time * 1000 };
}

const cryptoNewsFetcher = makeS3SentimentFetcher({
  prefix: "crypto_news/",
  symbolMode: "per-symbol",
});

/**
 * Fetch the latest crypto-news sentiment for a base asset (e.g. "BTC").
 * Reuses the existing S3 fetcher. Returns null on any error or no data — the
 * caller (strategy engine) treats null as a missing/stale signal and skips.
 */
export async function getLatestSentiment(symbol: string): Promise<LatestSentiment | null> {
  try {
    const req = new Request("https://internal/sentiment");
    const res = await cryptoNewsFetcher(req as never, { params: { symbol } } as never);
    if (!res || !(res as Response).ok) return null;
    const body = (await (res as Response).json()) as SentiBody;
    return extractLatestSentiment(body);
  } catch {
    return null;
  }
}
