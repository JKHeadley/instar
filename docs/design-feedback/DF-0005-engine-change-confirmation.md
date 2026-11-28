# DF-0005: Engine-change questions must explain their effect

Status: implementation and verification in progress. No live deployment claim.

The owner reported that the cross-conversation engine-change confirmation was confusing and that a numbered answer did not apply. The report reached this project through Chief of Staff on 2026-11-22, feedback `fb-3cc52686-5b6`. The original conversation and any captures remain in the private agent records; no owner screenshot is published here.

The question used internal words such as framework, live and exact change without explaining what would happen to the person's work. One pending question silently replaced another. A later agent message could cancel it, and an intentional repeat could be hidden by duplicate-content suppression.

| Problem | Standard rule | Concrete repair |
| --- | --- | --- |
| Internal engine identifier was the main content | DS-WORDS-2, DS-WORDS-3 | Human conversation and engine names, actual restart/context consequences |
| No clear meaning or action for the person | DS-WORDS-6, DS-ACTION-6 | Plain question and an explicit instruction to reply to that message with yes |
| Pending questions disappeared | DS-STATE-3, DS-STATE-4 | Separate request identities and delivery receipts; agent activity never deletes identified questions |
| A failed or ambiguous answer offered no recovery | DS-STATE-3, DS-WORDS-6 | Nonexact prose reaches the agent; server-owned reminder or safe clarification, never inferred consent |
| An old/unknown answer could be misreported | DS-STATE-5 | Distinguish saved settings, skipped restart, pending delivery and unknown historical outcome |

The final policy deliberately does **not** interpret numbered or quoted prose as permission. Chief of Staff's final disposition preserves exact yes tied to a delivered question. Other wording reaches the conversational agent and may prompt a reminder. The broader semantic-consent proposal remains unapproved.

This case sharpens the existing rules into a checkable acceptance contract: every actionable reminder repeats every stored effect; concurrent questions and send callbacks remain correctly bound; a saved change survives acknowledgment failure as a known result; shared or unreadable audiences receive no pending-request details. The implementation tests exercise those boundaries in unit, HTTP and boot-path lifecycle checks. A real user-channel journey remains separate evidence and must not be replaced by a mocked delivery claim.

The design standard referenced here is carried by the design-standards project. This case changes no earned rule or tolerance; it adds concrete examples and structural regression checks for the existing wording and recovery rules.
