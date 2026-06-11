import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function writeCatchupStateAtomic(p: string, state: object) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

describe('Atomic catchup state write', () => {
  const dir = os.tmpdir();
  const stateFile = path.join(dir, `test-catchup-${Date.now()}.json`);

  afterEach(() => {
    try { fs.unlinkSync(stateFile); } catch {}
    try { fs.unlinkSync(`${stateFile}.tmp`); } catch {}
  });

  it('writes valid JSON', () => {
    const state = { lastProcessedDate: '2026-04-17', attemptCount: 0 };
    writeCatchupStateAtomic(stateFile, state);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(parsed).toEqual(state);
  });

  it('leaves no .tmp file after successful write', () => {
    writeCatchupStateAtomic(stateFile, { done: true });
    expect(fs.existsSync(`${stateFile}.tmp`)).toBe(false);
  });

  it('overwrites existing state atomically', () => {
    writeCatchupStateAtomic(stateFile, { version: 1 });
    writeCatchupStateAtomic(stateFile, { version: 2 });
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(parsed.version).toBe(2);
  });
});
