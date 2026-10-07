import { describe, it, expect } from 'vitest';
import { versionLabel } from '../versionLabel';

describe('versionLabel', () => {
  it('marks a beta as the open beta', () => {
    expect(versionLabel('1.0.0-beta.1')).toBe('v1.0.0-beta.1 (open beta)');
    expect(versionLabel('v1.0.0-beta.2')).toBe('v1.0.0-beta.2 (open beta)');
  });
  it('shows a stable version as it is', () => {
    expect(versionLabel('0.11.1')).toBe('v0.11.1');
    expect(versionLabel('1.0.0')).toBe('v1.0.0');
  });
});
