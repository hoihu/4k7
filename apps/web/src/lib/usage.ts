import type { TokenCount } from '@tracewise/schema';

/** "48.2k" */
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** Tokens in (of them from the prompt cache) and out, and the cost ("~" while it is an estimate; none if unknown). */
export function usageLine(t: TokenCount, costUsd = 0, exact = false): string {
  const inTotal = t.input + t.cacheRead + t.cacheWrite;
  const cost = costUsd > 0 ? ` · ${exact ? '' : '~'}$${costUsd.toFixed(costUsd < 0.1 ? 3 : 2)}` : '';
  return `↑ ${k(inTotal)} in${t.cacheRead ? ` (${k(t.cacheRead)} cached)` : ''} · ↓ ${k(t.output)} out${cost}`;
}

export const USAGE_TITLE = 'Tokens used (all model calls). The cost is the API price; on a Claude subscription it is not billed per token.';
