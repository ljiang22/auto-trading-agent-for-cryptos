import { randomBytes } from './crypto-polyfill';

/**
 * Custom RNG implementation for UUID that doesn't rely on Node.js crypto module
 */
export default function rng() {
  return randomBytes(16);
} 