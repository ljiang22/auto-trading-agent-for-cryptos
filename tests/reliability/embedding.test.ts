import { describe, it, expect } from 'vitest';

// Mirrors the singleton init pattern from localembeddingManager.ts
class EmbeddingManagerStub {
  isInitialized = false;
  initCallCount = 0;
  private _initPromise: Promise<void> | null = null;

  private async initializeModel(): Promise<void> {
    this.initCallCount++;
    await new Promise(r => setTimeout(r, 10)); // simulate async work
    this.isInitialized = true;
  }

  async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    if (!this._initPromise) {
      this._initPromise = this.initializeModel().catch((e: Error) => {
        this._initPromise = null;
        throw e;
      });
    }
    return this._initPromise;
  }
}

describe('Embedding manager singleton init', () => {
  it('initializes only once under concurrent calls', async () => {
    const mgr = new EmbeddingManagerStub();
    await Promise.all([
      mgr.ensureInitialized(),
      mgr.ensureInitialized(),
      mgr.ensureInitialized(),
    ]);
    expect(mgr.initCallCount).toBe(1);
    expect(mgr.isInitialized).toBe(true);
  });

  it('is idempotent after initialization', async () => {
    const mgr = new EmbeddingManagerStub();
    await mgr.ensureInitialized();
    await mgr.ensureInitialized();
    expect(mgr.initCallCount).toBe(1);
  });

  it('resets promise on failure, allowing retry', async () => {
    const mgr = new EmbeddingManagerStub();
    let fail = true;
    mgr['initializeModel'] = async () => {
      mgr.initCallCount++;
      if (fail) { fail = false; throw new Error('init failed'); }
      mgr.isInitialized = true;
    };
    await expect(mgr.ensureInitialized()).rejects.toThrow('init failed');
    await mgr.ensureInitialized(); // retry succeeds
    expect(mgr.isInitialized).toBe(true);
    expect(mgr.initCallCount).toBe(2);
  });
});
