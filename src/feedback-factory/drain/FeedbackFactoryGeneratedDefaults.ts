import fs from 'node:fs';
import path from 'node:path';

export interface FeedbackFactoryGeneratedDefaults {
  schemaVersion: 1;
  feedbackFactory: { processing: { enabled: true }; drain: { enabled: true } };
}

const EXPECTED: FeedbackFactoryGeneratedDefaults = {
  schemaVersion: 1,
  feedbackFactory: { processing: { enabled: true }, drain: { enabled: true } },
};

export function inspectFeedbackFactoryGeneratedDefaults(stateDir: string, developmentAgent: boolean): 'fleet-dark' | 'healthy' | 'repair-needed' {
  if (!developmentAgent) return 'fleet-dark';
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'generated-feature-defaults.json'), 'utf8')) as Record<string, unknown>;
    const ff = parsed.feedbackFactory as Record<string, unknown> | undefined;
    const processing = ff?.processing as Record<string, unknown> | undefined;
    const drain = ff?.drain as Record<string, unknown> | undefined;
    return parsed.schemaVersion === 1 && processing?.enabled === true && drain?.enabled === true ? 'healthy' : 'repair-needed';
  } catch { return 'repair-needed'; }
}

export function ensureFeedbackFactoryGeneratedDefaults(stateDir: string, developmentAgent: boolean): {
  posture: 'fleet-dark' | 'healthy' | 'repaired'; changed: boolean; path: string;
  diff: { schemaVersion?: { before: unknown; after: 1 }; processingEnabled?: { before: unknown; after: true }; drainEnabled?: { before: unknown; after: true } };
} {
  const filePath = path.join(stateDir, 'state', 'generated-feature-defaults.json');
  if (!developmentAgent) return { posture: 'fleet-dark', changed: false, path: filePath, diff: {} };
  let before: Record<string, unknown> | null = null;
  try { before = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { /* absent/stale */ }
  const ff = before?.feedbackFactory as Record<string, unknown> | undefined;
  const processing = ff?.processing as Record<string, unknown> | undefined;
  const drain = ff?.drain as Record<string, unknown> | undefined;
  const valid = before?.schemaVersion === 1 && processing?.enabled === true && drain?.enabled === true;
  if (valid) return { posture: 'healthy', changed: false, path: filePath, diff: {} };
  const diff = {
    ...(before?.schemaVersion === 1 ? {} : { schemaVersion: { before: before?.schemaVersion, after: 1 as const } }),
    ...(processing?.enabled === true ? {} : { processingEnabled: { before: processing?.enabled, after: true as const } }),
    ...(drain?.enabled === true ? {} : { drainEnabled: { before: drain?.enabled, after: true as const } }),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(EXPECTED, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return { posture: 'repaired', changed: true, path: filePath, diff };
}
