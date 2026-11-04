/**
 * Two things offers wait for. Nothing reads them yet, because offers don't exist.
 *
 * The migration flag: every owner on a new agent is ready from the moment it is created, since it
 * has no old declines to carry over. An existing agent gets the flag per owner only once its first
 * list is prepared, so existing agents stay out until then.
 *
 * The first result: the first ordinary reply a platform accepted with a message id. That is
 * narrower and looser than the plan wants, and the plan's rollout lists what must change before
 * offers read it.
 *
 * Both are per machine and live apart from the replicated choices. Unreadable means not yet, so
 * they can only hold an offer back.
 */
import fs from 'node:fs';
import path from 'node:path';


export interface DeliveredFirstResult {
  at: string;
  carrier: 'telegram' | 'slack';
  messageId: string;
}

export function offerPrerequisitesDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'offer-prerequisites');
}

function migrationFile(stateDir: string): string {
  return path.join(offerPrerequisitesDir(stateDir), 'migration-complete.json');
}

function firstResultFile(stateDir: string): string {
  return path.join(offerPrerequisitesDir(stateDir), 'first-result.json');
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    // @silent-fallback-ok: absent or damaged reads as "not yet", which only holds an offer back
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** True when this home holds no agent yet. A clone or restore of an existing agent carries its identity files. */
export function isBlankAgentHome(stateDir: string): boolean {
  return !['config.json', 'AGENT.md', 'soul.md'].some((file) => fs.existsSync(path.join(stateDir, file)));
}

/** With no owner named, this answers for a new agent only. */
export function isMigrationComplete(stateDir: string, owner?: string): boolean {
  const current = readJson(migrationFile(stateDir));
  if (typeof current?.newAgentAt === 'string') return true;
  const owners = current?.owners;
  return owner !== undefined && !!owners && typeof owners === 'object' && Object.prototype.hasOwnProperty.call(owners, owner);
}

export function markNewAgent(stateDir: string, now: () => Date = () => new Date()): void {
  const current = readJson(migrationFile(stateDir));
  if (typeof current?.newAgentAt === 'string') return;
  writeJson(migrationFile(stateDir), { ...current, newAgentAt: now().toISOString() });
}

export function markMigrationComplete(stateDir: string, owner: string, now: () => Date = () => new Date()): void {
  if (isMigrationComplete(stateDir, owner)) return;
  const current = readJson(migrationFile(stateDir));
  const owners = current?.owners && typeof current.owners === 'object' ? current.owners as Record<string, unknown> : {};
  writeJson(migrationFile(stateDir), { ...current, owners: { ...owners, [owner]: { at: now().toISOString() } } });
}

export function readDeliveredFirstResult(stateDir: string): DeliveredFirstResult | null {
  const row = readJson(firstResultFile(stateDir));
  if (!row || typeof row.at !== 'string' || typeof row.messageId !== 'string') return null;
  if (row.carrier !== 'telegram' && row.carrier !== 'slack') return null;
  return { at: row.at, carrier: row.carrier, messageId: row.messageId };
}

/** Keeps the earliest. True when this call wrote it. A missing message id proves nothing, so it records nothing. */
export function recordDeliveredFirstResult(
  stateDir: string,
  carrier: DeliveredFirstResult['carrier'],
  messageId: string | number | null | undefined,
  now: () => Date = () => new Date(),
): boolean {
  if (messageId === null || messageId === undefined || messageId === '' || messageId === 0) return false;
  if (readDeliveredFirstResult(stateDir)) return false;
  writeJson(firstResultFile(stateDir), { at: now().toISOString(), carrier, messageId: String(messageId) });
  return true;
}
