/**
 * Polyfill for crypto functions needed by the Twitter client
 */

/**
 * Generate random bytes without using crypto module
 * @param size Size of random bytes to generate
 * @returns A Uint8Array with random values
 */
export function randomBytes(size: number): { readUint32LE: () => number } {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  
  return {
    readUint32LE: () => {
      return (
        bytes[0] +
        (bytes[1] << 8) +
        (bytes[2] << 16) +
        (bytes[3] << 24)
      );
    }
  };
} 