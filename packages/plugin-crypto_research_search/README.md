# @elizaos-plugins/plugin-crypto-research

A specialized web search plugin focused exclusively on cryptocurrency research analysis, blockchain studies, and digital asset research reports. This plugin is optimized for finding and analyzing academic and professional crypto research content with enhanced research-focused search capabilities and comprehensive analysis formatting.

## Features

🔬 **Research-Focused Search**: Specialized search queries optimized for cryptocurrency research analysis and blockchain studies
📚 **Academic Analysis**: Comprehensive analysis of crypto research reports, academic papers, and professional studies
⚖️ **Regulatory Research**: In-depth analysis of regulatory impact studies and compliance research
🏢 **Institutional Research**: Track institutional crypto research, investment analysis, and adoption studies
🎯 **Sector Research**: Specialized research coverage of DeFi, NFT, and emerging crypto sectors
📊 **Data-Driven Analysis**: Enhanced search for quantitative crypto research and analytical studies

## Installation

```bash
npm install @elizaos-plugins/plugin-crypto-research
```

## Configuration

Add your Tavily API key to your environment or agent configuration:

```typescript
{
  "TAVILY_API_KEY": "your-tavily-api-key-here"
}
```

## Usage

Import and add the plugin to your agent:

```typescript
import { cryptoResearchPlugin } from '@elizaos-plugins/plugin-crypto-research';

// Add to your agent's plugins
const agent = {
  plugins: [cryptoResearchPlugin],
  // ... other configuration
};
```

## Action: CRYPTO_RESEARCH_SEARCH

The plugin provides the `CRYPTO_RESEARCH_SEARCH` action with the following capabilities:

### Supported Research Query Types

- **Research Analysis**: "Find research analysis on Bitcoin's long-term value proposition"
- **Academic Studies**: "Research the latest academic studies on Ethereum's scalability solutions"
- **Market Research**: "Find comprehensive research on DeFi market analysis and risk assessment"
- **Regulatory Research**: "Research analysis on cryptocurrency regulatory impact studies"
- **Institutional Research**: "Find institutional crypto research and investment analysis"
- **Technical Research**: "Research Bitcoin technical analysis methodologies and frameworks"
- **Sector Research**: "Find research on NFT market analysis and digital asset valuation"

### Action Aliases

The action responds to multiple research-focused aliases:
- `CRYPTO_RESEARCH`
- `CRYPTOCURRENCY_RESEARCH`
- `CRYPTO_ANALYSIS_SEARCH`
- `BLOCKCHAIN_RESEARCH`
- `CRYPTO_MARKET_RESEARCH`
- `DIGITAL_ASSET_RESEARCH`
- `CRYPTO_INVESTMENT_RESEARCH`
- `DEFI_RESEARCH`
- `NFT_RESEARCH`
- `BITCOIN_RESEARCH`
- `ETHEREUM_RESEARCH`
- `ALTCOIN_RESEARCH`
- `CRYPTO_FUNDAMENTAL_ANALYSIS`
- `CRYPTO_TECHNICAL_ANALYSIS`

### Enhanced Research Features

1. **Multi-Query Research**: Performs multiple related research searches for comprehensive coverage
2. **Research Context Enhancement**: Automatically adds research-relevant keywords to searches
3. **Academic Focus**: Prioritizes research papers, studies, and analytical reports (7-day window for research content)
4. **Structured Research Analysis**: Provides organized research analysis with:
   - Research Executive Summary
   - Primary Research Insights
   - Market Analysis & Data
   - Technical & Fundamental Analysis
   - Regulatory & Institutional Research
   - Risk Assessment & Opportunities
   - Research Methodology & Sources
   - Actionable Research Conclusions
   - Research Limitations

## Response Format

The plugin returns structured research responses with:

```
🔬 **Cryptocurrency Research Analysis**

[Comprehensive AI-generated research analysis based on academic and professional sources]

📚 **Research Sources & References:**
1. [Research Paper Title](URL) (Date)
2. [Study Title](URL) (Date)
...
```

## Search Optimization

The plugin automatically optimizes search queries by:

- Adding crypto-specific keywords when not present
- Generating multiple related search terms based on query intent
- Focusing on recent, relevant cryptocurrency content
- Filtering and combining results from multiple searches

## Error Handling

The plugin provides informative error messages for common issues:
- API key configuration problems
- Rate limiting
- Network connectivity issues
- Search service unavailability

## Dependencies

- `@elizaos/core`: Core Eliza framework
- `@tavily/core`: Tavily search API client
- `js-tiktoken`: Token counting for response trimming

## API Requirements

- **Tavily API Key**: Required for web search functionality
- **Rate Limits**: Respects Tavily API rate limits with intelligent query batching

## Contributing

This plugin is part of the Eliza ecosystem. Contributions are welcome for:
- Additional crypto-specific search optimizations
- Enhanced analysis templates
- New cryptocurrency data sources
- Improved error handling

## License

Part of the Eliza project - see main project license for details.


