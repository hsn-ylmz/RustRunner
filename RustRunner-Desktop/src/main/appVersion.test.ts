import { describe, it, expect } from 'vitest';
import { describeVersion, updatePolicyFor } from './appVersion';

describe('describeVersion', () => {
  it('calls a beta build the open beta', () => {
    expect(describeVersion('1.0.0-beta.1')).toEqual({
      version: '1.0.0-beta.1',
      channel: 'beta',
      label: '1.0.0-beta.1 (open beta)',
    });
  });

  it('leaves a stable version bare', () => {
    expect(describeVersion('0.11.1')).toEqual({ version: '0.11.1', channel: null, label: '0.11.1' });
    expect(describeVersion('1.0.0').label).toBe('1.0.0');
  });

  it('names other prerelease lines and ignores a leading v and build metadata', () => {
    expect(describeVersion('v1.1.0-rc.2').label).toBe('1.1.0-rc.2 (rc build)');
    expect(describeVersion('1.0.0-beta.3+abc').channel).toBe('beta');
  });

  it('does not invent a channel for text that is not a version', () => {
    expect(describeVersion('dev')).toEqual({ version: 'dev', channel: null, label: 'dev' });
  });
});

describe('updatePolicyFor', () => {
  it('lets a beta follow the prerelease line and never downgrades it', () => {
    expect(updatePolicyFor('1.0.0-beta.1')).toEqual({ allowPrerelease: true, allowDowngrade: false });
  });

  it('keeps stable users on stable releases', () => {
    expect(updatePolicyFor('0.11.1')).toEqual({ allowPrerelease: false, allowDowngrade: false });
    expect(updatePolicyFor('1.0.0')).toEqual({ allowPrerelease: false, allowDowngrade: false });
  });
});
