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
import fs from 'node:fs';
// ── Constants ────────────────────────────────────────────────────────
const BW_TIMEOUT = 15000; // 15 second timeout for CLI calls
const FOLDER_PREFIX = 'instar';
// ── Provider ─────────────────────────────────────────────────────────
export class BitwardenProvider {
    agentName;
    sessionKey = null;
    bwPath = null;
    bwPathOverridden = false;
    constructor(config) {
        this.agentName = config.agentName;
        if (config.bwPath !== undefined) {
            this.bwPath = config.bwPath;
            this.bwPathOverridden = true;
        }
    }
    // ── Status ────────────────────────────────────────────────────────
    /** Check Bitwarden CLI status. */
    getStatus() {
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
        }
        catch {
            return { installed: true, loggedIn: false, unlocked: false };
        }
    }
    /** Whether Bitwarden is ready to use (installed, logged in, unlocked). */
    isReady() {
        const status = this.getStatus();
        return status.installed && status.loggedIn && status.unlocked;
    }
    // ── Session Management ────────────────────────────────────────────
    /**
     * Unlock the vault with a master password.
     * Returns true if successful.
     */
    unlock(masterPassword) {
        const bw = this.requireBw();
        try {
            // First check if already unlocked
            const status = this.getStatus();
            if (status.unlocked) {
                // Get existing session key
                this.sessionKey = this.getExistingSession();
                return this.sessionKey !== null;
            }
            // Unlock with password
            const session = execFileSync(bw, ['unlock', masterPassword, '--raw'], {
                encoding: 'utf-8',
                timeout: BW_TIMEOUT,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            this.sessionKey = session;
            return true;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return false;
        }
    }
    /**
     * Log in with email and master password.
     * Returns true if successful.
     */
    login(email, masterPassword) {
        const bw = this.requireBw();
        try {
            const session = execFileSync(bw, ['login', email, masterPassword, '--raw'], {
                encoding: 'utf-8',
                timeout: 30000, // Login can be slower
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            this.sessionKey = session;
            return true;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return false;
        }
    }
    // ── Secret Operations ─────────────────────────────────────────────
    /**
     * Get a secret by key name.
     * Returns null if not found.
     */
    get(key) {
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
            const match = items.find((item) => item.name === itemName && item.folderId === folderId);
            if (!match)
                return null;
            // Secure notes store value in notes field
            if (match.type === 2 && match.notes) {
                return match.notes;
            }
            // Login items store in password field
            if (match.type === 1 && match.login?.password) {
                return match.login.password;
            }
            return null;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return null;
        }
    }
    /**
     * Set a secret by key name.
     * Creates or updates the item in Bitwarden.
     */
    set(key, value) {
        const bw = this.requireBw();
        const session = this.requireSession();
        const itemName = this.scopedName(key);
        const folderId = this.getOrCreateFolderId();
        try {
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
                const encoded = Buffer.from(JSON.stringify(existing)).toString('base64');
                execFileSync(bw, [
                    'edit', 'item', existingId,
                    encoded,
                    '--session', session,
                ], {
                    encoding: 'utf-8',
                    timeout: BW_TIMEOUT,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            }
            else {
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
                    encoded,
                    '--session', session,
                ], {
                    encoding: 'utf-8',
                    timeout: BW_TIMEOUT,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            }
            return true;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return false;
        }
    }
    /**
     * Check if a secret exists.
     */
    has(key) {
        return this.get(key) !== null;
    }
    /**
     * Delete a secret by key name.
     */
    delete(key) {
        const bw = this.requireBw();
        const session = this.requireSession();
        const itemName = this.scopedName(key);
        const folderId = this.getOrCreateFolderId();
        try {
            const itemId = this.findItemId(itemName, folderId);
            if (!itemId)
                return false;
            execFileSync(bw, [
                'delete', 'item', itemId,
                '--session', session,
            ], {
                encoding: 'utf-8',
                timeout: BW_TIMEOUT,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return true;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return false;
        }
    }
    /**
     * List all secrets for this agent.
     * Returns key-value pairs.
     */
    listAll() {
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
            const result = {};
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
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return {};
        }
    }
    // ── Folder Management ─────────────────────────────────────────────
    getOrCreateFolderId() {
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
            const existing = folders.find((f) => f.name === folderName);
            if (existing)
                return existing.id;
            // Create the folder
            const folderData = { name: folderName };
            const encoded = Buffer.from(JSON.stringify(folderData)).toString('base64');
            const created = execFileSync(bw, [
                'create', 'folder',
                encoded,
                '--session', session,
                '--raw',
            ], {
                encoding: 'utf-8',
                timeout: BW_TIMEOUT,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            const result = JSON.parse(created);
            return result.id;
        }
        catch (err) {
            throw new Error(`Failed to get/create Bitwarden folder: ${err instanceof Error ? err.message : err}`);
        }
    }
    // ── Helpers ───────────────────────────────────────────────────────
    scopedName(key) {
        return key ? `${FOLDER_PREFIX}-${this.agentName}-${key}` : `${FOLDER_PREFIX}-${this.agentName}-`;
    }
    findItemId(itemName, folderId) {
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
            const match = items.find((item) => item.name === itemName && item.folderId === folderId);
            return match?.id || null;
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return null;
        }
    }
    findBw() {
        // If path was explicitly set via config, use it directly (even if null)
        if (this.bwPathOverridden)
            return this.bwPath;
        // Cached from previous detection
        if (this.bwPath)
            return this.bwPath;
        const candidates = [
            '/opt/homebrew/bin/bw',
            '/usr/local/bin/bw',
            '/usr/bin/bw',
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
        }
        catch {
            // Not in PATH
        }
        return null;
    }
    requireBw() {
        const bw = this.findBw();
        if (!bw) {
            throw new Error('Bitwarden CLI (bw) not found. Install with:\n' +
                '  brew install bitwarden-cli   (macOS)\n' +
                '  npm install -g @bitwarden/cli (any platform)\n' +
                '  snap install bw              (Linux)');
        }
        return bw;
    }
    requireSession() {
        if (this.sessionKey)
            return this.sessionKey;
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
        throw new Error('Bitwarden vault is locked. Call unlock(password) first or set BW_SESSION env var.');
    }
    getExistingSession() {
        const bw = this.findBw();
        if (!bw)
            return null;
        try {
            // Try listing with no session — works if vault was unlocked externally
            execFileSync(bw, ['list', 'folders', '--raw'], {
                encoding: 'utf-8',
                timeout: BW_TIMEOUT,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return ''; // Empty string = session not needed (already unlocked)
        }
        catch {
            // @silent-fallback-ok — vault locked or key not found — caller handles missing secret
            return null;
        }
    }
}
//# sourceMappingURL=BitwardenProvider.js.map