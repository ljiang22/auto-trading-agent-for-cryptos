# Model Fallback Feature

## Overview

The Model Fallback feature provides automatic redundancy for LLM model providers. When the primary model provider fails due to rate limits, service outages, or authentication errors, the system automatically switches to a configured fallback provider to ensure uninterrupted service.

## How It Works

### Automatic Detection
The system monitors for specific error conditions that warrant a fallback:

- **Rate Limiting**: HTTP 429 errors, "rate limit" messages, "quota exceeded" errors
- **Authentication Failures**: HTTP 401 errors, "unauthorized" messages, "invalid api key" errors  
- **Service Unavailability**: HTTP 500/502/503 errors, "service unavailable" messages, "bad gateway" errors

### Fallback Process
1. Primary provider attempts generation
2. If a recoverable error occurs, the system automatically switches to the fallback provider
3. Uses appropriate API keys for the fallback provider
4. Logs the fallback attempt for monitoring
5. If successful, continues with fallback provider for that request
6. Future requests start with the primary provider again

## Configuration

### Character-Level Settings

Add the `modelFallback` configuration to your character's settings:

```json
{
  "name": "YourCharacter",
  "modelProvider": "groq",
  "settings": {
    "modelFallback": {
      "enabled": true,
      "provider": "openai"
    },
    "secrets": {
      "GROQ_API_KEY": "your-groq-api-key",
      "OPENAI_API_KEY": "your-openai-fallback-key"
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether to enable automatic fallback |
| `provider` | ModelProviderName | `"openai"` | Which provider to use as fallback |

### Supported Fallback Providers

- **OpenAI**: Most reliable option with high availability
- **Anthropic**: Good alternative for Claude models
- **Groq**: Fast inference, good for real-time applications
- Any other supported provider with proper API key configuration

## Usage Examples

### Example 1: Groq → OpenAI Fallback
Primary provider: Groq (fast, cost-effective)
Fallback provider: OpenAI (reliable, high availability)

```json
{
  "modelProvider": "groq",
  "settings": {
    "modelFallback": {
      "enabled": true,
      "provider": "openai"
    },
    "secrets": {
      "GROQ_API_KEY": "gsk_...",
      "OPENAI_API_KEY": "sk-..."
    }
  }
}
```

### Example 2: Custom Provider → Anthropic Fallback
```json
{
  "modelProvider": "together",
  "settings": {
    "modelFallback": {
      "enabled": true,
      "provider": "anthropic"
    },
    "secrets": {
      "TOGETHER_API_KEY": "...",
      "ANTHROPIC_API_KEY": "..."
    }
  }
}
```

### Example 3: Disabled Fallback
```json
{
  "modelProvider": "openai",
  "settings": {
    "modelFallback": {
      "enabled": false
    }
  }
}
```

## API Key Management

### Priority Order
The system retrieves API keys in this order:
1. Character-specific secrets: `character.settings.secrets.{PROVIDER}_API_KEY`
2. Global environment variables: `process.env.{PROVIDER}_API_KEY`

### Required Keys
Ensure you have API keys configured for both:
- Your primary provider
- Your fallback provider

### Environment Variables
```bash
# Primary provider
GROQ_API_KEY=gsk_your_groq_key_here

# Fallback provider  
OPENAI_API_KEY=sk_your_openai_key_here
```

## Monitoring and Logging

### Log Messages
The system provides detailed logging for monitoring:

```
[INFO] Attempting generation with provider: groq
[WARN] Primary provider groq failed, attempting fallback to openai
[INFO] Using fallback openai provider due to primary provider failure
[INFO] Successfully generated text using fallback provider: openai
```

### Error Types
Different error conditions are logged with specific details:
- Rate limiting detection
- Authentication failures
- Service availability issues

## Best Practices

### 1. Choose Complementary Providers
- **Primary**: Cost-effective or specialized (e.g., Groq for speed)
- **Fallback**: Highly reliable (e.g., OpenAI for stability)

### 2. API Key Security
- Use environment variables for production
- Store character-specific keys securely
- Rotate keys regularly

### 3. Cost Management
- Monitor fallback usage to understand patterns
- Consider rate limits of both providers
- Set up billing alerts

### 4. Testing
- Test fallback scenarios in development
- Verify API keys for both providers
- Monitor logs for fallback frequency

## Implementation Details

### Code Architecture
The fallback logic is implemented in `packages/core/src/generation.ts`:

- `shouldFallback()`: Determines if error warrants fallback
- Provider switching logic with retry loop
- Automatic API key resolution
- Comprehensive error handling

### Performance Impact
- Minimal overhead when primary provider works
- Small delay on first fallback attempt
- No persistent state between requests

## Troubleshooting

### Common Issues

**Fallback not working:**
- Check `enabled: true` in character settings
- Verify fallback provider API key is configured
- Ensure fallback provider is supported

**Authentication errors:**
- Verify API key format and validity
- Check environment variable names
- Confirm character secrets configuration

**Infinite failures:**
- Both providers may be down
- Check network connectivity
- Verify API key quotas

### Debug Logging
Enable debug logging to see detailed fallback behavior:
```bash
DEBUG=eliza:* npm start
```

## Migration Guide

### Updating Existing Characters

1. Add fallback configuration to character files:
```json
"settings": {
  "modelFallback": {
    "enabled": true,
    "provider": "openai"
  }
}
```

2. Configure fallback provider API keys
3. Test with both providers
4. Monitor logs for fallback events

### Backward Compatibility
- Existing characters work without changes
- Fallback is enabled by default
- OpenAI is the default fallback provider

## Future Enhancements

Potential improvements being considered:

- **Multiple Fallbacks**: Chain of fallback providers
- **Smart Provider Selection**: Based on request type or performance
- **Provider Health Monitoring**: Proactive provider switching
- **Cost Optimization**: Automatic provider selection based on cost
- **Provider Performance Metrics**: Track and optimize based on performance data

---

For questions or issues with the Model Fallback feature, please check the logs for detailed error information and ensure proper API key configuration. 