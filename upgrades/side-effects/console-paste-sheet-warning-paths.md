# Side-effects: paste sheet warnings carry a way to act

The console warning-paths guard found six warning results in paste-model.js with no path to act. The sheet now appends the shared askLink ("Ask the agent about this", opens Sessions with the question ready) to every attn or bad result from the server; each warning line in the model is tagged (askLink for refusals, row for waiting, which lives in Recent pastes with its Delete action). Client-side input problems (empty text, no target) are exempt with a reason: the fix is the input directly above.

1. Over-block: none; nothing is blocked, a link is added.
2. Under-block: a new warning in paste-model.js without a tag still fails the guard.
3. Level-of-abstraction fit: uses the shared ui.js askLink the other console pages use.
4. Signal vs authority: no decision point; display only.
5. Interactions: the result line now holds a link after its text; the DOM test asserts the href.
6. External surfaces: dashboard only; the link opens Sessions with a drafted question, nothing is sent until the person sends it.
7. Multi-machine posture: browser-local rendering, no state.
8. Rollback cost: revert the commit.
