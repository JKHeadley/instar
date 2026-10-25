# Agent-driven sign-in repair — plain English

When a Claude or Codex sign-in expires, Instar can repair it by itself: it opens that account's own browser, signs back in, and checks the right account came back. Until now the clicking-through part was a fixed script that knew a list of page types and one move for each. When a provider showed a page nobody had predicted, the script could only wait and give up, and it had never finished a repair.

This change lets a model do that part the way a person would. On each page, Instar lists the buttons and links that are safe to use, and the model picks the one that moves the sign-in forward, or asks to wait, or gives up. Instar types any password itself, so the model never sees it, and it removes from the list any button that names a different account, signs out, deletes or manages the account, creates a passkey, or grants permissions beyond the ones allowed. Pages that need a person, like CAPTCHAs and phone prompts, are still handled by fixed rules and handed to the operator. Each repair has a hard 8-minute limit, and success is still decided by Instar checking the signed-in account itself.

It is only switched on for development agents; every other agent keeps the old script until this has repaired real expired sign-ins.
