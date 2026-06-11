# @elizaos/plugin-web-search

A plugin for powerful web search capabilities, providing efficient search query handling and result processing through a customizable API interface.

## Overview

This plugin provides functionality to:

- Execute web search queries with customizable parameters
- Process and format search results
- Handle search API authentication
- Manage token limits and response sizes
- Optimize query performance

## Installation

```bash
pnpm install @elizaos/plugin-web-search
```

## Configuration

The plugin requires the following environment variables:

```env
TAVILY_API_KEY=your_api_key    # Required: API key for search service
```

## Usage

Import and register the plugin in your Eliza configuration.

```typescript
import { webSearchPlugin } from "@elizaos/plugin-web-search";

export default {
    plugins: [webSearchPlugin],
    // ... other configuration
};
```

**Custom Usage**
If you want custom usage, for example, twitter-client to search the web before posting a tweet, you can also import the webSearchService and use it directly. Here's how you can do it:

```typescript
// packages/client-twitter/src/post.ts
const webSearchService = new WebSearchService();
await webSearchService.initialize(runtime);
const latestNews = await webSearchService.search(
    "latest news on AI Agents",
    // searchOptions
);

const state = await this.runtime.composeState(
    {  } // memory,
    { // additional keys
        latestNews: latestNews,
    }
);

// Then modify the tweet template to include the {{latestNews}} and however you need
```

## Features

### Web Search

The plugin provides comprehensive web search capabilities:

```typescript
import { webSearch } from "@elizaos/plugin-web-search";

// Execute a search query
const result = await webSearch.handler(
    runtime,
    {
        content: { text: "What is the latest news about AI?" },
    },
    state,
    {},
    callback
);
```

### Token Management

```typescript
// The plugin automatically handles token limits
const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;

// Example of token-limited response
const response = MaxTokens(searchResult, DEFAULT_MAX_WEB_SEARCH_TOKENS);
```

## Development

### Building

```bash
pnpm run build
```

### Testing

```bash
pnpm run test
```

### Development Mode

```bash
pnpm run dev
```

## Dependencies

- `@elizaos/core`: Core Eliza functionality
- `js-tiktoken`: Token counting and management
- `tsup`: Build tool
- Other standard dependencies listed in package.json

## API Reference

### Core Interfaces

```typescript
interface Action {
    name: "WEB_SEARCH";
    similes: string[];
    description: string;
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
    handler: (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => Promise<void>;
    examples: Array<Array<any>>;
}

interface SearchResult {
    title: string;
    url: string;
    answer?: string;
    results?: Array<{
        title: string;
        url: string;
    }>;
}
```

### Plugin Methods

- `webSearch.handler`: Main method for executing searches
- `generateWebSearch`: Core search generation function
- `MaxTokens`: Token limit management function
- `getTotalTokensFromString`: Token counting utility

## Common Issues/Troubleshooting

### Issue: API Authentication Failures

- **Cause**: Invalid or missing Tavily API key
- **Solution**: Verify TAVILY_API_KEY environment variable

### Issue: Token Limit Exceeded

- **Cause**: Search results exceeding maximum token limit
- **Solution**: Results are automatically truncated to fit within limits

### Issue: Search Rate Limiting

- **Cause**: Too many requests in short time
- **Solution**: Implement proper request throttling

## Security Best Practices

- Store API keys securely using environment variables
- Validate all search inputs
- Implement proper error handling
- Keep dependencies updated
- Monitor API usage and rate limits
- Use HTTPS for API communication

## Example Usage

```typescript
// Basic search
const searchQuery = "Latest developments in quantum computing";
const results = await generateWebSearch(searchQuery, runtime);

// With formatted response
if (results && results.results.length) {
    const formattedResponse = `${results.answer}\n\nFor more details, check out:\n${results.results
        .map(
            (result, index) => `${index + 1}. [${result.title}](${result.url})`
        )
        .join("\n")}`;
}
```

## Configuration Options

### Token Management

```typescript
const DEFAULT_MODEL_ENCODING = "gpt-3.5-turbo";
const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;
```

### Search Actions

The plugin includes multiple search action similes:

- SEARCH_WEB
- INTERNET_SEARCH
- LOOKUP
- QUERY_WEB
- FIND_ONLINE
- And more...

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Tavily API](https://tavily.com/): Advanced search and content analysis API
- [js-tiktoken](https://github.com/dqbd/tiktoken): Token counting for API responses
- [Zod](https://github.com/colinhacks/zod): TypeScript-first schema validation

Special thanks to:

- The Eliza community for their contributions and feedback

For more information about the search capabilities and tools:

- [Tavily API Documentation](https://docs.tavily.com/)
- [Token Management Guide](https://github.com/dqbd/tiktoken#readme)
- [Search API Best Practices](https://docs.tavily.com/docs/guides/best-practices)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

## Example
```json
{    
    "conversations": [
      {
        "user": "{{user1}}",
        "content": {
          "text": "Is there any news about iPhone 17"
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "The iPhone 17 lineup is expected to include the iPhone 17, iPhone 17 Air, and iPhone 17 Pro models. The iPhone 17 Pro will feature a new A19 Pro chip and a horizontal camera design. The iPhone 17 Air is anticipated to be a mid-priced model with a sleek design.

        For more details, you can check out these resources:
        1. [iPhone 17: Everything We Know - MacRumors](https://www.macrumors.com/roundup/iphone-17/)
        2. [iPhone 17 Series Latest News, Leaks & Pricing Details - Know Your Mobile](https://www.knowyourmobile.com/iphone-17/)
        3. [iPhone 17: Release date, rumors, specs, price of Apple's 2025 iPhone ...](https://www.macworld.com/article/2393967/iphone-17-release-date-specs-features-rumors.html)"
        }
      },
    ],
    [
      {
        "user": "{{user1}}",
        "content": {
          "text": "what happened on BRK annual meeting?"
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "At the 2025 Berkshire Hathaway annual meeting, Warren Buffett announced his intention to step down from CEO and transition to a chairman role, with Greg Abel taking over as CEO at the end of the year. Buffett emphasized his commitment to Berkshire's future under Abel's leadership.

        For more details, you can check out these resources:
        1. [Berkshire Hathaway annual meeting: Buffett recommends Abel take over as ...](https://finance.yahoo.com/news/live/berkshire-hathaway-annual-meeting-buffett-recommends-abel-take-over-as-ceo-at-year-end-114823075.html)
        2. [Warren Buffett Steps Down as CEO—and Other Key ... - Investopedia](https://www.investopedia.com/warren-buffett-steps-down-as-ceo-and-other-key-takeaways-from-berkshire-annual-meeting-2025-11727772)
        3. [Warren Buffett to step down from Berkshire at year's end, Greg ... - CNN](https://www.cnn.com/2025/05/03/business/warren-buffett-berkshire-hathaway-meeting)"
        }
      },
    ]
}
```


