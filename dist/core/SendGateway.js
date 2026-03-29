/**
 * SendGateway — Central review point for all outbound messages.
 *
 * Three-stage pipeline:
 *   1. PEL — Credential/PII/auth token detection (fail-closed)
 *   2. Convergence — 7 heuristic quality checks (fail-open)
 *   3. CoherenceGate — LLM specialist reviewers (fail-open, optional)
 *
 * All outbound channels must register and call review() before sending.
 * Unregistered channels are blocked by default.
 */
import { PolicyEnforcementLayer } from './PolicyEnforcementLayer.js';
import { checkConvergence } from './ConvergenceChecker.js';
// ── Implementation ──────────────────────────────────────────────────
export class SendGateway {
    pel;
    coherenceGate;
    channels = new Map();
    stats = new Map();
    stateDir;
    constructor(config) {
        this.stateDir = config.stateDir;
        this.pel = new PolicyEnforcementLayer(config.stateDir);
        this.coherenceGate = config.coherenceGate ?? null;
    }
    /** Register an outbound channel. Must be called before review() for that channel. */
    register(channel) {
        this.channels.set(channel.channelId, channel);
        if (!this.stats.has(channel.channelId)) {
            this.stats.set(channel.channelId, { reviewed: 0, passed: 0, blocked: 0, warnings: 0 });
        }
    }
    /** Get all registered channel IDs. */
    getRegisteredChannels() {
        return Array.from(this.channels.keys());
    }
    /** Check if a channel is registered. */
    isRegistered(channelId) {
        return this.channels.has(channelId);
    }
    /** Get review stats per channel. */
    getStats() {
        const result = {};
        for (const [id, s] of this.stats) {
            result[id] = { ...s };
        }
        return result;
    }
    /**
     * Review an outbound message through the three-stage pipeline.
     *
     * Stage 1 (PEL): Always runs. hard_block → fail-closed.
     * Stage 2 (Convergence): Skipped for system/bridge messages. Fail-open.
     * Stage 3 (CoherenceGate): Only for external, agent messages >50 chars
     *   when CoherenceGate is configured. Fail-open.
     */
    async review(request) {
        const start = Date.now();
        // ── Unregistered channel check ────────────────────────────────
        const channel = this.channels.get(request.channelId);
        if (!channel) {
            return {
                pass: false,
                reason: `Channel "${request.channelId}" is not registered with SendGateway`,
                blockedBy: 'unregistered',
                durationMs: Date.now() - start,
            };
        }
        const channelStats = this.stats.get(request.channelId);
        channelStats.reviewed++;
        const isExternal = request.isExternalFacing ?? channel.isExternalFacing;
        const recipientType = request.recipientType ?? channel.defaultRecipientType;
        const origin = request.messageOrigin ?? 'agent';
        const warnings = [];
        // ── Stage 1: PEL (always runs, fail-closed) ──────────────────
        try {
            const pelResult = this.pel.enforce(request.message, {
                channel: request.channelId,
                isExternalFacing: isExternal,
                recipientType,
                stateDir: this.stateDir,
            });
            if (pelResult.outcome === 'hard_block') {
                channelStats.blocked++;
                const violations = pelResult.violations
                    .filter(v => v.severity === 'hard_block')
                    .map(v => v.detail);
                return {
                    pass: false,
                    reason: `PEL blocked: ${violations.join('; ')}`,
                    blockedBy: 'pel',
                    durationMs: Date.now() - start,
                };
            }
            if (pelResult.outcome === 'warn') {
                for (const v of pelResult.violations) {
                    warnings.push(`[PEL] ${v.detail}`);
                }
            }
        }
        catch (err) {
            // PEL errors are fail-open (the PEL itself is designed to be safe)
            warnings.push(`[PEL] Error during enforcement: ${err instanceof Error ? err.message : String(err)}`);
        }
        // System and bridge messages: PEL-only
        if (origin === 'system' || origin === 'bridge') {
            if (warnings.length > 0)
                channelStats.warnings++;
            else
                channelStats.passed++;
            return {
                pass: true,
                warnings: warnings.length > 0 ? warnings : undefined,
                durationMs: Date.now() - start,
            };
        }
        // ── Stage 2: Convergence (fail-open) ─────────────────────────
        try {
            const convergence = checkConvergence(request.message);
            if (!convergence.pass) {
                for (const issue of convergence.issues) {
                    warnings.push(`[convergence:${issue.category}] ${issue.detail}`);
                }
            }
        }
        catch (err) {
            warnings.push(`[convergence] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Stage 3: CoherenceGate LLM review (fail-open, conditional) ──
        const shouldRunLLM = (this.coherenceGate &&
            isExternal &&
            request.message.length > 50);
        if (shouldRunLLM) {
            try {
                const evalResult = await this.coherenceGate.evaluate({
                    message: request.message,
                    sessionId: request.sessionId || 'send-gateway',
                    stopHookActive: false,
                    context: {
                        channel: request.channelId,
                        isExternalFacing: isExternal,
                        recipientType,
                        ...request.context,
                    },
                });
                if (!evalResult.pass) {
                    channelStats.blocked++;
                    return {
                        pass: false,
                        reason: `CoherenceGate blocked: ${evalResult.feedback || 'Review failed'}`,
                        blockedBy: 'coherence-gate',
                        warnings: warnings.length > 0 ? warnings : undefined,
                        durationMs: Date.now() - start,
                    };
                }
                if (evalResult.warnings && evalResult.warnings.length > 0) {
                    warnings.push(`[coherence-gate] ${evalResult.warnings.join('; ')}`);
                }
            }
            catch (err) {
                // CoherenceGate errors are fail-open
                warnings.push(`[coherence-gate] Error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // ── Result ───────────────────────────────────────────────────
        if (warnings.length > 0)
            channelStats.warnings++;
        else
            channelStats.passed++;
        return {
            pass: true,
            warnings: warnings.length > 0 ? warnings : undefined,
            durationMs: Date.now() - start,
        };
    }
    /** Clean up resources. */
    destroy() {
        this.pel.destroy();
    }
}
//# sourceMappingURL=SendGateway.js.map