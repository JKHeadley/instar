# Side effects: the Sessions page uses the window, and a Session settings button

Change: Sessions page layout at 900 px and wider, a "Session settings" button and sheet for the new-topic default, and the word "door" replaced by "Engine" through one constant in the console and in the phone answers' sentences. **Tier 1**: presentation only, fully undone by a revert. Seven files, about 250 lines including tests. One review pass by reading screenshots at three sizes; no spec rounds (Tier 1).

1. **Over-block.** Nothing is refused; no rule added.
2. **Under-block.** Not applicable: no gate.
3. **Level-of-abstraction fit.** The defaults form is one function used by both entry points, not a copy. The word is a constant beside the model words it sits with. The server keeps its own constant because a server module can't import the console's, the same mirroring as the existing model words.
4. **Signal vs authority.** No decision point. The sheet calls an existing route with its existing checks.
5. **Interactions.** Shares `POST /topic-profile/new-topic-default` and its 5-per-minute limiter with the New session form. The wider frame applies only to `.main` holding the Sessions page (`:has`), so other pages keep 1120 px. Browsers without `:has` keep 1120 px and the wider list column, which is still an improvement.
6. **External surfaces.** The console's Sessions page looks different at desktop widths; the phone layout is unchanged. The phone answers' sentences say "engine" where they said "door" (the `reason` and `message` texts); no field name or error code changes, so an older app shows the new word and works as before.
## 6b. Operator-surface quality

1. **Leads with its primary action.** "+ New session" stays first; "Session settings" sits beside it as a quiet button. The settings sheet opens on its two pickers.
2. **No raw internals as primary content.** The sheet shows door and model names in words; no ids, routes or config keys.
3. **Destructive actions de-emphasized.** Clear is a quiet button beside the primary Save; it only removes a default, and new topics then use the agent's own.
4. **Plain at phone width.** Checked at 390x844: one column, both buttons on one row, the sheet's one line of text plain.

7. **Multi-machine posture.** Unchanged. The default stays machine-local by design and the sheet says "on this machine".
8. **Rollback.** Revert. No state, no migration.
