/**
 * identity-security-piece1f: the member turn's carrier. A locked-down, no-tools model call made
 * directly on one framework, never through the intelligence router (whose interactive pool drops the
 * hardening). The same per-framework path as the ecosystem reviewer (buildEcosystemIdeas.ts):
 *   - Claude: headless, reviewerHardening { model, noTools } (no tools, strict MCP, neutral scratch
 *     folder, prompt on stdin, env allowlist), only when the installed CLI supports the hardening;
 *   - Codex: noLocalTools.
 * Anything else has no no-tools mode, so there is no carrier and the turn is refused.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstarConfig } from '../core/types.js';
import { buildIntelligenceProvider } from '../core/intelligenceProviderFactory.js';
import { detectClaudeReviewer, detectCodexReviewer, resolveClaudeReviewerModel } from '../core/crossModelReviewer.js';
import { detectClaudePath } from '../core/Config.js';
import type { MemberTurnCaller } from './memberConversation.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK } from '../core/frameworkFacts.js';

const TURN_TIMEOUT_MS = 90_000;

/**
 * Built once, asynchronously, at boot: the Claude hardening probe (`claude --help`) runs off the event
 * loop here, never per turn. Until it resolves, the member is told "I can't answer you here right now".
 */
export async function buildMemberTurnCaller(config: InstarConfig): Promise<MemberTurnCaller> {
  let claudeHardened = false;
  try {
    const bin = detectClaudePath();
    if (bin) {
      const { stdout } = await promisify(execFile)(bin, ['--help'], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      claudeHardened = /--tools\b/.test(stdout) && /--strict-mcp-config\b/.test(stdout);
    }
  } catch { claudeHardened = false; /* @silent-fallback-ok: Claude not offered; Codex is tried, else there is no carrier */ }
  return memberTurnCaller(config, claudeHardened);
}

export function memberTurnCaller(config: InstarConfig, claudeHardened: boolean): MemberTurnCaller {
  // Every available locked-down carrier, in order; a turn tries the next when one fails (a quota wall
  // on one framework must not silence the member). Nothing without a no-tools mode is ever tried.
  const carriers: Array<{ name: string; call: (prompt: string) => Promise<string> }> = [];
  try {
    if (claudeHardened && detectClaudeReviewer().available) {
      const model = resolveClaudeReviewerModel(config as never);
      const provider = model.ok ? buildIntelligenceProvider({ framework: CLAUDE_CODE_FRAMEWORK }) : null;
      if (model.ok && provider) {
        carriers.push({ name: CLAUDE_CODE_FRAMEWORK, call: (prompt) => provider.evaluate(prompt, { reviewerHardening: { model: model.model, noTools: true }, timeoutMs: TURN_TIMEOUT_MS, attribution: { component: 'MemberConversation' } }) });
      }
    }
  } catch { /* @silent-fallback-ok: Claude unusable here; Codex is tried next, else there is no carrier */ }
  try {
    if (detectCodexReviewer().available) {
      const provider = buildIntelligenceProvider({ framework: CODEX_CLI_FRAMEWORK });
      if (provider) carriers.push({ name: CODEX_CLI_FRAMEWORK, call: (prompt) => provider.evaluate(prompt, { model: 'balanced', noLocalTools: true, timeoutMs: TURN_TIMEOUT_MS, attribution: { component: 'MemberConversation' } }) });
    }
  } catch { /* @silent-fallback-ok: no carrier; the member is told "I can't answer you here right now" */ }
  if (carriers.length === 0) return null;
  return async (prompt) => {
    let last: unknown = null;
    for (const c of carriers) {
      try { return await c.call(prompt); } catch (err) {
        last = err;
        console.warn(`[member-conversation] ${c.name} turn failed: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
      }
    }
    throw last instanceof Error ? last : new Error('every no-tools carrier failed');
  };
}
