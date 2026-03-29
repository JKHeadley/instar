/**
 * InvitationManager — Invitation token lifecycle for Threadline trust bootstrap.
 *
 * Manages cryptographically random invitation tokens with:
 * - Optional expiry and max-uses
 * - HMAC-SHA256 signing with auto-generated server secret
 * - Single-use and multi-use token support
 * - Persistent storage to {stateDir}/threadline/invitations.json
 *
 * Part of Threadline Protocol Phase 6C.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// ── Helpers ──────────────────────────────────────────────────────────
function atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
}
function safeJsonParse(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath))
            return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return fallback;
    }
}
// ── Implementation ───────────────────────────────────────────────────
export class InvitationManager {
    threadlineDir;
    invitationsPath;
    secretPath;
    secret;
    invitations;
    constructor(options) {
        this.threadlineDir = path.join(options.stateDir, 'threadline');
        fs.mkdirSync(this.threadlineDir, { recursive: true });
        this.invitationsPath = path.join(this.threadlineDir, 'invitations.json');
        this.secretPath = path.join(this.threadlineDir, 'invitation-secret.key');
        this.secret = this.loadOrCreateSecret();
        this.invitations = this.loadInvitations();
    }
    // ── Token Creation ─────────────────────────────────────────────
    /**
     * Create a new invitation token.
     * Returns the full token string (needed for sharing with the invitee).
     */
    create(options) {
        const token = crypto.randomBytes(32).toString('hex');
        const hmac = this.computeHmac(token);
        const now = new Date();
        const invitation = {
            token,
            hmac,
            label: options?.label,
            createdAt: now.toISOString(),
            expiresAt: options?.expiresInMs
                ? new Date(now.getTime() + options.expiresInMs).toISOString()
                : null,
            maxUses: options?.maxUses ?? 1,
            useCount: 0,
            consumedBy: [],
            revoked: false,
        };
        this.invitations[token] = invitation;
        this.save();
        return token;
    }
    // ── Token Validation ───────────────────────────────────────────
    /**
     * Validate an invitation token.
     * Checks existence, HMAC integrity, expiry, use count, and revocation status.
     */
    validate(token) {
        const invitation = this.invitations[token];
        if (!invitation) {
            return { status: 'not-found', reason: 'Invitation token not found' };
        }
        // Verify HMAC integrity
        const expectedHmac = this.computeHmac(token);
        if (!crypto.timingSafeEqual(Buffer.from(invitation.hmac, 'hex'), Buffer.from(expectedHmac, 'hex'))) {
            return {
                status: 'invalid-hmac',
                invitation,
                reason: 'Invitation token HMAC verification failed — possible tampering',
            };
        }
        // Check revocation
        if (invitation.revoked) {
            return {
                status: 'revoked',
                invitation,
                reason: 'Invitation has been revoked',
            };
        }
        // Check expiry
        if (invitation.expiresAt) {
            const expiresAt = new Date(invitation.expiresAt).getTime();
            if (Date.now() > expiresAt) {
                return {
                    status: 'expired',
                    invitation,
                    reason: `Invitation expired at ${invitation.expiresAt}`,
                };
            }
        }
        // Check use count (0 = unlimited)
        if (invitation.maxUses > 0 && invitation.useCount >= invitation.maxUses) {
            return {
                status: 'exhausted',
                invitation,
                reason: `Invitation has been used ${invitation.useCount}/${invitation.maxUses} times`,
            };
        }
        return {
            status: 'valid',
            invitation,
            reason: 'Invitation is valid',
        };
    }
    // ── Token Consumption ──────────────────────────────────────────
    /**
     * Consume an invitation token for a given agent identity.
     * Single-use tokens are effectively invalidated after first consume.
     * Returns the validation result (will be 'valid' if consumption succeeded).
     */
    consume(token, agentIdentity) {
        const validation = this.validate(token);
        if (validation.status !== 'valid') {
            return validation;
        }
        const invitation = this.invitations[token];
        invitation.useCount++;
        if (!invitation.consumedBy.includes(agentIdentity)) {
            invitation.consumedBy.push(agentIdentity);
        }
        this.save();
        return {
            status: 'valid',
            invitation,
            reason: `Invitation consumed by ${agentIdentity} (use ${invitation.useCount}/${invitation.maxUses || 'unlimited'})`,
        };
    }
    // ── Token Revocation ───────────────────────────────────────────
    /**
     * Manually revoke an invitation token.
     * Returns true if the token was found and revoked, false if not found.
     */
    revoke(token) {
        const invitation = this.invitations[token];
        if (!invitation)
            return false;
        invitation.revoked = true;
        this.save();
        return true;
    }
    // ── Token Listing ──────────────────────────────────────────────
    /**
     * List all invitation tokens with their current status.
     */
    list() {
        return Object.values(this.invitations).map(inv => {
            const validation = this.validate(inv.token);
            return { ...inv, status: validation.status };
        });
    }
    // ── Persistence ────────────────────────────────────────────────
    /**
     * Force reload invitations from disk.
     */
    reload() {
        this.invitations = this.loadInvitations();
    }
    // ── Private ────────────────────────────────────────────────────
    computeHmac(token) {
        return crypto.createHmac('sha256', this.secret).update(token).digest('hex');
    }
    loadOrCreateSecret() {
        try {
            if (fs.existsSync(this.secretPath)) {
                return fs.readFileSync(this.secretPath);
            }
        }
        catch {
            // Fall through to create new secret
        }
        const secret = crypto.randomBytes(32);
        try {
            fs.writeFileSync(this.secretPath, secret, { mode: 0o600 });
        }
        catch {
            // If we can't persist, use ephemeral secret (tokens won't survive restart)
        }
        return secret;
    }
    loadInvitations() {
        const data = safeJsonParse(this.invitationsPath, {
            invitations: {},
            updatedAt: '',
        });
        return data.invitations;
    }
    save() {
        try {
            const data = {
                invitations: this.invitations,
                updatedAt: new Date().toISOString(),
            };
            atomicWrite(this.invitationsPath, JSON.stringify(data, null, 2));
        }
        catch {
            // Save failure should not break operations
        }
    }
}
//# sourceMappingURL=InvitationManager.js.map