import type { Memory } from "@elizaos/core";

// List of supported cryptocurrencies with their symbols and common names/aliases
const SUPPORTED_CRYPTOCURRENCIES = [
  { symbol: 'BTC-USD', names: ['btc', 'bitcoin'] },
  { symbol: 'ETH-USD', names: ['eth', 'ethereum'] },
  { symbol: 'XRP-USD', names: ['xrp', 'ripple'] },
  { symbol: 'LTC-USD', names: ['ltc', 'litecoin'] },
  { symbol: 'ADA-USD', names: ['ada', 'cardano'] },
  { symbol: 'SOL-USD', names: ['sol', 'solana'] },
  { symbol: 'DOT-USD', names: ['dot', 'polkadot'] },
  { symbol: 'DOGE-USD', names: ['doge', 'dogecoin'] },
  { symbol: 'LINK-USD', names: ['link', 'chainlink'] },
  { symbol: 'AVAX-USD', names: ['avax', 'avalanche'] }
];

/**
 * Extract cryptocurrency types from a user message
 * @param message The user message to analyze
 * @returns An array of detected cryptocurrency symbols (e.g., ['BTC-USD', 'ETH-USD'])
 */
export function extractCryptocurrencyTypes(message: Memory): string[] {
  if (!message?.content?.text) {
    return ['BTC-USD']; // Default to Bitcoin if no message text
  }

  const text = message.content.text.toLowerCase();
  const detectedCryptos: string[] = [];

  // Check for each supported cryptocurrency in the message
  SUPPORTED_CRYPTOCURRENCIES.forEach(crypto => {
    const isDetected = crypto.names.some(name => text.includes(name));
    if (isDetected) {
      detectedCryptos.push(crypto.symbol);
    }
  });

  // Default to Bitcoin if no cryptocurrencies detected
  if (detectedCryptos.length === 0) {
    detectedCryptos.push('BTC-USD');
  }

  return detectedCryptos;
}

/**
 * Get cryptocurrency full name from symbol
 * @param symbol The cryptocurrency symbol (e.g., 'BTC-USD')
 * @returns The full name of the cryptocurrency
 */
export function getCryptoFullName(symbol: string): string {
  const crypto = SUPPORTED_CRYPTOCURRENCIES.find(c => c.symbol === symbol);
  if (!crypto) return 'Unknown';
  
  const name = crypto.names[0];
  // Handle specific crypto acronyms that should be uppercase
  const acronyms = ['btc', 'eth', 'xrp', 'ltc', 'ada', 'sol', 'dot'];
  if (acronyms.includes(name.toLowerCase())) {
    return name.toUpperCase();
  }
  
  return name.charAt(0).toUpperCase() + name.slice(1);
}
