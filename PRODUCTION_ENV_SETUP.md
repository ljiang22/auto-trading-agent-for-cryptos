# Production Environment Variables Setup

This project now supports production-specific environment variables to ensure secure separation between development and production API keys.

## How It Works

The system automatically detects when `NODE_ENV=production` and uses production-prefixed environment variables when available, falling back to regular environment variables if production ones aren't set.

## Environment Variable Priority

1. **Production Mode** (`NODE_ENV=production`):
   - First tries: `PRODUCTION_VARIABLE_NAME`
   - Falls back to: `VARIABLE_NAME`

2. **Development Mode** (default):
   - Uses: `VARIABLE_NAME`

## Configuration

### 1. Set NODE_ENV for Production
```bash
export NODE_ENV=production
```

### 2. Configure Production API Keys

Add these environment variables for production:

```bash
# CoinMarketCap API
PRODUCTION_COINMARKETCAP_API_KEY=your_production_coinmarketcap_api_key

# News API
PRODUCTION_NEWS_API_KEY=your_production_news_api_key

# ElevenLabs TTS API
PRODUCTION_ELEVENLABS_XI_API_KEY=your_production_elevenlabs_api_key
PRODUCTION_ELEVENLABS_VOICE_ID=your_production_voice_id
PRODUCTION_ELEVENLABS_MODEL_ID=eleven_multilingual_v2
PRODUCTION_ELEVENLABS_VOICE_STABILITY=0.5
PRODUCTION_ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
PRODUCTION_ELEVENLABS_VOICE_STYLE=0.66

# OpenAI API
PRODUCTION_OPENAI_API_KEY=your_production_openai_api_key

# Twitter API
PRODUCTION_TWITTER_USERNAME=your_production_twitter_username
PRODUCTION_TWITTER_PASSWORD=your_production_twitter_password
PRODUCTION_TWITTER_EMAIL=your_production_twitter_email

# GitHub API
PRODUCTION_GITHUB_ACCESS_TOKEN=your_production_github_token
```

### 3. Fallback Development Keys

Keep your development keys as regular environment variables:

```bash
# Development fallbacks
COINMARKETCAP_API_KEY=your_dev_coinmarketcap_api_key
NEWS_API_KEY=your_dev_news_api_key
ELEVENLABS_XI_API_KEY=your_dev_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_dev_voice_id
OPENAI_API_KEY=your_dev_openai_api_key
# ... etc
```

## Updated Files

The following files have been updated to use production environment variables:

- `packages/plugin-fearandindex_analysis/src/actions/get_data.ts`
- `packages/plugin-charts/src/actions/detailed_fear_index.ts`
- `packages/plugin-charts/src/actions/get_fear_index.ts`
- `packages/plugin-news/src/providers/news.ts`
- `packages/plugin-sentimentanalysis_tweets/src/providers/news.ts`

## Utility Function

A new utility function `getProductionEnvVariable()` has been added to `packages/core/src/settings.ts` to handle the production environment variable logic:

```typescript
import { getProductionEnvVariable } from "@elizaos/core";

// This will use PRODUCTION_API_KEY in production, API_KEY otherwise
const apiKey = getProductionEnvVariable('API_KEY');
```

## Benefits

1. **Security**: Separate production and development credentials
2. **Safety**: No risk of using development keys in production
3. **Flexibility**: Easy to switch between environments
4. **Backwards Compatible**: Existing setups continue to work
5. **Clean Fallback**: Production keys are optional - falls back to regular keys

## Deployment

When deploying to production:

1. Set `NODE_ENV=production`
2. Configure all `PRODUCTION_*` environment variables
3. Regular environment variables serve as fallbacks

The system will automatically use the appropriate keys based on the environment. 