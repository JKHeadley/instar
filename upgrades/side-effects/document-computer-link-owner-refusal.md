# Computer link directions and owner refusal

Tier 1. This is a reversible change to the display and order of an existing refusal. The device registry identifies the already authenticated phone. Both the explicit and legacy owner roles are refused before the member-only storage checks. Team phones still require current team standing and an intact signed record before linking. The backend continues to refuse unknown roles.

- Over-block: The owner remained ineligible for this flow before the change. Team phones use the same checks as before.
- Under-block: Existing checks for scope, expiry, host, signed requests and allowances still determine what a team phone may do.
- Layer and authority: The route owns its response, and the dashboard owns the navigation copy. Under docs/signal-vs-authority.md, the message explains an existing authority decision and adds no new permission.
- Interactions: Refusal happens before nonce use, browser creation or any log write. Member requests still fail closed if team storage is unavailable.
- Rollback: Revert the commit. No data migration or config change is needed.
- Evidence: 6 wording tests, 18 HTTP tests and 10 production server lifecycle tests passed. The HTTP regression checks the owner and member responses with no team log and verifies no events were written.

Independent review: Concur with the review. The early role check follows the existing owner mapping and adds no authority.

## 6b. Operator-surface quality

1. The scan page leads with the QR and the steps to reach the scanner. The owner's refusal leads with opening the agent dashboard and following browser approval.
2. The page and the refusal show familiar app labels and actions. They expose no storage detail, identifier or server status as primary content.
3. The change adds no destructive controls. Linking itself still requires the existing confirmation.
4. The directions are short sentences. The updated navigation is a single line of plain text that wraps at phone width.
