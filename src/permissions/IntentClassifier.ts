/**
 * IntentClassifier — turn a natural-language request into a {action, tier, floorAction, confidence}.
 *
 * Two implementations:
 *   - HeuristicIntentClassifier (here): deterministic, keyword-based, conservative.
 *     Used for the floor (the dangerous path must NOT depend on an LLM — fail-closed)
 *     and for the deterministic CI scenario suite. When uncertain whether something is
 *     a floor action, it leans floor + low-confidence so the gate routes to CLARIFY.
 *   - LlmIntentClassifier (LlmIntentClassifier.ts): wraps an IntelligenceProvider for the
 *     judgment band. Per the "no silent degradation to brittle fallback" standard, it is
 *     only used ABOVE the floor; floor detection stays deterministic here.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.5–6.6.
 */

import type { RequestIntent, SensitivityTier, FloorAction } from './types.js';

export interface IntentClassifier {
  classify(text: string, ctx: { directed: boolean }): Promise<RequestIntent>;
}

const DEPLOY_VERB = /\b(deploy|deploys|deploying|ship|shipping|push|pushing|release|releasing|roll\s?out|cut a release)\b/;
const PROD_NOUN = /\b(prod|production|live|the prod|to prod)\b/;
const MONEY = /\b(wire|wiring|transfer|remit|pay|payment|send money|payout)\b|\$\s?\d/;
const CRED_NOUN = /\b(api key|apikey|token|password|secret|credential|credentials|private key)\b/;
const CRED_VERB = /\b(give|share|send|show|reveal|access|rotate|get|fetch|export|print)\b/;
const DESTRUCTIVE_VERB = /\b(delete|drop|wipe|nuke|truncate|purge|destroy)\b|\brm\s+-rf\b/;
const DESTRUCTIVE_NOUN = /\b(db|database|table|tables|data|records|prod|production|staging|everything|the whole)\b/;
const GRANT_VERB = /\b(make|give|grant|promote|elevate|add)\b/;
const GRANT_NOUN = /\b(admin|owner|root|access|authority|permission|permissions|privileges)\b/;
const EXTERNAL_VERB = /\b(email|e-mail|send|reply|forward|message)\b/;
const EXTERNAL_NOUN = /\b(client|clients|customer|customers|vendor|vendors|external|outside|outsider|partner|press|public)\b/;

const READ_VERB = /\b(summar\w*|what is|what's|look up|lookup|find out|explain|status|draft|tell me|show me|recap|describe|list)\b/;
const WRITE_VERB = /\b(post|create|file a ticket|open a ticket|schedule|add a|write up|note)\b/;
const OP_VERB = /\b(run|trigger|kick off|start|rerun|re-run)\b/;
const OP_NOUN = /\b(job|task|script|pipeline|staging|test|tests|build)\b/;

// ── Conversational self-post detection (member-seat false-positive fix) ──────────
// A "post a check-in note here in 5 minutes" is the bot AUTHORING conversational
// content into the CURRENT conversation — not an organizational write. It carries
// no floor signal (floor detection runs FIRST and always wins) and no org-write /
// external side-effect. Such a request is conversational (T1 read/draft level), so
// an ordinary member may direct it — the earlier blanket T2 low-write classification
// wrongly put it above the member ceiling and refused every member.
//
// A verb that FRAMES posting/scheduling conversational content...
const SELF_POST_VERB = /\b(post|drop|leave|put|write|schedule|set|send|remind|share)\b/;
// ...applied to a conversational-content noun (a note, check-in, reminder, update…).
const CONVERSATIONAL_NOUN =
  /\b(note|notes|check[- ]?in|checkin|reminder|reminders|heads[- ]?up|update|updates|standup|stand[- ]?up|message|ping|nudge)\b/;
// An organizational-write or EXTERNAL side-effect marker — its presence means this is
// NOT a harmless conversational post but a genuine low-write/external action that must
// keep its higher tier (a ticket, a record, another/named channel, a doc, a calendar
// hold, an email, an outside party). Any match disqualifies the conversational path.
const ORG_WRITE_OR_EXTERNAL_MARKER =
  /\b(ticket|tickets|jira|linear|asana|notion|confluence|wiki|calendar|invite|record|records|doc|docs|document|documents|announcement|announcements|another channel|other channel|email|e-mail|invoice|spreadsheet|sheet|client|clients|customer|customers|vendor|vendors|external|outside|partner|press|public)\b|#[a-z0-9][\w-]*/i;
// An operational marker — asking the bot to RUN/DEPLOY/execute something is never a
// conversational post, even if phrased as "post a note to run …". Disqualifies too.
const OPERATIONAL_MARKER =
  /\b(run|trigger|execute|kick off|deploy|rerun|re-run|migrat\w+|job|pipeline|build|script)\b/;

/**
 * Is this a harmless conversational self-post (a note / check-in / reminder / status
 * update the bot would post into the CURRENT conversation)? Deterministic and
 * conservative: it requires BOTH a self-post verb AND a conversational-content noun,
 * and it disqualifies on ANY organizational-write / external / operational marker.
 * Floor actions are already handled (and short-circuited) before this runs, so this
 * only ever sees non-floor text. Requiring both a post-verb AND a content-noun keeps
 * plain chatter ("just checking in, how's it going?") at T0 rather than promoting it.
 */
export function isConversationalSelfPost(t: string): boolean {
  if (ORG_WRITE_OR_EXTERNAL_MARKER.test(t)) return false;
  if (OPERATIONAL_MARKER.test(t)) return false;
  return SELF_POST_VERB.test(t) && CONVERSATIONAL_NOUN.test(t);
}

/** Does the text CLAIM an authorization from some named party ("X said it's fine")? */
export function mentionsClaimedAuthority(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(\w+\s+)?(said|told me|says|approved|authorized|okayed|gave the ok|signed off)\b/.test(t)
    && /\b(it'?s fine|approved|ok(ay)?|go ahead|do it|fine|allowed|permission)\b/.test(t);
}

function intent(
  action: string,
  tier: SensitivityTier,
  confidence: number,
  directed: boolean,
  floorAction?: FloorAction,
  conversational?: boolean,
): RequestIntent {
  return { action, tier, floorAction, confidence, directed, conversational };
}

/**
 * Deterministic, conservative classifier. Floor detection is ordered first and
 * leans toward treating an ambiguous "ship/deploy" as a possible floor action at
 * LOW confidence so the gate clarifies rather than guesses.
 */
export class HeuristicIntentClassifier implements IntentClassifier {
  // eslint-disable-next-line @typescript-eslint/require-await
  async classify(text: string, ctx: { directed: boolean }): Promise<RequestIntent> {
    const t = (text || '').toLowerCase();
    const directed = ctx.directed;

    // ── Layer 0 floor detection (deterministic, conservative) ──
    if (DEPLOY_VERB.test(t) && PROD_NOUN.test(t)) {
      return intent('prod-deploy', 4, 0.92, directed, 'prod-deploy');
    }
    if (MONEY.test(t)) {
      return intent('money-movement', 4, 0.9, directed, 'money-movement');
    }
    if (CRED_NOUN.test(t) && CRED_VERB.test(t)) {
      return intent('credential-access', 4, 0.88, directed, 'credential-access');
    }
    if (DESTRUCTIVE_VERB.test(t) && DESTRUCTIVE_NOUN.test(t)) {
      return intent('destructive-data', 4, 0.88, directed, 'destructive-data');
    }
    if (GRANT_VERB.test(t) && GRANT_NOUN.test(t)) {
      return intent('grant-authority', 4, 0.88, directed, 'grant-authority');
    }
    if (EXTERNAL_VERB.test(t) && EXTERNAL_NOUN.test(t)) {
      return intent('external-send', 4, 0.82, directed, 'external-send');
    }

    // ── Ambiguous deploy/ship with no object ("ship it") — possibly floor, low confidence ──
    if (DEPLOY_VERB.test(t)) {
      // Looks like a deploy/ship but no prod/object marker → could be a floor deploy or a
      // harmless "send the draft". Treat as possibly-floor at LOW confidence → CLARIFY.
      return intent('ambiguous', 4, 0.4, directed);
    }

    // ── Non-floor tiers ──
    if (OP_VERB.test(t) && OP_NOUN.test(t)) {
      return intent('operational', 3, 0.78, directed);
    }
    // Harmless conversational self-post (note/check-in/reminder into the current
    // conversation, no org/external/operational marker) → T1, not the T2 low-write
    // that wrongly refused ordinary members. Checked BEFORE the generic WRITE_VERB
    // branch so "post a check-in note here" isn't swept up as a low-write.
    if (isConversationalSelfPost(t)) {
      return intent('conversational-post', 1, 0.78, directed, undefined, true);
    }
    if (WRITE_VERB.test(t)) {
      return intent('low-write', 2, 0.78, directed);
    }
    if (READ_VERB.test(t)) {
      return intent('read', 1, 0.8, directed);
    }

    // ── Default: ambient discussion ──
    return intent('discussion', 0, 0.6, directed);
  }
}
