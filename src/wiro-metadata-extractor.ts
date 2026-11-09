import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { SharedV4ProviderMetadata } from '@ai-sdk/provider';

/**
 * Reads `usage.cost`, the amount Wiro billed for the call in USD, from a
 * response body or a stream chunk.
 */
function readCost(value: unknown): number | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (usage == null || typeof usage !== 'object') return undefined;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

function toProviderMetadata(cost: number | undefined): SharedV4ProviderMetadata | undefined {
  return cost === undefined ? undefined : { wiro: { cost } };
}

/**
 * Puts the billed amount of each call in `providerMetadata.wiro.cost`. A
 * streamed call reports it in the last chunk, together with the token usage.
 */
export const wiroMetadataExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => toProviderMetadata(readCost(parsedBody)),

  createStreamExtractor: () => {
    let cost: number | undefined;

    return {
      processChunk(parsedChunk) {
        const chunkCost = readCost(parsedChunk);
        if (chunkCost !== undefined) cost = chunkCost;
      },
      buildMetadata: () => toProviderMetadata(cost),
    };
  },
};
