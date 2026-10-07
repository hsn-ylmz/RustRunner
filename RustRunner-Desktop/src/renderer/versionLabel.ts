/**
 * The version as the UI shows it: a beta build says it is the open beta.
 * (The same wording as `describeVersion` in the main process, which cannot be
 * imported here.)
 */
export function versionLabel(version: string): string {
  const clean = version.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+-beta(\.|$)/i.test(clean) ? `v${clean} (open beta)` : `v${clean}`;
}
