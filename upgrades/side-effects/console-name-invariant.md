# Side-effects review — console name invariant

1. **Who sees a change?** Console users viewing machines, agents, conversations, permissions, messages, accounts, jobs, secrets, and features, and operators receiving server notices about machines. Routing and API IDs are unchanged.
2. **Can a real name be rejected?** A deliberately numeric or fingerprint-shaped name can be treated as unavailable. That is the explicit global rule the operator requested; the underlying record stays intact.
3. **Can duplicate labels confuse a picker?** Pairing, permission-slip, person-grant, conversation-settings, secret-request, and subscription action pickers omit missing names and names shared by more than one destination. This prevents a visible label from silently authorizing or changing the wrong record. The pairing flow can invite someone new; the advanced permission-slip form retains exact fingerprint entry. A verified name is needed for a named conversation setting, secret target, or subscription approval.
4. **Can a link or action lose its target?** Selectable rows still use stable IDs in keys, hrefs, API payloads, and selector values. Unresolved or duplicate names are withheld from name-based action choices until a verified unique name is available; pairing, permission slips, and person grants also retain explicit manual targeting. Pool diagnostic rows carry the machine ID in a separate field so generic display labels remain traceable.
5. **Can missing names look like success?** No. The fallback says “name unavailable” or “unnamed,” making the gap visible without presenting an ID as a title.
6. **What happens on older agents?** The console and server are shipped with Instar’s package, so updating replaces these display modules and server notice builders. The shared validator is also in the package; no config migration is needed.
7. **Rollback?** Reinstall the previous package. The change does not mutate persisted topic, peer, account, or session records.
8. **Verification?** Run the affected console unit and DOM suites, the TypeScript build, and the full local verifier on the merge tree. Check live topic and agent responses after release; the current 1.3.1530 fleet already shows verified topic names.

## 6b. Operator-surface quality

The page hierarchy and primary actions remain where they were: connect an agent, choose a conversation, start a session, or grant a permission. Technical IDs no longer appear as primary names; they remain only in routing values and clearly labelled technical details, including the exact Slack user ID shown beside the name at the PIN approval step. Destructive actions retain their existing quiet placement and confirmation. At phone width, short plain labels such as “Machine name unavailable” make missing data visible without cryptic strings. When a name is missing or duplicated, an affected menu item is disabled or omitted so the operator cannot choose the wrong target; Automatic or explicit exact-ID entry remains available where the flow supports it.

## Agent proposes, operator approves

This patch does not change who proposes a permission request or who grants it. In the normal path, the operator approves the existing structured, server-authored request with a PIN; the authority statement remains derived by the server from its structured data. The advanced hand-written slip form is pre-existing and outside this name-only change. For a person grant, the PIN sheet now shows both a usable name and the exact Slack user ID and freezes the target, action, and duration before approval, so the approved terms are exactly the terms submitted. No agent-supplied free-text authority statement is introduced.

Review verdict: The main residual risk is intentionally generic labels when no verified name exists. The rule favors honest absence over a misleading technical identifier. Action pickers require an unambiguous verified label, while form values and record keys retain their stable routing IDs.

## Second-pass review

**Reviewer:** identity_review (independent agent)

Concur with the review. The reviewer found and checked the Subscription action guards, sign-in response fields, and the machine ID separation in pool diagnostics. No remaining blocker was found in the changed paths.
