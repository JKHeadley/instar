# Side-Effects Review — Web Message Actions

## Summary

Browser-only client increment using existing signed device transport for three separate server authorities. There is no new route, device tier, admission rule, or capability setting. Main lacks the affirmative capabilities for these actions, so it remains dark.

## Decision-point Inventory

The console uses signed App list rows and exact settled event IDs. It uses the existing quote endpoint and carries the selected event in the same unfinished request through retries. It never falls back to an unquoted request. A definitive quote-source refusal restores the draft or offers a restore control if another draft has since started. It displays only server-projected reply previews.

The reaction starts with an exact signed read and writes the revision and desired value. The client keeps ambiguous retries bound to the original event and request. Forward requires an affirmative capability on the source and destination and equal authoritative custodians. It sends only the exact source, destination path, custodian and stable operation ID. A generic hosting hint does not qualify. The current server checkpoint lacks affirmative Forward capability, so the UI stays hidden there. Test fixtures supply it without making live requests.

## 6b. Operator-surface Quality

Reply, React and Forward share the message options sheet with existing Pin. Drafts clearly show the quoted selection. Forward lists only eligible destinations. The user explicitly selects any change. Read-only previews and every dynamic label use text nodes. Uncertain results and refusals remain visible in the action sheet.

## Multi-machine posture

The browser signs every action through its existing session. The recipient machine still validates custody. Forward requires the same advertised custodian at both ends. There is no remote fallback. Existing polling, conversation URL, and credential check still apply.

## Rollback

Revert the browser changes. Server preferences, conversation history and existing signed writes are unaffected.

## Class-Closure Declaration

No agent-authored-artifact defect or new controller.

## Independent review

message_actions_review checked the route contracts and granted-capability boundaries. The follow-up confirmed exact signed quote revalidation, monotonic reaction merges, and guarded quote retries. The Forward projection remains a server dependency.
