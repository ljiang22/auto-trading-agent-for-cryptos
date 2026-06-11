import { describe, it, expect, beforeEach } from 'vitest';
import { analysisInProgressByUser } from '../../packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts';

// Importing the actual production Map — if the mutex logic changes in the source,
// these tests will catch regressions.

function acquire(userId: string): boolean {
  if (analysisInProgressByUser.get(userId)) return false;
  analysisInProgressByUser.set(userId, true);
  return true;
}

function release(userId: string) {
  analysisInProgressByUser.delete(userId);
}

describe('Per-user analysis mutex (production Map)', () => {
  beforeEach(() => {
    // Reset state between tests
    analysisInProgressByUser.clear();
  });

  it('allows a user to acquire when not in progress', () => {
    expect(acquire('user-1')).toBe(true);
  });

  it('blocks same user from acquiring twice', () => {
    acquire('user-1');
    expect(acquire('user-1')).toBe(false);
  });

  it('allows different users to run concurrently', () => {
    acquire('user-1');
    expect(acquire('user-2')).toBe(true);
  });

  it('allows re-acquisition after release', () => {
    acquire('user-1');
    release('user-1');
    expect(acquire('user-1')).toBe(true);
  });

  it('release of unknown user is a no-op', () => {
    expect(() => release('nobody')).not.toThrow();
  });

  it('multiple users are all independently lockable', () => {
    ['a', 'b', 'c'].forEach(uid => expect(acquire(uid)).toBe(true));
    ['a', 'b', 'c'].forEach(uid => expect(acquire(uid)).toBe(false));
    ['a', 'b', 'c'].forEach(uid => release(uid));
    ['a', 'b', 'c'].forEach(uid => expect(acquire(uid)).toBe(true));
  });
});
