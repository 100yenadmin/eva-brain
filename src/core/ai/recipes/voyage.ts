import type { Recipe } from '../types.ts';

/**
 * Voyage AI exposes an OpenAI-compatible /embeddings endpoint.
 * Base URL: https://api.voyageai.com/v1
 */
export const voyage: Recipe = {
  id: 'voyage',
  name: 'Voyage AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.voyageai.com/v1',
  auth_env: {
    required: ['VOYAGE_API_KEY'],
    setup_url: 'https://dash.voyageai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      // eva-brain's production path uses a 1024-dimensional schema. voyage-3-lite
      // returns 512 dimensions and is intentionally excluded from the default
      // supported list until per-model dimensions are exposed in provider config.
      models: ['voyage-3-large', 'voyage-3'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.18,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
