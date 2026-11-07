/**
 * Bitwarden CLI integration for secret management.
 *
 * Wraps the `bw` CLI to provide scoped secret storage per agent.
 * Secrets are stored as Bitwarden Secure Notes in a folder per agent.
 *
 * Folder structure in Bitwarden:
 *   instar/
 *     {agentName}/
 *       telegram-token
 *       telegram-chat-id
 *       auth-token
 *       dashboard-pin
 *       tunnel-token
 *
 * The session key is cached in memory and refreshed as needed.
 */

import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────

export interface BitwardenConfig {
  /** Agent name (used as folder scope) */
  agentName: string;
  /** Override bw binary path for testing. Pass null to simulate bw not installed. */
  bwPath?: string | null;
}

export interface BitwardenStatus {
  /** Whether the `bw` CLI is installed */
  installed: boolean;
  /** Whether the user is logged in */
  loggedIn: boolean;
  /** Whether the vault is unlocked */
  unlocked: boolean;
  /** User email (if logged in) */
  email?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const BW_TIMEOUT = 15000; // 15 second timeout for CLI calls
const FOLDER_PREFIX = 'instar';
/** The variable `bw --passwordenv` reads the master password from. Set on the child only, never on this process. */
export const BW_PASSWORD_ENV = 'INSTAR_BW_MASTER_PASSWORD';

/** The bin folders of every Node version under the user's nvm, newest first; empty when there is no nvm. */
function nvmBins(home: string): string[] {
  try {
    const root = `${home}/.nvm/versions/node`;
    return fs.readdirSync(root).sort().reverse().map((v) => `${root}/${v}/bin/bw`);
  } catch {
    // @silent-fallback-ok: no nvm here
    return [];
  }
}

// ── Provider ─────────────────────────────────────────────────────────

export class BitwardenProvider {
  private agentName: string;
  private sessionKey: string | null = null;
  private bwPath: string | null = null;
  private bwPathOverridden = false;

  constructor(config: BitwardenConfig) {
    this.agentName = config.agentName;
    if (config.bwPath !== undefined) {
      this.bwPath = config.bwPath;
      this.bwPathOverridden = true;
    }
  }

  // ── Status ────────────────────────────────────────────────────────

  /** Check Bitwarden CLI status. */
  getStatus(): BitwardenStatus {
    const bw = this.findBw();
    if (!bw) {
      return { installed: false, loggedIn: false, unlocked: false };
    }

    try {
      const output = execFileSync(bw, ['status', '--raw'], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const status = JSON.parse(output);
      return {
        installed: true,
        loggedIn: status.status !== 'unauthenticated',
        unlocked: status.status === 'unlocked',
        email: status.userEmail || undefined,
      };
    } catch {
      return { installed: true, loggedIn: false, unlocked: false };
    }
  }

  /**
   * The status with its third state kept: `missing` (no program), `failed` (the program did not answer,
   * or answered badly, so nothing is known), or a reading. `getStatus()` folds `failed` into "not logged
   * in", which a caller that must not act on a guess cannot use.
   */
  statusRead(): { kind: 'missing' } | { kind: 'failed' } | { kind: 'ok'; loggedIn: boolean; unlocked: boolean; email?: string } {
    const bw = this.findBw();
    if (!bw) return { kind: 'missing' };
    try {
      const output = withSyncOp(() => execFileSync(bw, ['status', '--raw'], { encoding: 'utf-8', timeout: BW_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] })).trim();
      const status = JSON.parse(output) as { status?: unknown; userEmail?: unknown };
      if (typeof status.status !== 'string') return { kind: 'failed' };
      return { kind: 'ok', loggedIn: status.status !== 'unauthenticated', unlocked: status.status === 'unlocked', email: typeof status.userEmail === 'string' ? status.userEmail : undefined };
    } catch {
      // @silent-fallback-ok: reported as a failed read, which the caller treats as unknown
      return { kind: 'failed' };
    }
  }

  /** Whether Bitwarden is ready to use (installed, logged in, unlocked). */
  isReady(): boolean {
    const status = this.getStatus();
    return status.installed && status.loggedIn && status.unlocked;
  }

  // ── Session Management ────────────────────────────────────────────

  /**
   * Unlock the vault with a master password.
   * Returns true if successful.
   */
  unlock(masterPassword: string): boolean {
    const bw = this.requireBw();

    try {
      // First check if already unlocked
      const status = this.getStatus();
      if (status.unlocked) {
        // Get existing session key
        this.sessionKey = this.getExistingSession();
        return this.sessionKey !== null;
      }

      // Unlock with the password in the child's environment, never on its command line: a process list
      // (`ps`, a crash report, a shell history) shows arguments to every user on the machine.
      const session = withSyncOp(() => execFileSync(bw, ['unlock', '--passwordenv', BW_PASSWORD_ENV, '--raw'], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, [BW_PASSWORD_ENV]: masterPassword },
      })).trim();

      this.sessionKey = session;
      return true;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return false;
    }
  }

  /**
   * The live session key held in memory (set by a successful `unlock()`/`login()`,
   * or read from the environment). Returns null when no session is held. This is
   * the canonical way to read the freshly-unlocked session — `unlock()` stores it
   * in a private field, it is NOT exported to `process.env.BW_SESSION`. NEVER log
   * the returned value.
   */
  getSessionKey(): string | null {
    return this.sessionKey;
  }

  /**
   * Log in with email and master password.
   * Returns true if successful.
   */
  login(email: string, masterPassword: string): boolean {
    const bw = this.requireBw();

    try {
      // The email is an identifier; the password rides in the environment, as in unlock().
      const session = withSyncOp(() => execFileSync(bw, ['login', email, '--passwordenv', BW_PASSWORD_ENV, '--raw'], {
        encoding: 'utf-8',
        timeout: 30000, // Login can be slower
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, [BW_PASSWORD_ENV]: masterPassword },
      })).trim();

      this.sessionKey = session;
      return true;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return false;
    }
  }

  /**
   * Sign this machine out of Bitwarden and forget the session. True when the CLI accepted it or was
   * already signed out.
   */
  logout(): boolean {
    const bw = this.findBw();
    if (!bw) return true;
    try {
      withSyncOp(() => execFileSync(bw, ['logout'], { encoding: 'utf-8', timeout: BW_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] }));
      this.sessionKey = null;
      return true;
    } catch (err) {
      // `bw logout` on a signed-out CLI exits non-zero with "You are not logged in."; that is the state wanted.
      const text = err instanceof Error ? `${err.message} ${(err as { stderr?: unknown }).stderr ?? ''}` : String(err);
      if (/not logged in/i.test(text)) {
        this.sessionKey = null;
        return true;
      }
      return false;
    }
  }

  // ── Secret Operations ─────────────────────────────────────────────

  /**
   * Get a secret by key name.
   * Returns null if not found.
   */
  get(key: string): string | null {
    const bw = this.requireBw();
    const session = this.requireSession();
    const itemName = this.scopedName(key);

    try {
      const output = execFileSync(bw, [
        'list', 'items',
        '--search', itemName,
        '--session', session,
        '--raw',
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const items = JSON.parse(output);

      // Find exact match in the correct folder
      const folderId = this.getOrCreateFolderId();
      const match = items.find((item: any) =>
        item.name === itemName && item.folderId === folderId
      );

      if (!match) return null;

      // Secure notes store value in notes field
      if (match.type === 2 && match.notes) {
        return match.notes;
      }

      // Login items store in password field
      if (match.type === 1 && match.login?.password) {
        return match.login.password;
      }

      return null;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return null;
    }
  }

  /**
   * Set a secret by key name.
   * Creates or updates the item in Bitwarden.
   */
  set(key: string, value: string): boolean {
    const bw = this.requireBw();
    const session = this.requireSession();
    const itemName = this.scopedName(key);

    try {
      // Inside the try: a failed folder lookup must never escape, because the CLI's error text carries the command line.
      const folderId = this.getOrCreateFolderId();
      // Check if item already exists
      const existingId = this.findItemId(itemName, folderId);

      if (existingId) {
        // Update existing item
        const existingJson = execFileSync(bw, [
          'get', 'item', existingId,
          '--session', session,
          '--raw',
        ], {
          encoding: 'utf-8',
          timeout: BW_TIMEOUT,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        const existing = JSON.parse(existingJson);
        existing.notes = value;

        // The item (with the secret in it) goes to bw on stdin, never as an argument: a process list shows arguments to every user.
        const encoded = Buffer.from(JSON.stringify(existing)).toString('base64');
        execFileSync(bw, [
          'edit', 'item', existingId,
          '--session', session,
        ], {
          encoding: 'utf-8',
          timeout: BW_TIMEOUT,
          stdio: ['pipe', 'pipe', 'pipe'],
          input: encoded,
        });
      } else {
        // Create new secure note
        const item = {
          type: 2, // Secure note
          name: itemName,
          notes: value,
          folderId,
          secureNote: { type: 0 },
        };

        const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
        execFileSync(bw, [
          'create', 'item',
          '--session', session,
        ], {
          encoding: 'utf-8',
          timeout: BW_TIMEOUT,
          stdio: ['pipe', 'pipe', 'pipe'],
          input: encoded,
        });
      }

      return true;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return false;
    }
  }

  /**
   * Check if a secret exists.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a secret by key name.
   */
  delete(key: string): boolean {
    const bw = this.requireBw();
    const session = this.requireSession();
    const itemName = this.scopedName(key);
    const folderId = this.getOrCreateFolderId();

    try {
      const itemId = this.findItemId(itemName, folderId);
      if (!itemId) return false;

      execFileSync(bw, [
        'delete', 'item', itemId,
        '--session', session,
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return true;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return false;
    }
  }

  /**
   * List all secrets for this agent.
   * Returns key-value pairs.
   */
  listAll(): Record<string, string> {
    const bw = this.requireBw();
    const session = this.requireSession();
    const folderId = this.getOrCreateFolderId();

    try {
      const output = execFileSync(bw, [
        'list', 'items',
        '--folderid', folderId,
        '--session', session,
        '--raw',
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const items = JSON.parse(output);
      const result: Record<string, string> = {};
      const prefix = this.scopedName('');

      for (const item of items) {
        if (item.name.startsWith(prefix)) {
          const key = item.name.substring(prefix.length);
          if (item.type === 2 && item.notes) {
            result[key] = item.notes;
          }
        }
      }

      return result;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return {};
    }
  }

  /**
   * The names of this agent's items, read-only: never creates the folder. Returns [] when the folder does
   * not exist yet, and THROWS when the vault can't be read (a locked session, a timeout, a CLI failure), so a
   * caller can tell "no copy" from "could not look". The thrown error carries no command line.
   */
  listOwnItemNames(): string[] {
    const bw = this.requireBw();
    const session = this.requireSession();
    const folderName = `${FOLDER_PREFIX}/${this.agentName}`;
    const run = (args: string[]): string => {
      try {
        return withSyncOp(() => execFileSync(bw, [...args, '--session', session, '--raw'], { encoding: 'utf-8', timeout: BW_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] })).trim();
      } catch {
        // @silent-fallback-ok: the CLI's own message would carry the session; a fixed message is thrown instead
        throw new Error(`Bitwarden could not be read (${args[0]} ${args[1]})`);
      }
    };
    const folders = JSON.parse(run(['list', 'folders'])) as Array<{ id?: unknown; name?: unknown }>;
    const folder = folders.find((f) => f.name === folderName);
    if (!folder || typeof folder.id !== 'string') return [];
    const items = JSON.parse(run(['list', 'items', '--folderid', folder.id])) as Array<{ name?: unknown; type?: unknown }>;
    const prefix = this.scopedName('');
    return items
      .filter((item) => typeof item.name === 'string' && item.name.startsWith(prefix) && item.type === 2)
      .map((item) => (item.name as string).substring(prefix.length));
  }

  // ── Folder Management ─────────────────────────────────────────────

  private getOrCreateFolderId(): string {
    const bw = this.requireBw();
    const session = this.requireSession();
    const folderName = `${FOLDER_PREFIX}/${this.agentName}`;

    try {
      // List existing folders
      const output = execFileSync(bw, [
        'list', 'folders',
        '--session', session,
        '--raw',
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const folders = JSON.parse(output);
      const existing = folders.find((f: any) => f.name === folderName);
      if (existing) return existing.id;

      // Create the folder
      const folderData = { name: folderName };
      const encoded = Buffer.from(JSON.stringify(folderData)).toString('base64');
      const created = execFileSync(bw, [
        'create', 'folder',
        '--session', session,
        '--raw',
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: encoded,
      }).trim();

      const result = JSON.parse(created);
      return result.id;
    } catch {
      // @silent-fallback-ok: a fixed message, because the CLI's own text carries the session on its command line
      throw new Error('Failed to get/create the Bitwarden folder');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private scopedName(key: string): string {
    return key ? `${FOLDER_PREFIX}-${this.agentName}-${key}` : `${FOLDER_PREFIX}-${this.agentName}-`;
  }

  private findItemId(itemName: string, folderId: string): string | null {
    const bw = this.requireBw();
    const session = this.requireSession();

    try {
      const output = execFileSync(bw, [
        'list', 'items',
        '--search', itemName,
        '--session', session,
        '--raw',
      ], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const items = JSON.parse(output);
      const match = items.find((item: any) =>
        item.name === itemName && item.folderId === folderId
      );

      return match?.id || null;
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return null;
    }
  }

  private findBw(): string | null {
    // If path was explicitly set via config, use it directly (even if null)
    if (this.bwPathOverridden) return this.bwPath;
    // Cached from previous detection
    if (this.bwPath) return this.bwPath;

    // A server started by launchd or the lifeline has a short PATH, so the user's own installs are
    // looked in directly: Homebrew, the usual system folders, then the user's local bin and Node installs.
    const home = process.env.HOME || '';
    const candidates = [
      '/opt/homebrew/bin/bw',
      '/usr/local/bin/bw',
      '/usr/bin/bw',
      '/snap/bin/bw',
      ...(home ? [`${home}/.local/bin/bw`, `${home}/.npm-global/bin/bw`, `${home}/.volta/bin/bw`, ...nvmBins(home)] : []),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.bwPath = candidate;
        return candidate;
      }
    }

    // Check PATH
    try {
      const result = execFileSync('which', ['bw'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (result && fs.existsSync(result)) {
        this.bwPath = result;
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }

  private requireBw(): string {
    const bw = this.findBw();
    if (!bw) {
      throw new Error(
        'Bitwarden CLI (bw) not found. Install with:\n' +
        '  brew install bitwarden-cli   (macOS)\n' +
        '  npm install -g @bitwarden/cli (any platform)\n' +
        '  snap install bw              (Linux)'
      );
    }
    return bw;
  }

  private requireSession(): string {
    if (this.sessionKey) return this.sessionKey;

    // Try to get session from environment
    const envSession = process.env.BW_SESSION;
    if (envSession) {
      this.sessionKey = envSession;
      return envSession;
    }

    // Try to check if vault is already unlocked (some bw setups auto-persist session)
    const existing = this.getExistingSession();
    if (existing) {
      this.sessionKey = existing;
      return existing;
    }

    throw new Error(
      'Bitwarden vault is locked. Call unlock(password) first or set BW_SESSION env var.'
    );
  }

  private getExistingSession(): string | null {
    const bw = this.findBw();
    if (!bw) return null;

    try {
      // Try listing with no session — works if vault was unlocked externally
      execFileSync(bw, ['list', 'folders', '--raw'], {
        encoding: 'utf-8',
        timeout: BW_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return ''; // Empty string = session not needed (already unlocked)
    } catch {
      // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
      return null;
    }
  }
}
