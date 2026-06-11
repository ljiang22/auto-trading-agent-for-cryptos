# @elizaos-plugins/plugin-news

A plugin providing cryptocurrency news functionality for ElizaOS agents.

## Description

The News plugin enables agents to retrieve and share the latest cryptocurrency news and market updates. It provides essential actions and evaluators to fetch, process, and deliver news content to users.

### Features

1. **Cryptocurrency News Retrieval**
   - Fetch the latest cryptocurrency news
   - Filter news by specific topics or assets
   - Process and format news for easy consumption

2. **News Provider**
   - Automated news background knowledge
   - Periodic news updates
   - Relevant market insights
   - Source attribution

3. **Fact Evaluation**
   - News fact extraction
   - Market data verification
   - Source credibility assessment
   - Temporal relevance tracking

## Installation

```bash
cd ./plugin-news
pnpm install
pnpm build
```

## Usage

```typescript
import { GetANewsPlugin } from "@elizaos-plugins/plugin-news";


## Development

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run linting:

```bash
pnpm run lint
```

## API Configuration

This plugin requires a News API key to function properly. Set your API key as an environment variable:

```
NEWS_API_KEY=your_api_key_here
```

You can obtain an API key from [News API](https://newsapi.org/).

## Dependencies

- @elizaos/core: workspace:*

## Example
{    
    [
      {
        "user": "{{user1}}",
        "content": {
          "text": "What is the latest news?"
        }
      },
      {
        "user": "crypto_expert",
        "content": {
          "text": "LATEST CRYPTO MARKET NEWS

                    Major Developments:
                    - Cantor Fitzgerald, Tether, Bitfinex & SoftBank launching $3B Bitcoin acquisition fund
                    - BlackRock adds $192M worth of BTC to holdings
                    - SoftBank enters Bitcoin market with $900M initial position

                    Market Impact:
                    - Institutional buying pressure remains strong
                    - ETF inflows accelerating ($450M+ daily)
                    - Resistance cluster at $94-95K being tested

                    Technical Structure:
                    - Price consolidating under ATH
                    - RSI 74 (overbought but sustainable)
                    - Major support established $88-92K

                    Outlook: Institutional positioning remains aggressively bullish. Watch $94K resistance - clean break opens path to $100K. Risk management crucial at these levels."
        }
      },
      {
        "user": "crypto_expert",
        "content": {
          "text": "The latest news about "cryptocurrency" are: Monero Likely Pumped 50% Due To Suspected $330 Million Bitcoin Theft
                    Onchain investigator ZachXBT flagged a suspicious $330.7 million Bitcoin transfer that was quickly laundered into Monero, causing XMR's price to spike by 50%. CoinTelegraph reports: The transaction, reported on April 28, saw funds moved from a potential victi…
                    https://slashdot.org/story/25/04/28/198238/monero-likely-pumped-50-due-to-suspected-330-million-bitcoin-theft
                    Slashdot.org

                    Forget Dogecoin And Shiba Inu — Crypto Analyst Sees This Coin Surging 100%
                    A crypto analyst has forecasted a 100% increase for Pepe (CRYPTO: PEPE), a mid-cap competitor to Dogecoin (CRYPTO: DOGE) and Shiba Inu (CRYPTO: SHIB...
                    https://finance.yahoo.com/news/forget-dogecoin-shiba-inu-crypto-200209860.html
                    Yahoo Entertainment

                    Bloomberg Strategists Say 'More Public Firms Might Rethink Crypto As US Exceptionalism Dims'
                    Bloomberg strategists have said more firms may consider cryptocurrency treasury strategies. Bitcoin has drawn praise for its relative strength and stability ...
                    https://finance.yahoo.com/news/bloomberg-strategists-more-public-firms-172901461.html
                    Yahoo Entertainment

                    Bloomberg Strategists Say 'More Public Firms Might Rethink Crypto As US Exceptionalism Dims'
                    Benzinga and Yahoo Finance LLC may earn commission or revenue on some items through the links below.
                    -
                    Bloomberg strategists have said more firms may consider cryptocurrency treasury strategies.
                    -
                    Bitcoin has drawn praise for its relative strength and stabili…
                    https://biztoc.com/x/7724822e298caa1b
                    Biztoc.com

                    Coinbase 2FA error fixed after many believed their account was hacked
                    The crypto exchange fixed a confusing flaw allegedly used in social engineering.
                    https://www.techradar.com/pro/security/coinbase-2fa-error-fixed-after-many-believed-their-account-was-hacked
                    TechRadar

                    Bitcoin to Hit New All-Time High Around $120K in Q2: Standard Chartered
                    Strategic allocation away from U.S. assets is likely to be the catalyst for move to a new record.
                    https://www.coindesk.com/markets/2025/04/28/bitcoin-to-hit-new-all-time-high-around-120k-in-q2-standard-chartered
                    CoinDesk

                    Down Two Squad Members, Progressives Come for an AIPAC Democrat
                    Justice Democrats, the group that helped elect the Squad. Is backing a primary against AIPAC-backed incumbent Rep. Shri Thanedar. 
                    The post Down Two Squad Members, Progressives Come for an AIPAC Democrat appeared first on The Intercept.
                    https://theintercept.com/2025/04/28/aipac-primary-democrat-shri-thanedar-donavan-mckinney-michigan/
                    The Intercept

                    Bitcoin Turns Positive Year-to-Date as It Veers Toward Digital Gold Narrative
                    Bitcoin's strong correlation with gold continues as economic uncertainty grows.
                    https://www.coindesk.com/markets/2025/04/28/bitcoin-turns-positive-year-to-date-as-it-veers-toward-digital-gold-narrative
                    CoinDesk

                    Bitcoin Holds Tight Despite Dismal Economic Data, Rising India/Pakistan Tensions
                    The Dallas Fed Manufacturing Index plunged to its lowest level since the COVID pandemic closed the economy.
                    https://www.coindesk.com/markets/2025/04/28/bitcoin-holds-tight-despite-dismal-economic-data-rising-indiapakistan-tensions
                    CoinDesk

                    Trump Media Stock Jumps 57%
                    TMTG shares have risen dramatically in line with the company's recently announced ventures into cryptocurrency and financial services.
                    https://www.newsweek.com/trump-media-stock-jumps-57-percent-2064923
                    Newsweek"
        }
        
      }
    ],
}
    
