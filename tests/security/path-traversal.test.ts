import { describe, it, expect } from 'vitest';
import path from 'path';

function validateFilePath(filePath: string, cwd = '/app'): { safe: boolean; resolved: string } {
  const safeBase = path.resolve(cwd, 'saved_data');
  const fullPath = path.resolve(safeBase, filePath.replace(/^saved_data[\\/]/, ''));
  return { safe: fullPath.startsWith(safeBase + path.sep) || fullPath === safeBase, resolved: fullPath };
}

describe('DELETE /files path traversal prevention', () => {
  it('allows a normal saved_data path', () => {
    const { safe } = validateFilePath('saved_data/outputs/report.html');
    expect(safe).toBe(true);
  });

  it('blocks a traversal with ..', () => {
    const { safe } = validateFilePath('saved_data/Reports/../../../../etc/hosts');
    expect(safe).toBe(false);
  });

  it('blocks an absolute path', () => {
    const { safe } = validateFilePath('/etc/passwd');
    expect(safe).toBe(false);
  });

  it('blocks traversal with URL-encoded dots', () => {
    const decoded = decodeURIComponent('saved_data%2FReports%2F..%2F..%2Fetc%2Fhosts');
    const { safe } = validateFilePath(decoded);
    expect(safe).toBe(false);
  });
});
