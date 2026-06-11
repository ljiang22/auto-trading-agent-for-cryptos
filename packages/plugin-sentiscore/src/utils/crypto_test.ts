import { identifyAsset, identifyCryptocurrency, CRYPTOCURRENCIES, ASSETS } from './cryptocurrencies';

/**
 * Simple test function to verify asset detection functionality
 */
export function testAssetDetection(): void {
  console.log('Testing Asset Detection:');
  console.log('--------------------------------');
  
  // Test cases for various cryptocurrency and stock mentions
  const testCases = [
    // Cryptocurrency tests
    {
      text: "What's the sentiment analysis for Bitcoin over the last week?",
      expected: "BTC",
      assetType: "crypto"
    },
    {
      text: "Can you provide the sentiment analysis for Ethereum this month?",
      expected: "ETH",
      assetType: "crypto"
    },
    {
      text: "Give me the SentiScore analysis for BTC from 2023-01-01 to 2023-01-15",
      expected: "BTC",
      assetType: "crypto"
    },
    {
      text: "What's the current sentiment on SHIB?",
      expected: "SHIB",
      assetType: "crypto"
    },
    {
      text: "I'd like to see sentiment data for Cardano",
      expected: "ADA",
      assetType: "crypto"
    },
    {
      text: "Show me the cryptocurrency sentiment score for Ripple",
      expected: "XRP",
      assetType: "crypto"
    },
    {
      text: "Analyze the sentiment for Bitcoin Cash",
      expected: "BCH",
      assetType: "crypto"
    },
    
    // Stock tests
    {
      text: "What's the sentiment analysis for Tesla?",
      expected: "TSLA",
      assetType: "stock"
    },
    {
      text: "Can you analyze the sentiment for NVDA?",
      expected: "NVDA",
      assetType: "stock"
    },
    {
      text: "What's the market sentiment for Apple?",
      expected: "AAPL",
      assetType: "stock"
    },
    {
      text: "Analyze Microsoft sentiment",
      expected: "MSFT",
      assetType: "stock"
    },
    {
      text: "What are people saying about Google?",
      expected: "GOOGL",
      assetType: "stock"
    },
    {
      text: "Show me the sentiment analysis for Amazon",
      expected: "AMZN",
      assetType: "stock"
    },
    {
      text: "What's the sentiment for Meta?",
      expected: "META",
      assetType: "stock"
    },
    {
      text: "Check the sentiment for Netflix",
      expected: "NFLX",
      assetType: "stock"
    },
    {
      text: "How's the sentiment for AMD?",
      expected: "AMD",
      assetType: "stock"
    },
    {
      text: "What's the sentiment for Intel?",
      expected: "INTC",
      assetType: "stock"
    },
    {
      text: "Is the market sentiment positive for TSMC?",
      expected: "TSM",
      assetType: "stock"
    }
  ];
  
  // Run tests
  let passed = 0;
  let cryptoPassed = 0;
  let stockPassed = 0;
  let cryptoTotal = 0;
  let stockTotal = 0;
  
  for (const test of testCases) {
    const result = identifyAsset(test.text);
    const success = result === test.expected;
    
    console.log(`Test: "${test.text}"`);
    console.log(`Expected: ${test.expected}, Result: ${result}, ${success ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log('---');
    
    if (success) passed++;
    
    if (test.assetType === "crypto") {
      cryptoTotal++;
      if (success) cryptoPassed++;
    } else if (test.assetType === "stock") {
      stockTotal++;
      if (success) stockPassed++;
    }
  }
  
  console.log(`Test Summary: ${passed}/${testCases.length} tests passed`);
  console.log(`Crypto: ${cryptoPassed}/${cryptoTotal} tests passed`);
  console.log(`Stocks: ${stockPassed}/${stockTotal} tests passed`);
  
  // Also test backward compatibility
  console.log('\nTesting Backward Compatibility:');
  console.log('--------------------------------');
  const backwardCompatTest = "What's the sentiment for Bitcoin?";
  const result = identifyCryptocurrency(backwardCompatTest);
  console.log(`Test: "${backwardCompatTest}"`);
  console.log(`Expected: BTC, Result: ${result}, ${result === "BTC" ? 'PASS ✓' : 'FAIL ✗'}`);
  
  // List all available assets
  console.log('\nAvailable Assets:');
  console.log('------------------------');
  
  const cryptoCount = CRYPTOCURRENCIES.length;
  const stockCount = ASSETS.length - cryptoCount;
  
  console.log(`Total assets supported: ${ASSETS.length} (${cryptoCount} cryptocurrencies, ${stockCount} stocks)`);
  
  // Display a sample of cryptocurrencies
  console.log('\nSample Cryptocurrencies:');
  const cryptoSample = CRYPTOCURRENCIES.slice(0, 8);
  cryptoSample.forEach(crypto => {
    console.log(`${crypto.symbol}: ${crypto.names.join(', ')}`);
  });
  console.log(`...and ${cryptoCount - cryptoSample.length} more cryptocurrencies`);
  
  // Display a sample of stocks
  console.log('\nSample Stocks:');
  const stockSample = ASSETS.filter(asset => asset.assetType === "stock").slice(0, 8);
  stockSample.forEach(stock => {
    console.log(`${stock.symbol}: ${stock.names.join(', ')}`);
  });
  console.log(`...and ${stockCount - stockSample.length} more stocks`);
}

// Run the test
testAssetDetection(); 