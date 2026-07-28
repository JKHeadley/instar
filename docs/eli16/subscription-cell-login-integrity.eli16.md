# Subscription cell login integrity — ELI16

The account-by-machine cell is the operator's single source of truth. If a credential's live identity no longer matches the account label, that cell must say “Needs sign-in” and offer the PIN-gated Sign in action. It must never keep saying Active because an older observation arrived later.

If a sign-in is already underway, its durable pending-login record reconstructs the complete link-and-code flow inside that same cell after a server or browser restart. Client-only repair state is not required for recovery. A stale Active pool row can no longer hide the durable flow when the account is drifted.

Automatic link renewal is maintenance, not consent to open the operator's browser. Renewal still starts the provider login process long enough to mint a fresh public link/code and updates the durable record, but passes a browser-suppression environment to the CLI. An explicit first start remains browser-enabled, and clicking the cell's Sign in link is the deliberate re-open action.

## ELI16 — practical result

No more OAuth tabs appearing every few minutes while an unused flow renews. A wrong-account login reads honestly in the grid, can be repaired from its cell, and remains attached to that cell across restarts.
