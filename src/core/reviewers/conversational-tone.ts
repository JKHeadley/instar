/**
 * Conversational Tone Reviewer — Catches technical language leaking to users.
 *
 * Detects config syntax, file paths, CLI commands, job field names, and
 * technical implementation details that should not be exposed to users.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
import { renderUntrustedConversation } from '../untrustedConversationContext.js';

export class ConversationalToneReviewer extends CoherenceReviewer {
  constructor(options?: ReviewerOptions) {
    super('conversational-tone', options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    let relationshipHint = '';
    if (context.relationshipContext) {
      const rc = context.relationshipContext;
      if (rc.communicationStyle) {
        relationshipHint += `\nRelationship communication style: ${rc.communicationStyle}`;
      }
      if (rc.formality) {
        relationshipHint += `\nRelationship formality: ${rc.formality}`;
      }
    }

    // Context-aware carve-out (context-aware-outbound-review §D3): render the
    // ONE ATOMIC block (context section + prompt contract) ONLY when the gate
    // handed this reviewer the augmented ctx (opt-in set + primary-user
    // recipient — structural scoping). Absent fields ⇒ conversationSection is
    // '' and the prompt is BYTE-IDENTICAL to feature-dark: the pre-existing
    // static "Code the user explicitly asked to see" exception stands exactly
    // as today. The renderer never throws (total containment, §D5).
    let conversationSection = '';
    if (
      context.recentConversation &&
      context.recentConversation.length > 0 &&
      context.conversationContextMeta
    ) {
      conversationSection = renderUntrustedConversation(
        context.recentConversation,
        context.conversationContextMeta,
      );
    }

    return `${preamble}

You are a communication quality reviewer. Your job: ensure agent messages to users contain NO technical implementation details.

The user should NEVER see:
- Config file references (.instar/config.json, config.yml, settings files)
- File paths (.instar/, .claude/, ~/.config/, /Users/...)
- CLI commands (curl, instar, bash, npm, git commands)
- Config keys or field names (silentReject, scheduler.enabled, authToken)
- Job internals (runOn, cron expressions, job slugs)
- Code syntax (backtick-wrapped code blocks with commands)
- API endpoints (localhost:4042, POST /feedback, GET /jobs)
- Environment variables ($AUTH, INSTAR_PORT, ANTHROPIC_API_KEY)

EXCEPTIONS (these ARE allowed):
- Slash commands that work in chat (/reflect, /evolve, /help)
- URLs the user needs to visit (dashboard links, published pages)
- Code the user explicitly asked to see

This message will be sent via ${context.channel}. Consider channel-appropriateness.
${relationshipHint}${conversationSection}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }
If pass is true, issue and suggestion can be empty strings.

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
