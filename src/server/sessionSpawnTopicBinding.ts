import fs from 'node:fs';
import path from 'node:path';

export interface SessionSpawnTopicBinding {
  required: boolean;
  topicId?: number;
  topicName?: string;
}

export function resolveSessionSpawnTopicBinding(input: {
  name?: unknown;
  topicId?: unknown;
  topicName?: unknown;
  requireTopicBinding?: unknown;
  spawnRole?: unknown;
}): { ok: true; binding: SessionSpawnTopicBinding } | { ok: false; error: string } {
  const name = typeof input.name === 'string' ? input.name : '';
  const normalizedSpawnRole = typeof input.spawnRole === 'string' ? input.spawnRole.trim().toLowerCase() : '';
  const roleRequiresTopic = normalizedSpawnRole === 'lane' || normalizedSpawnRole === 'orchestrator';
  // `_` is a JavaScript word character, so `\b` never fires on underscore-separated
  // forms. `/sessions/spawn` accepts `[a-zA-Z0-9_-]`, so names like
  // `w27_lane2_admission_delivery` would evade classification and spawn unbound.
  // Normalise `_` to `-` so underscore forms classify exactly like hyphen forms.
  const nameRequiresTopic = /\b(lane\d*|orchestrator|pathway)\b/i.test(name.replace(/_/g, '-'));
  const required = input.requireTopicBinding === true || roleRequiresTopic || nameRequiresTopic;
  let topicId: number | undefined;

  if (input.topicId !== undefined) {
    topicId = typeof input.topicId === 'number' ? input.topicId : Number(input.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return { ok: false, error: '"topicId" must be a positive integer when provided' };
    }
  }

  if (required && topicId === undefined) {
    return { ok: false, error: '"topicId" is required for lane/orchestrator session spawns' };
  }

  const topicName = typeof input.topicName === 'string' && input.topicName.trim().length > 0
    ? input.topicName.trim().slice(0, 200)
    : undefined;

  return { ok: true, binding: { required, topicId, topicName } };
}

export function persistDiskTopicSessionBinding(opts: {
  stateDir: string;
  topicId: number;
  tmuxSession: string;
  topicName?: string;
}): void {
  const registryPath = path.join(opts.stateDir, 'topic-session-registry.json');
  let registry: { topicToSession?: Record<string, string>; topicToName?: Record<string, string>; topicToPurpose?: Record<string, string> } = {};
  try {
    if (fs.existsSync(registryPath)) {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }
  } catch {
    registry = {};
  }
  registry.topicToSession = { ...(registry.topicToSession ?? {}), [String(opts.topicId)]: opts.tmuxSession };
  registry.topicToName = {
    ...(registry.topicToName ?? {}),
    ...(opts.topicName ? { [String(opts.topicId)]: opts.topicName } : {}),
  };
  registry.topicToPurpose = registry.topicToPurpose ?? {};
  const tmpPath = `${registryPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
  fs.renameSync(tmpPath, registryPath);
}
