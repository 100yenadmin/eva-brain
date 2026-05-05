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
      // Voyage 4/3.5/code models support output_dimension values including 2048.
      models: ['voyage-4-large', 'voyage-4', 'voyage-4-lite', 'voyage-code-3', 'voyage-3.5', 'voyage-3.5-lite', 'voyage-3-large', 'voyage-3'],
      default_dims: 2048,
      cost_per_1m_tokens_usd: 0.18,
      price_last_verified: '2026-05-05',
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
