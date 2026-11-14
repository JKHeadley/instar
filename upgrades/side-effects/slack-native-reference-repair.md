# Side-Effects Review — Slack native references and names

**Version / slug:** slack-native-reference-repair
**Date:** 2026-11-04
**Author:** Echo
**Tier:** 1 — narrow, reversible formatting and context repair; 10 source/test files plus 2 review notes; one test review round and one commit gate planned.
**Second-pass reviewer:** independent /instar-dev reviewer — concurred after two safety revisions

## Summary of the change

The Slack formatter preserves validated agent-authored user, channel, and safe link references only when a bound agent explicitly selects `--native-reference TARGET` for each intended target; ordinary replies escape them. Broadcast forms always remain escaped in formatter mode, including the oversized fallback. The Slack session context resolves other participants' names and encodes inbound text before an agent can quote it. The decision points are the formatter's structural token parser and the context display transform; the existing Slack send and authorization funnels remain in place.

## Decision-point inventory

- Native reference parser — modified — accepts only enumerated Slack syntax after code extraction.
- Link scheme check — passed through — existing URL allowlist still controls clickable links.
- Context rendering — modified — inbound text is encoded; distinct participant IDs are resolved to names with ID fallback.

## 1. Over-block

A malformed or short user ID such as `<@U123>` stays literal even if a test workspace happened to use it. Valid Slack user IDs in the observed workspace meet the accepted shape. A Slack link with a non-allowlisted scheme stays literal. Code examples of references remain literal by design.

## 2. Under-block

The explicit target list limits active references to named IDs and URLs. A copied reference to a different target stays literal. An untrusted excerpt that names an already-authorized target can still appear as another active occurrence; the agent should avoid copying that excerpt into the same reply. The agent must respect instructions about when a ping is appropriate. A caller selecting legacy passthrough bypasses this formatter's protections, as it did before this change. Inbound text in an unrelated tool result is outside this Slack context transform.

## 3. Level-of-abstraction fit

The formatter owns Slack syntax conversion at the outbound chokepoint. It applies a deterministic protocol grammar, not a conversational judgment about whether a person deserves notification. The session context builder owns names and incoming-text presentation; it uses the existing Slack user lookup rather than another identity store.

## 4. Signal vs authority compliance

[Signal vs authority](../../docs/signal-vs-authority.md) allows hard protocol invariants at a boundary. The parser is a structural Slack grammar and a broadcast safety floor. It makes no conversational allow/block choice. The bound agent must explicitly select the relay flag to activate individual references. No new LLM gate is added.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals judgment point. The accepted token forms and denied broadcast forms are enumerable Slack protocol shapes.

## 5. Interactions

Code extraction precedes native-reference extraction, so quoted code cannot ping. The relay target list is carried through the bound session route and stripped from Slack API params. The shipped-template migration allowlist now includes the two earlier revisions of this PR that the first-parent history lint sees after merging current main; each hash comes from a reviewed PR commit, so only those exact relay bytes gain overwrite authority. Reference extraction precedes prose escaping, so intentional syntax survives exactly once. Markdown link conversion and the existing safe-scheme check remain active. Names are cached by the adapter; failed lookups leave the prior ID fallback. No shared state or retry loop is added.

## 6. External surfaces

Slack recipients see rendered references and may receive a notification for an individually mentioned user. The channel and link display correctly. Session context shows participant names when available. The final live post used Echo's demo bot to mention a real human member in the isolated mention-proof channel. Slack readback kept that mention active and left a copied example literal.

## 6b. Operator-surface quality

No dashboard, approval form, or other operator surface is changed.

## 7. Multi-machine posture

Replicated through the same shipped code on each machine; there is no new durable state. Names are read from Slack on each machine through its adapter. Replies still use the existing one-voice delivery funnel. No new notices or generated machine URLs are introduced. Topic transfer cannot strand this behavior.

## 8. Rollback cost

Revert and release a patch, or select the existing Slack `legacy-passthrough` mode for immediate formatter rollback. No data migration or agent state repair is needed. During a rollback window, references again appear as raw text.

## Conclusion

The live post and targeted tests support the narrow protocol repair. The first second-pass review found a missing provenance choice and an oversized-message bypass; both were fixed. Broadcast references remain inert in formatter mode and inbound context remains encoded. The per-target authorization caveat is recorded above.

## Second-pass review

**Reviewer:** independent /instar-dev reviewer. **Finding:** the original design was not safe; an explicit per-target bound relay choice and oversized fallback escape were added. **Final re-review:** concurred with the per-target design. The same-target excerpt and legacy-mode limits are recorded in Under-block. **Current-main SHA repair review:** an independent /instar-dev reviewer rehashed both PR revisions, confirmed the allowlist contains their exact bytes, and concurred that the isolated real-human Slack readback supports release.

## Evidence pointers

- Before: `slack-mrkdwn-formatter.test.ts` failed on the supplied mention; 60 tests passed, 1 failed.
- After: formatter, history-label, and wire-up suites passed: 81 tests; the bound-route integration suite passed 4 tests and verifies the opt-in field reaches the adapter. A mocked canonical relay invocation proved the explicit target list enters the bound-session request body.
- Live Slack workspace `T0AQ9MLRHEC`, test channel `C0CES4G5H0B`, message `1793820889.173479`: history returned active self mention, channel reference, safe link, and escaped broadcast tokens.

- Final live human proof against the candidate built from merged main: demo workspace `T0AQ9MLRHEC`, channel `C0CES4G5H0B`, bot message `1793859757.182909`. Slack readback returned active `<@U0AP927E2R1>`; `users.info` verified that ID is human member Justin Headley (`is_bot:false`), and the copied code example remained `&lt;@U0C62ABNDK8&gt;`. The human was added to the isolated channel before posting; no shared canary restarted.
- Local SHA-history test: 3 passed after adding hashes for the two earlier PR revisions.
