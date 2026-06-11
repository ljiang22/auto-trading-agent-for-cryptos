/**
 * Simple polyfill for crypto.randomBytes used by uuid
 */
export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Polyfill for crypto.randomFillSync
 */
export function randomFillSync(buffer: Uint8Array): Uint8Array {
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

/**
 * Simple polyfill for crypto.createHash
 */
export function createHash(algorithm: string): {
  update(data: string | Uint8Array): { digest(encoding: 'hex'): string };
} {
  return {
    update(data: string | Uint8Array) {
      // This is a very simple implementation that just returns a fixed hash
      // In a real implementation, you would use a proper hashing algorithm
      return {
        digest(encoding: 'hex') {
          return '00000000000000000000000000000000';
        }
      };
    }
  };
}

/**
 * Polyfill for crypto.randomUUID
 */
export function randomUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10
  return [
    bytes.slice(0, 4).reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), ''),
    bytes.slice(4, 6).reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), ''),
    bytes.slice(6, 8).reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), ''),
    bytes.slice(8, 10).reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), ''),
    bytes.slice(10).reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '')
  ].join('-');
}

export default {
  randomBytes,
  randomFillSync,
  createHash,
  randomUUID
}; 