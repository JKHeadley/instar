/**
 * NicknameCommand — the recognized "move / run / pin this on <machine-nickname>"
 * command shape (Multi-Machine Session Pool §L4). The headline test-as-self
 * scenario: the user, mid-conversation, says "move this to the mini" and the
 * session transfers to that machine.
 *
 * HISTORY (2026-07-03): the recognizer that PRODUCED this shape used to be a
 * keyword verb-list (`recognizeNicknameCommand`, `TRANSFER_VERBS = [move, …,
 * run, continue, resume, keep]`). That list hijacked the operator — "keep the
 * work on the laptop" (plain discussion) matched the `keep` verb and swallowed
 * the message before the agent saw it. Under the constitutional standard
 * "Intelligence Infers, Keywords Only Guard" the decision "is this a move
 * command?" — a judgment about what the human MEANT — is now inferred by an LLM
 * over the message + recent conversation context in `MoveIntentClassifier`
 * (`classifyRelocationIntent` → `toNicknameCommand`), NEVER a verb list. The
 * known-nickname set is retained purely as a structured-output guardrail.
 *
 * This module keeps ONLY the command TYPE — the value object the downstream
 * planner (`TransferByNickname.planTransferByNickname`) and resolver
 * (`RelocationNicknameSet`) consume. Both are unchanged: only the recognizer's
 * DECISION moved from keyword→LLM.
 */

export interface NicknameCommand {
  /** 'transfer' (move an existing session) vs 'pin' (hard-pin future placement). */
  intent: 'transfer' | 'pin';
  /** The known nickname that was matched (canonical form as registered). */
  nickname: string;
  /**
   * Provenance of the recognition, for audit/telemetry. Historically the keyword
   * phrase that triggered the match; now `'llm-inferred'` from the classifier.
   */
  matchedVerb: string;
}
