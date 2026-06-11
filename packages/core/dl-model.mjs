import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = '/app/packages/core/cache';
console.log('Pre-downloading BGE-M3 q8 model (~560 MB)...');

const MAX_RETRIES = 5;
let lastErr;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    await pipeline('feature-extraction', 'Xenova/bge-m3', { dtype: 'q8' });
    console.log('BGE-M3 model cached successfully');
    process.exit(0);
  } catch (err) {
    lastErr = err;
    const delaySec = attempt * 30;
    console.error(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    if (attempt < MAX_RETRIES) {
      console.log(`Retrying in ${delaySec}s...`);
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }
}
throw lastErr;
