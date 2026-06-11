# @elizaos/plugin-institutional-adoption

A specialized Eliza plugin for tracking and analyzing institutional cryptocurrency adoption, including corporate treasury holdings, ETF developments, regulatory changes, and investment fund allocations.

## 🚀 Overview

This plugin provides comprehensive functionality to:

- 🏛️ Track corporate cryptocurrency treasury adoptions
- 📊 Monitor Bitcoin and crypto ETF approvals and launches  
- 💰 Analyze institutional investment fund allocations
- 🏦 Follow bank and financial institution crypto adoption
- 📜 Track regulatory developments affecting institutions
- 📈 Monitor market impact of institutional movements
- 🔍 Search for specific institutional crypto adoption events

## 🔧 Installation

```bash
pnpm install @elizaos/plugin-institutional-adoption
```

## ⚙️ Configuration

The plugin requires the following environment variables:

```env
TAVILY_API_KEY=your_api_key    # Required: API key for financial data search service
```

## 📖 Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { institutionalCryptoSearchPlugin } from "@elizaos/plugin-institutional-adoption";

export default {
    plugins: [institutionalCryptoSearchPlugin],
    // ... other configuration
};
```

### Custom Integration

For custom integrations, you can import and use the search action directly:

```typescript
import { institutionalCryptoSearch } from "@elizaos/plugin-institutional-adoption";

// Execute institutional crypto search
const result = await institutionalCryptoSearch.handler(
    runtime,
    {
        content: { text: "MicroStrategy Bitcoin holdings 2024" },
    },
    state,
    {},
    callback
);
```

## 🎯 Features

### Institutional Crypto Search

The plugin automatically validates queries for institutional crypto relevance and provides structured analysis:

```typescript
// These queries will trigger the institutional crypto search:
"What companies added Bitcoin to their treasury recently?"
"Bitcoin ETF approvals this month"
"MicroStrategy Bitcoin holdings"
"Institutional crypto adoption trends"
"Pension fund cryptocurrency investments"
```

### Smart Query Enhancement

The plugin automatically enhances queries with institutional context:

```typescript
// User query: "Tesla Bitcoin"
// Enhanced query: "institutional Tesla Bitcoin cryptocurrency adoption"
```

### Structured Response Format

Responses are organized into clear sections:

- 📈 **Key Institutional Developments**
- 💰 **Financial Impact** 
- 🏛️ **Regulatory & Policy Updates**
- 🔮 **Market Trends**

## 🎨 Examples

### Corporate Treasury Tracking

```typescript
// Query: "Which companies hold Bitcoin in their treasury?"
// Returns: Structured data about corporate Bitcoin holdings with amounts and dates
```

### ETF Monitoring

```typescript
// Query: "Latest Bitcoin ETF approvals"
// Returns: Recent ETF launches, approval status, and market impact
```

### Regulatory Updates

```typescript
// Query: "New crypto regulations affecting institutions"
// Returns: Latest regulatory developments and compliance requirements
```

## 🏗️ Development

### Building

```bash
pnpm run build
```

### Development Mode

```bash
pnpm run dev
```

### Linting

```bash
pnpm run lint
pnpm run lint:fix
```

## 📚 API Reference

### Core Types

```typescript
interface CryptoInstitutionalData {
    companyName?: string;
    cryptoAsset?: string;
    investmentAmount?: string;
    investmentDate?: string;
    adoptionType?: "treasury" | "etf" | "investment_fund" | "payment" | "mining" | "trading";
    regulatoryStatus?: string;
    marketImpact?: string;
}

interface InstitutionalAdoptionEvent {
    institution: string;
    cryptoAssets: string[];
    announcementDate: string;
    adoptionDetails: CryptoInstitutionalData;
    sourceUrl: string;
    verificationStatus: "confirmed" | "rumored" | "pending";
}
```

### Action Interface

```typescript
interface Action {
    name: "INSTITUTIONAL_CRYPTO_SEARCH";
    similes: string[]; // Various trigger phrases
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
```

### Search Options

```typescript
interface SearchOptions {
    limit?: number;
    type?: "news" | "general" | "finance";
    includeAnswer?: boolean;
    searchDepth?: "basic" | "advanced";
    topic?: "finance" | "news" | "general";
    includeImages?: boolean;
    days?: number; // Search timeframe in days
}
```

## 🔍 Supported Queries

The plugin recognizes queries containing these institutional crypto keywords:

- **Institutions**: institution, institutional, corporate, company, fund
- **Investment terms**: investment, treasury, holdings, portfolio, allocation
- **Crypto assets**: bitcoin, crypto, cryptocurrency, ethereum, blockchain
- **Companies**: microstrategy, tesla, blackrock, fidelity, grayscale
- **Financial entities**: banks, financial, wall street, hedge fund, pension fund
- **Products**: ETF, digital asset

## 🛠️ Troubleshooting

### Issue: API Authentication Failures

- **Cause**: Invalid or missing Tavily API key
- **Solution**: Verify `TAVILY_API_KEY` environment variable is set correctly

### Issue: No Results for Query

- **Cause**: Query doesn't contain institutional crypto keywords
- **Solution**: Include terms like "institutional", "corporate", "Bitcoin", "adoption"

### Issue: Rate Limiting

- **Cause**: Too many requests in short timeframe
- **Solution**: Implement request throttling or wait before retrying

## 🔒 Security Best Practices

- Store API keys securely using environment variables
- Validate all search inputs before processing
- Implement proper error handling and logging
- Monitor API usage and rate limits
- Keep dependencies updated regularly

## 💡 Example Conversations

### Corporate Treasury Query

```json
{
  "user": "What's the latest on corporate Bitcoin adoptions?",
  "response": {
    "analysis": "📈 Key Institutional Developments:\n- Company X added 1,000 BTC to treasury\n- ETF Y received SEC approval\n\n💰 Financial Impact:\n- $50M investment announced\n- 15% portfolio allocation\n\n🏛️ Regulatory Updates:\n- New compliance framework released\n\n🔮 Market Trends:\n- Increasing institutional interest\n- Growing regulatory clarity",
    "sources": ["link1", "link2", "link3"]
  }
}
```

### ETF Tracking Query

```json
{
  "user": "Are there any new Bitcoin ETF approvals this month?",
  "response": {
    "analysis": "📈 Key Institutional Developments:\n- Spot Bitcoin ETF approved by regulator\n- Three new applications submitted\n\n💰 Financial Impact:\n- $2B in initial flows expected\n- Fee competition driving costs down",
    "sources": ["link1", "link2"]
  }
}
```

## 🤝 Contributing

Contributions are welcome! Please see the contributing guidelines in the main Eliza repository.

## 🌟 Credits

This plugin integrates with:

- [Tavily API](https://tavily.com/): Financial and news search capabilities
- [js-tiktoken](https://github.com/dqbd/tiktoken): Token management
- [Eliza Core](https://github.com/elizaos/eliza): AI agent framework

## 📄 License

This plugin is part of the Eliza project. See the main project repository for license information.

## 🔗 Related Resources

- [Institutional Bitcoin Tracker](https://bitcointreasuries.net/)
- [ETF Database](https://etfdb.com/)
- [SEC EDGAR Database](https://www.sec.gov/edgar)
- [Crypto Regulatory Updates](https://www.sec.gov/spotlight/cybersecurity-enforcement-actions)


