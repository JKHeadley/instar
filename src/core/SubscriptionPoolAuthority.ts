import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const SUBSCRIPTION_POOL_SCHEMA_VERSION = 1 as const;
export const SUBSCRIPTION_POOL_MAX_BYTES = 8 * 1024 * 1024;
export const SUBSCRIPTION_POOL_MAX_ROWS = 8_192;
export const SUBSCRIPTION_POOL_GENERATION_RE = /^[a-f0-9]{32}$/;

export type SubscriptionPoolAuthorityReason =
  | 'io-read'
  | 'io-stat'
  | 'size-limit'
  | 'row-limit'
  | 'parse'
  | 'root-version'
  | 'root-shape'
  | 'invalid-row'
  | 'duplicate-id'
  | 'foreign-authority'
  | 'recovery-conflict';

export class SubscriptionPoolAuthorityReadError extends Error {
  constructor(readonly reason: SubscriptionPoolAuthorityReason) {
    super(reason);
    this.name = 'SubscriptionPoolAuthorityReadError';
  }
}

export interface SubscriptionPoolGenerationRecord {
  schemaVersion: 1;
  generation: string;
  baseGeneration: string | null;
  machineId: string;
  accountsSha256: string;
  accountsSize: number;
}

export interface SubscriptionPoolWitness {
  generation: string;
  nextGeneration: string | null;
  machineId: string;
  operation: 'first-create' | 'legacy-migrate' | 'update';
  legacyDigest: string | null;
  legacySize: number | null;
  state: 'initializing' | 'updating' | 'initialized';
  cleanupPending: boolean;
}

export interface BoundedAuthorityFile {
  bytes: Buffer;
  sha256: string;
  size: number;
}

export function newSubscriptionPoolGeneration(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function readAuthorityFileBounded(file: string): BoundedAuthorityFile {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SubscriptionPoolAuthorityReadError(
      code === 'ELOOP' ? 'recovery-conflict' : 'io-read',
    );
  }
  try {
    let stat: fs.Stats;
    try {
      stat = fs.fstatSync(fd);
    } catch {
      throw new SubscriptionPoolAuthorityReadError('io-stat');
    }
    if (!stat.isFile()) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    if (stat.size > SUBSCRIPTION_POOL_MAX_BYTES) {
      throw new SubscriptionPoolAuthorityReadError('size-limit');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= SUBSCRIPTION_POOL_MAX_BYTES) {
      const remaining = SUBSCRIPTION_POOL_MAX_BYTES + 1 - total;
      if (remaining <= 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    if (total > SUBSCRIPTION_POOL_MAX_BYTES) {
      throw new SubscriptionPoolAuthorityReadError('size-limit');
    }
    const bytes = Buffer.concat(chunks, total);
    return {
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function parseAccountsAuthority<T extends { id?: unknown }>(
  captured: BoundedAuthorityFile,
  validateRow: (row: unknown) => row is T,
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(captured.bytes.toString('utf8'));
  } catch {
    throw new SubscriptionPoolAuthorityReadError('parse');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SubscriptionPoolAuthorityReadError('root-shape');
  }
  const root = parsed as { version?: unknown; accounts?: unknown };
  if (root.version !== SUBSCRIPTION_POOL_SCHEMA_VERSION) {
    throw new SubscriptionPoolAuthorityReadError('root-version');
  }
  if (!Array.isArray(root.accounts)) {
    throw new SubscriptionPoolAuthorityReadError('root-shape');
  }
  if (root.accounts.length > SUBSCRIPTION_POOL_MAX_ROWS) {
    throw new SubscriptionPoolAuthorityReadError('row-limit');
  }
  const out: T[] = [];
  const ids = new Set<string>();
  for (const row of root.accounts) {
    if (!validateRow(row) || typeof row.id !== 'string') {
      throw new SubscriptionPoolAuthorityReadError('invalid-row');
    }
    if (ids.has(row.id)) throw new SubscriptionPoolAuthorityReadError('duplicate-id');
    ids.add(row.id);
    out.push(row);
  }
  return out;
}

function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && SUBSCRIPTION_POOL_GENERATION_RE.test(value);
}

export function validateGenerationRecord(
  value: unknown,
  expected: { machineId: string; accountsSha256: string; accountsSize: number },
): SubscriptionPoolGenerationRecord {
  if (!value || typeof value !== 'object') throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
  const row = value as Record<string, unknown>;
  const baseValid = row.baseGeneration === null || validGeneration(row.baseGeneration);
  if (
    row.schemaVersion !== 1 ||
    !validGeneration(row.generation) ||
    !baseValid ||
    row.machineId !== expected.machineId ||
    row.accountsSha256 !== expected.accountsSha256 ||
    row.accountsSize !== expected.accountsSize
  ) {
    throw new SubscriptionPoolAuthorityReadError(
      row.machineId !== expected.machineId ? 'foreign-authority' : 'recovery-conflict',
    );
  }
  return row as unknown as SubscriptionPoolGenerationRecord;
}

export function validateSubscriptionPoolWitness(value: unknown): SubscriptionPoolWitness {
  if (!value || typeof value !== 'object') throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
  const row = value as Record<string, unknown>;
  if (
    !validGeneration(row.generation) ||
    typeof row.machineId !== 'string' || !row.machineId ||
    !['first-create', 'legacy-migrate', 'update'].includes(String(row.operation)) ||
    !['initializing', 'updating', 'initialized'].includes(String(row.state)) ||
    typeof row.cleanupPending !== 'boolean'
  ) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');

  const next = row.nextGeneration;
  const legacyDigest = row.legacyDigest;
  const legacySize = row.legacySize;
  const noLegacy = legacyDigest === null && legacySize === null;
  const hasLegacy = typeof legacyDigest === 'string' && /^[a-f0-9]{64}$/.test(legacyDigest)
    && Number.isInteger(legacySize) && Number(legacySize) >= 0;
  const op = row.operation;
  const state = row.state;
  const cleanup = row.cleanupPending;
  const valid =
    (op === 'first-create' && (state === 'initializing' || state === 'initialized')
      && next === null && noLegacy && cleanup === false) ||
    (op === 'legacy-migrate' && (state === 'initializing' || state === 'initialized')
      && next === null && hasLegacy && cleanup === false) ||
    (op === 'update' && state === 'updating' && validGeneration(next)
      && next !== row.generation && noLegacy && cleanup === false) ||
    (op === 'update' && state === 'initialized' && next === null && noLegacy);
  if (!valid) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
  if (op === 'update' && state === 'initialized' && typeof cleanup !== 'boolean') {
    throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
  }
  return row as unknown as SubscriptionPoolWitness;
}

export interface SubscriptionPoolAuthoritySnapshot<T> {
  accounts: T[];
  generation: string;
  cleanupPending: boolean;
}

export class SubscriptionPoolAuthorityStore<T extends { id: string }> {
  readonly authorityDir: string;
  readonly witnessPath: string;
  readonly legacyPath: string;
  private readonly parentDir: string;

  constructor(
    stateDir: string,
    private readonly machineId: string,
    private readonly validateRow: (row: unknown) => row is T,
  ) {
    this.parentDir = path.join(stateDir, 'state');
    this.authorityDir = path.join(this.parentDir, 'subscription-pool');
    this.witnessPath = path.join(this.parentDir, 'subscription-pool.initialized.json');
    this.legacyPath = path.join(stateDir, 'subscription-pool.json');
  }

  loadSteadyState(): SubscriptionPoolAuthoritySnapshot<T> | null {
    const hasAuthority = fs.existsSync(this.authorityDir);
    const hasWitness = fs.existsSync(this.witnessPath);
    if (!hasAuthority && !hasWitness) return null;
    if (!hasWitness) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    const rawWitness = this.readJsonBounded(this.witnessPath, (value): value is SubscriptionPoolWitness => {
      try { validateSubscriptionPoolWitness(value); return true; } catch { return false; }
    });
    const witness = validateSubscriptionPoolWitness(rawWitness);
    if (witness.machineId !== this.machineId) throw new SubscriptionPoolAuthorityReadError('foreign-authority');
    if (witness.state === 'initializing') return this.recoverInitializing(witness);
    if (witness.state === 'updating') return this.recoverUpdating(witness);
    if (!hasAuthority) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    this.assertOnlyRecognizedSiblings(witness);
    const loaded = this.loadGenerationDirectory(this.authorityDir);
    if (loaded.generation.generation !== witness.generation || loaded.generation.baseGeneration !== null) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    let cleanupPending = witness.cleanupPending;
    if (witness.cleanupPending) {
      try {
        this.finishRecognizedCleanup(witness);
        cleanupPending = false;
      } catch {
        cleanupPending = true;
      }
    }
    return {
      accounts: loaded.accounts,
      generation: loaded.generation.generation,
      cleanupPending,
    };
  }

  create(accountsRoot: unknown): SubscriptionPoolAuthoritySnapshot<T> {
    if (fs.existsSync(this.authorityDir) || fs.existsSync(this.witnessPath)) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    fs.mkdirSync(this.parentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.parentDir, 0o700);
    const generation = newSubscriptionPoolGeneration();
    const candidate = `${this.authorityDir}.candidate-first-${generation}`;
    const initializing: SubscriptionPoolWitness = {
      generation, nextGeneration: null, machineId: this.machineId,
      operation: 'first-create', legacyDigest: null, legacySize: null,
      state: 'initializing', cleanupPending: false,
    };
    this.atomicJson(this.witnessPath, initializing);
    try {
      this.buildGeneration(candidate, accountsRoot, generation, null);
      fs.renameSync(candidate, this.authorityDir);
      this.fsyncDir(this.parentDir);
      const initialized: SubscriptionPoolWitness = { ...initializing, state: 'initialized' };
      this.atomicJson(this.witnessPath, initialized);
      this.fsyncDir(this.parentDir);
      const loaded = this.loadGenerationDirectory(this.authorityDir);
      return { accounts: loaded.accounts, generation, cleanupPending: false };
    } catch (error) {
      try {
        if (fs.existsSync(candidate)) SafeFsExecutor.safeRmSync(candidate, {
          recursive: true, force: true, operation: 'SubscriptionPoolAuthorityStore:create-candidate-cleanup',
        });
        if (!fs.existsSync(this.authorityDir) && fs.existsSync(this.witnessPath)) {
          SafeFsExecutor.safeUnlinkSync(this.witnessPath, {
            operation: 'SubscriptionPoolAuthorityStore:create-witness-cleanup',
          });
        }
        this.fsyncDir(this.parentDir);
      } catch { /* original error remains authoritative */ }
      throw error;
    }
  }

  private recoverInitializing(witness: SubscriptionPoolWitness): SubscriptionPoolAuthoritySnapshot<T> {
    if (witness.operation !== 'first-create') {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const candidate = `${this.authorityDir}.candidate-first-${witness.generation}`;
    const siblings = this.recoverySiblings();
    if (siblings.some((entry) => entry !== path.basename(candidate))) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    if (fs.existsSync(this.authorityDir)) {
      if (fs.existsSync(candidate)) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
      const active = this.loadGenerationDirectory(this.authorityDir);
      if (active.generation.generation !== witness.generation || active.generation.baseGeneration !== null) {
        throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
      }
      const committed = { ...witness, state: 'initialized' as const };
      this.atomicJson(this.witnessPath, committed);
      this.fsyncDir(this.parentDir);
      return { accounts: active.accounts, generation: witness.generation, cleanupPending: false };
    }
    if (!fs.existsSync(candidate)) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    const staged = this.loadGenerationDirectory(candidate);
    if (staged.generation.generation !== witness.generation || staged.generation.baseGeneration !== null) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    fs.renameSync(candidate, this.authorityDir);
    this.fsyncDir(this.parentDir);
    const committed = { ...witness, state: 'initialized' as const };
    this.atomicJson(this.witnessPath, committed);
    this.fsyncDir(this.parentDir);
    return { accounts: staged.accounts, generation: witness.generation, cleanupPending: false };
  }

  private recoverUpdating(witness: SubscriptionPoolWitness): SubscriptionPoolAuthoritySnapshot<T> {
    if (witness.operation !== 'update' || !witness.nextGeneration) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const oldGeneration = witness.generation;
    const newGeneration = witness.nextGeneration;
    const candidate = this.candidatePath(oldGeneration, newGeneration);
    const rollback = this.rollbackPath(oldGeneration);
    const allowed = new Set([path.basename(candidate), path.basename(rollback)]);
    if (this.recoverySiblings().some((entry) => !allowed.has(entry))) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const active = fs.existsSync(this.authorityDir) ? this.loadGenerationDirectory(this.authorityDir) : null;
    const old = fs.existsSync(rollback) ? this.loadGenerationDirectory(rollback) : null;
    let next = fs.existsSync(candidate) ? this.loadCandidateOrAbortIncomplete(candidate) : null;

    if (active?.generation.generation === oldGeneration && !old) {
      if (!next) {
        this.abortUpdateToOld(witness, candidate);
        return { accounts: active.accounts, generation: oldGeneration, cleanupPending: false };
      }
      if (next.generation.generation !== newGeneration ||
          (next.generation.baseGeneration !== oldGeneration && next.generation.baseGeneration !== null)) {
        throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
      }
      if (next.generation.baseGeneration === oldGeneration) {
        this.normalizeCandidate(candidate, next.generation);
        next = this.loadGenerationDirectory(candidate);
      }
      fs.renameSync(this.authorityDir, rollback);
      this.fsyncDir(this.parentDir);
      fs.renameSync(candidate, this.authorityDir);
      this.fsyncDir(this.parentDir);
      return this.commitRecoveredUpdate(oldGeneration, newGeneration);
    }

    if (!active && old?.generation.generation === oldGeneration && next?.generation.generation === newGeneration
        && next.generation.baseGeneration === null) {
      fs.renameSync(candidate, this.authorityDir);
      this.fsyncDir(this.parentDir);
      return this.commitRecoveredUpdate(oldGeneration, newGeneration);
    }

    if (active?.generation.generation === newGeneration && active.generation.baseGeneration === null
        && old?.generation.generation === oldGeneration && !next) {
      return this.commitRecoveredUpdate(oldGeneration, newGeneration);
    }
    throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
  }

  private loadCandidateOrAbortIncomplete(candidate: string): {
    accounts: T[]; generation: SubscriptionPoolGenerationRecord;
  } | null {
    const accounts = path.join(candidate, 'accounts.json');
    const generation = path.join(candidate, 'generation.json');
    if (!fs.existsSync(accounts) || !fs.existsSync(generation)) {
      SafeFsExecutor.safeRmSync(candidate, {
        recursive: true, force: true, operation: 'SubscriptionPoolAuthorityStore:abort-incomplete-candidate',
      });
      this.fsyncDir(this.parentDir);
      return null;
    }
    return this.loadGenerationDirectory(candidate);
  }

  private normalizeCandidate(candidate: string, generation: SubscriptionPoolGenerationRecord): void {
    this.atomicJson(path.join(candidate, 'generation.json'), { ...generation, baseGeneration: null });
    this.fsyncDir(candidate);
  }

  private abortUpdateToOld(witness: SubscriptionPoolWitness, candidate: string): void {
    if (fs.existsSync(candidate)) {
      SafeFsExecutor.safeRmSync(candidate, {
        recursive: true, force: true, operation: 'SubscriptionPoolAuthorityStore:abort-update-candidate',
      });
      this.fsyncDir(this.parentDir);
    }
    this.atomicJson(this.witnessPath, {
      ...witness, operation: 'update', state: 'initialized', nextGeneration: null, cleanupPending: false,
    });
    this.fsyncDir(this.parentDir);
  }

  private commitRecoveredUpdate(oldGeneration: string, newGeneration: string): SubscriptionPoolAuthoritySnapshot<T> {
    const loaded = this.loadGenerationDirectory(this.authorityDir);
    if (loaded.generation.generation !== newGeneration || loaded.generation.baseGeneration !== null) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const committed: SubscriptionPoolWitness = {
      generation: newGeneration, nextGeneration: null, machineId: this.machineId,
      operation: 'update', legacyDigest: null, legacySize: null,
      state: 'initialized', cleanupPending: true,
    };
    this.atomicJson(this.witnessPath, committed);
    this.fsyncDir(this.parentDir);
    let cleanupPending = true;
    try {
      this.finishRecognizedCleanup(committed, oldGeneration);
      cleanupPending = false;
    } catch { /* committed authority stays readable; restart retries cleanup */ }
    return { accounts: loaded.accounts, generation: newGeneration, cleanupPending };
  }

  update(
    currentGeneration: string,
    accountsRoot: unknown,
  ): SubscriptionPoolAuthoritySnapshot<T> {
    const current = this.loadSteadyState();
    if (!current || current.generation !== currentGeneration || current.cleanupPending) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const nextGeneration = newSubscriptionPoolGeneration();
    const candidate = this.candidatePath(currentGeneration, nextGeneration);
    const rollback = this.rollbackPath(currentGeneration);
    if (this.foreignSiblingExists() || fs.existsSync(candidate) || fs.existsSync(rollback)) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    const updating: SubscriptionPoolWitness = {
      generation: currentGeneration, nextGeneration, machineId: this.machineId,
      operation: 'update', legacyDigest: null, legacySize: null,
      state: 'updating', cleanupPending: false,
    };
    this.atomicJson(this.witnessPath, updating);
    this.fsyncDir(this.parentDir);
    this.buildGeneration(candidate, accountsRoot, nextGeneration, currentGeneration);
    const generationPath = path.join(candidate, 'generation.json');
    const captured = readAuthorityFileBounded(path.join(candidate, 'accounts.json'));
    this.atomicJson(generationPath, {
      schemaVersion: 1, generation: nextGeneration, baseGeneration: null,
      machineId: this.machineId, accountsSha256: captured.sha256, accountsSize: captured.size,
    } satisfies SubscriptionPoolGenerationRecord);
    this.fsyncDir(candidate);
    fs.renameSync(this.authorityDir, rollback);
    this.fsyncDir(this.parentDir);
    fs.renameSync(candidate, this.authorityDir);
    this.fsyncDir(this.parentDir);
    const loaded = this.loadGenerationDirectory(this.authorityDir);
    const committed: SubscriptionPoolWitness = {
      generation: nextGeneration, nextGeneration: null, machineId: this.machineId,
      operation: 'update', legacyDigest: null, legacySize: null,
      state: 'initialized', cleanupPending: true,
    };
    this.atomicJson(this.witnessPath, committed);
    this.fsyncDir(this.parentDir);
    let cleanupPending = false;
    try {
      SafeFsExecutor.safeRmSync(rollback, {
        recursive: true, force: true, operation: 'SubscriptionPoolAuthorityStore:update-rollback-cleanup',
      });
      this.fsyncDir(this.parentDir);
      this.atomicJson(this.witnessPath, { ...committed, cleanupPending: false });
      this.fsyncDir(this.parentDir);
    } catch {
      // @silent-fallback-ok — the committed generation remains authoritative;
      // cleanupPending is returned to callers and persisted in the witness so
      // the failed rollback-directory cleanup is observable and retryable.
      cleanupPending = true;
    }
    return { accounts: loaded.accounts, generation: nextGeneration, cleanupPending };
  }

  private loadGenerationDirectory(dir: string): {
    accounts: T[]; generation: SubscriptionPoolGenerationRecord;
  } {
    this.assertDirectory(dir);
    const accountsFile = path.join(dir, 'accounts.json');
    const captured = readAuthorityFileBounded(accountsFile);
    const accounts = parseAccountsAuthority<T>(captured, this.validateRow);
    const generation = this.readJsonBounded(path.join(dir, 'generation.json'), (value): value is SubscriptionPoolGenerationRecord => {
      try {
        validateGenerationRecord(value, {
          machineId: this.machineId, accountsSha256: captured.sha256, accountsSize: captured.size,
        });
        return true;
      } catch { return false; }
    });
    return { accounts, generation: validateGenerationRecord(generation, {
      machineId: this.machineId, accountsSha256: captured.sha256, accountsSize: captured.size,
    }) };
  }

  private buildGeneration(dir: string, accountsRoot: unknown, generation: string, baseGeneration: string | null): void {
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const accountsPath = path.join(dir, 'accounts.json');
    const bytes = Buffer.from(`${JSON.stringify(accountsRoot, null, 2)}\n`);
    if (bytes.length > SUBSCRIPTION_POOL_MAX_BYTES) throw new SubscriptionPoolAuthorityReadError('size-limit');
    SafeFsExecutor.atomicWriteFileSync(accountsPath, bytes, {
      mode: 0o600, operation: 'SubscriptionPoolAuthorityStore:accounts',
    });
    fs.chmodSync(accountsPath, 0o600);
    const captured = readAuthorityFileBounded(accountsPath);
    parseAccountsAuthority<T>(captured, this.validateRow);
    this.atomicJson(path.join(dir, 'generation.json'), {
      schemaVersion: 1, generation, baseGeneration, machineId: this.machineId,
      accountsSha256: captured.sha256, accountsSize: captured.size,
    } satisfies SubscriptionPoolGenerationRecord);
    this.fsyncDir(dir);
    this.fsyncDir(this.parentDir);
  }

  private finishRecognizedCleanup(witness: SubscriptionPoolWitness, expectedOldGeneration?: string): void {
    const rollbackEntries = this.recoverySiblings().filter((entry) =>
      entry.startsWith('subscription-pool.rollback-'),
    );
    if (rollbackEntries.length > 1) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    const rollback = expectedOldGeneration
      ? this.rollbackPath(expectedOldGeneration)
      : rollbackEntries.length === 1 ? path.join(this.parentDir, rollbackEntries[0]!) : null;
    if (rollback && fs.existsSync(rollback)) {
      const loaded = this.loadGenerationDirectory(rollback);
      if (expectedOldGeneration && loaded.generation.generation !== expectedOldGeneration) {
        throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
      }
      SafeFsExecutor.safeRmSync(rollback, {
        recursive: true, force: true, operation: 'SubscriptionPoolAuthorityStore:startup-cleanup',
      });
    }
    this.fsyncDir(this.parentDir);
    this.atomicJson(this.witnessPath, { ...witness, cleanupPending: false });
    this.fsyncDir(this.parentDir);
  }

  private readJsonBounded<U>(file: string, validate: (value: unknown) => value is U): U {
    const captured = readAuthorityFileBounded(file);
    let parsed: unknown;
    try { parsed = JSON.parse(captured.bytes.toString('utf8')); }
    catch { throw new SubscriptionPoolAuthorityReadError('parse'); }
    if (!validate(parsed)) throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    return parsed;
  }

  private atomicJson(file: string, value: unknown): void {
    SafeFsExecutor.atomicWriteFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600, operation: 'SubscriptionPoolAuthorityStore:atomic-json',
    });
    fs.chmodSync(file, 0o600);
  }

  private assertDirectory(dir: string): void {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); }
    catch { throw new SubscriptionPoolAuthorityReadError('io-stat'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
  }

  private fsyncDir(dir: string): void {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private candidatePath(oldGeneration: string, newGeneration: string): string {
    return `${this.authorityDir}.candidate-${oldGeneration}-${newGeneration}`;
  }

  private rollbackPath(generation: string): string {
    return `${this.authorityDir}.rollback-${generation}`;
  }

  private foreignSiblingExists(): boolean {
    try {
      return fs.readdirSync(this.parentDir).some((name) =>
        (name.startsWith('subscription-pool.candidate-') || name.startsWith('subscription-pool.rollback-')),
      );
    } catch { return false; }
  }

  private recoverySiblings(): string[] {
    try {
      return fs.readdirSync(this.parentDir).filter((name) =>
        name.startsWith('subscription-pool.candidate-') || name.startsWith('subscription-pool.rollback-'),
      );
    } catch {
      return [];
    }
  }

  private assertOnlyRecognizedSiblings(witness: SubscriptionPoolWitness): void {
    const siblings = this.recoverySiblings();
    if (!witness.cleanupPending && siblings.length > 0) {
      throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
    }
    if (witness.cleanupPending) {
      if (siblings.some((entry) => !entry.startsWith('subscription-pool.rollback-')) || siblings.length > 1) {
        throw new SubscriptionPoolAuthorityReadError('recovery-conflict');
      }
    }
  }
}
