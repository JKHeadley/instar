/**
 * Upgrade Notify Manager — reliable delivery of upgrade guides to agents.
 *
 * After an update, a short Claude session is spawned to:
 *   1. Notify the user via Telegram
 *   2. Update MEMORY.md with new capabilities
 *   3. Acknowledge the guide (instar upgrade-ack)
 *
 * This module owns the verification and retry logic:
 *   - After the session completes, check if the pending guide was cleared
 *   - If not, retry with a more capable model (haiku → sonnet)
 *   - Log success/failure for observability
 *
 * Born from the observation that fire-and-forget Haiku sessions silently
 * fail ~30% of the time on multi-step tasks. Verification closes the loop.
 */
import fs from 'node:fs';
/** Model escalation chain — try faster models first, escalate on failure */
const MODEL_CHAIN = ['haiku', 'sonnet'];
/** Default timing constants (overridable via UpgradeNotifyTiming for testing) */
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_POST_COMPLETION_DELAY_MS = 5_000; // 5 seconds
export class UpgradeNotifyManager {
    config;
    spawnSession;
    isSessionComplete;
    logActivity;
    timing;
    constructor(config, spawnSession, isSessionComplete, logActivity, timing) {
        this.config = config;
        this.spawnSession = spawnSession;
        this.isSessionComplete = isSessionComplete;
        this.logActivity = logActivity;
        this.timing = {
            sessionTimeoutMs: timing?.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
            pollIntervalMs: timing?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
            postCompletionDelayMs: timing?.postCompletionDelayMs ?? DEFAULT_POST_COMPLETION_DELAY_MS,
        };
    }
    /**
     * Run the upgrade notification with verification and retry.
     * Returns the result of the notification attempt.
     */
    async notify() {
        const guideContent = this.readPendingGuide();
        if (!guideContent) {
            return { success: true, model: 'haiku', attempts: 0 }; // Nothing to do
        }
        let lastError;
        for (let i = 0; i < MODEL_CHAIN.length; i++) {
            const model = MODEL_CHAIN[i];
            const attempt = i + 1;
            console.log(`[UpgradeNotify] Attempt ${attempt}/${MODEL_CHAIN.length} with ${model}...`);
            try {
                const prompt = this.buildPrompt(guideContent);
                const session = await this.spawnSession({
                    name: 'upgrade-notify',
                    prompt,
                    model,
                    jobSlug: 'upgrade-notify',
                    maxDurationMinutes: 5,
                });
                // Wait for session to complete
                const completed = await this.waitForCompletion(session.id);
                if (!completed) {
                    lastError = `Session timed out after ${this.timing.sessionTimeoutMs / 1000}s`;
                    console.warn(`[UpgradeNotify] ${lastError} (${model})`);
                    continue;
                }
                // Brief delay for filesystem sync
                await new Promise(r => setTimeout(r, this.timing.postCompletionDelayMs));
                // Check if the pending guide was acknowledged
                if (this.isAcknowledged()) {
                    console.log(`[UpgradeNotify] Success — guide acknowledged on attempt ${attempt} (${model})`);
                    this.logActivity({
                        type: 'upgrade_notify_success',
                        summary: `Upgrade guide delivered and acknowledged (${model}, attempt ${attempt})`,
                        metadata: { model, attempt },
                    });
                    return { success: true, model, attempts: attempt };
                }
                lastError = `Session completed but guide was not acknowledged`;
                console.warn(`[UpgradeNotify] ${lastError} (${model}) — ${i < MODEL_CHAIN.length - 1 ? 'escalating model' : 'no more retries'}`);
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                console.error(`[UpgradeNotify] Spawn failed (${model}): ${lastError}`);
            }
        }
        // All attempts exhausted
        console.error(`[UpgradeNotify] All ${MODEL_CHAIN.length} attempts failed. Pending guide preserved for next session-start.`);
        this.logActivity({
            type: 'upgrade_notify_failed',
            summary: `Upgrade guide notification failed after ${MODEL_CHAIN.length} attempts: ${lastError}`,
            metadata: { attempts: MODEL_CHAIN.length, lastError },
        });
        return {
            success: false,
            model: MODEL_CHAIN[MODEL_CHAIN.length - 1],
            attempts: MODEL_CHAIN.length,
            error: lastError,
        };
    }
    /**
     * Build the upgrade-notify prompt with all context.
     */
    buildPrompt(guideContent) {
        const { dashboardPin, currentVersion, replyScript, notifyTopicId } = this.config;
        const dashboardUrl = this.config.tunnelUrl
            ? `${this.config.tunnelUrl}/dashboard`
            : `http://localhost:${this.config.port}/dashboard`;
        const hasReplyScript = !!replyScript;
        return [
            'IMPORTANT: You are a SHORT-LIVED session with a SPECIFIC task. Do NOT search for files or explore the codebase. Everything you need is in this prompt.',
            '',
            'You have been updated to a new Instar version. Read the upgrade guide below, then do ALL THREE steps.',
            'IMPORTANT: The guide below contains ONLY what is new in THIS update. Do not mention features from previous updates.',
            '',
            '',
            '## Step 1: Notify your user',
            '',
            'Compose a brief, personalized message (3-8 sentences) for your user about the new features.',
            '   RULES:',
            '   - Write like you\'re texting a friend — warm, conversational, no jargon',
            '   - This should NOT look like a changelog or release notes',
            '   - Lead with the biggest USER-VISIBLE feature',
            '   - Include CONCRETE details — actual URLs, PINs, things they can click/use right now',
            '   - NEVER mention "bearer tokens", "auth tokens", version numbers in headers, or internal implementation details',
            '   - Focus on what matters to THEM, not internal plumbing',
            '   - NO bullet lists, NO markdown headers, NO technical formatting — just natural sentences',
            '',
            '   CONCRETE DETAILS TO INCLUDE:',
            `   - Dashboard URL: ${dashboardUrl}`,
            dashboardPin ? `   - Dashboard PIN: ${dashboardPin}` : '   - No dashboard PIN set',
            `   - Current version: ${currentVersion}`,
            '',
            'Send the message via Telegram:',
            hasReplyScript && notifyTopicId
                ? `   Run: cat <<'MSGEOF' | bash ${replyScript} ${notifyTopicId}\nYOUR_MESSAGE_HERE\nMSGEOF`
                : '   Use the telegram-reply script in .instar/scripts/ to send to the updates topic.',
            '',
            '## Step 2: Update your memory with new capabilities',
            '',
            'Read the upgrade guide\'s "Summary of New Capabilities" section and add the relevant information to your MEMORY.md file (.instar/MEMORY.md).',
            'This ensures you KNOW about these capabilities in every future session — not just this one.',
            '',
            'Add a section like:',
            '```',
            '## Capabilities Added in vX.Y.Z',
            '- Brief description of each capability',
            '- How to use it (API endpoints, commands, automatic behaviors)',
            '- Any behavioral changes you should be aware of',
            '```',
            '',
            'Keep it concise — focus on WHAT you can now do and HOW to do it, not the implementation details.',
            'If there are existing capability notes in MEMORY.md, update or merge rather than duplicate.',
            '',
            '## Step 3: Acknowledge',
            '',
            'Run: instar upgrade-ack',
            '',
            'Do all three steps, then exit. Do not search for files or read config files beyond MEMORY.md.',
            '',
            '--- UPGRADE GUIDE ---',
            guideContent,
            '--- END GUIDE ---',
        ].join('\n');
    }
    /**
     * Check if the pending guide has been acknowledged (file removed by upgrade-ack).
     */
    isAcknowledged() {
        return !fs.existsSync(this.config.pendingGuidePath);
    }
    /**
     * Read the pending upgrade guide content. Returns null if no guide exists.
     */
    readPendingGuide() {
        try {
            if (!fs.existsSync(this.config.pendingGuidePath))
                return null;
            const content = fs.readFileSync(this.config.pendingGuidePath, 'utf-8');
            return content.trim() || null;
        }
        catch {
            // @silent-fallback-ok — pending guide returns null
            return null;
        }
    }
    /**
     * Poll until the session completes or times out.
     */
    async waitForCompletion(sessionId) {
        const deadline = Date.now() + this.timing.sessionTimeoutMs;
        while (Date.now() < deadline) {
            if (this.isSessionComplete(sessionId)) {
                return true;
            }
            await new Promise(r => setTimeout(r, this.timing.pollIntervalMs));
        }
        return false;
    }
}
//# sourceMappingURL=UpgradeNotifyManager.js.map