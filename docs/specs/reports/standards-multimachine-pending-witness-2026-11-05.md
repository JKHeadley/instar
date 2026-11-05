# Convergence report — Amendment 6, witness-backed Pending exception (2026-11-05)

**Article.** An Instar Agent Is Always a Multi-Machine Entity (area: Building).
**Change.** Adds the operator-approved clause (choice A, 2026-11-05 00:37 PST, Echo Telegram topic 137342, feedback fb-df437009-192) verbatim to the Rule as Amendment 6, with a pointer from the survivability sentence and an enforcement-status note.
**Reviewers.** Dawn (author, claude-code); an independent verifier (claude-code, separate context, instructed not to accept the author's framing); Echo (codex, reviewed ae4b8ec23 against approved v3).

## Findings and dispositions

1. **Label collision** (independent verifier). "Amendment 3" was already used in this article for the narrowed physical-credential-locality taxonomy, so a second Amendment 3 made "Amendments 3 and 5 carry checkable marker contracts" cover the new clause too. **Resolved:** labelled Amendment 6.
2. **Unqualified absolutes** (independent verifier). "never INFORMATION" and "however reliable that other machine is assumed to be" read alone forbid what the exception permits. **Resolved:** "never INFORMATION" now points to the exception by name.
3. **Enforcement status missing** (independent verifier). Applied through lists each amendment's enforcement; the new one was absent. **Resolved:** recorded as reviewer-only, beside Amendments 1 and 2, with its three reviewer questions.
4. **"Independent witness" and Pending lifetime undefined** (independent verifier). **Resolved:** both are specified by the approved design the amendment was ratified for, `docs/specs/conversation-effort-hierarchy-v3.md` §7.2, now cited (an always-on witness service on a managed failure domain outside the installed set; a sleeping member, passive backup, or installed peer alone is ineligible). Imported with that design's provenance in this branch so the reference resolves.
5. **Lifetime wording** (Echo). "until applied" was weaker than v3. **Resolved:** the witness retains every Saved · Pending item until all installed members receive a terminal certificate (final commit, certified Cancel or Forget); never expired by a time limit.

No design question remains open. The approved clause's words are unchanged.
**Not certified here.** Operator ratification of the edit itself: the direction guard still requires the repository owner's approving review on the head commit.
