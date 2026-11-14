<!-- bump: minor -->

## What Changed
- **Work Board, phase 1: a card for everything the agent needs from a person.** A card says what is needed and why, what done means, who carries it and who acts next. Its chat is a real app conversation, so a person's comment reaches the agent's session at once. Spec: `docs/specs/work-board-asks.md`.
- **Off unless switched on.** `workBoard.enabled` left out means on for a development agent and off everywhere else. Off: every route answers `503 work-board-disabled`, the console page and Home entry are absent, and nothing is created.
- **Only a person approves.** Approve, answer, confirm done, hold, release, try again, withdraw approval, reopen, archive, restore and remove are taps. A tap needs the dashboard PIN on the console or Face ID on the owner's phone; the agent's token alone is refused `person-required`.
- **An approval covers exactly what was shown.** It binds to a hash of the card's title, need, done items, carrier, outward flag and links. Any later change to those cancels it and it never comes back.
- **Status is derived.** No route accepts a status. A card finishes only with evidence for every done item; items marked for the owner need the owner's confirm, and a reopened card always does.
- **Approval policy, owner-set.** `every-agent-card` (default): the agent waits for an OK on every card it writes. `outward-only`: internal cards start at once and only cards that send something outside the team or spend money wait.
- **The hand-over loop has brakes.** Waiting for a free session writes nothing and never parks. Three failed attempts park the card for the owner. A hand-over interrupted by a crash gets a recovery brief, and a card that sends something outside the team is parked for the owner first. Attempt counts and parks are replicated records, so a restart or a new owning machine mints no new budget.
- **Replicated.** New journal kind `work-card-record` (store `workBoard`), forced on with the feature. Every machine folds the same records into the same card.
- **Console.** A new Work page whose first lane is "Waiting on you", and a Home entry for cards waiting on the owner.
- **Phone.** `GET /mobile/work-board` and a Face ID tap route. The iPhone card screen is built in the app source and reaches phones with the next app build.
- **Card text is checked for credentials** on every write and refused on a hit; a pasted key never lands in the replicated store.
- **Conversation lists** leave out the conversations of archived or removed cards.
- **For other code:** `appInboundDispatch` gains a `detailed` result (`injected`, `spawned`, or `refused` with a reason) beside its unchanged return value, and a system-origin brief whose tag reads `system:work-board` and whose session start is admitted as automatic.

## What to Tell Your User
I now have a work board. When I need a decision, an answer or a sign-off from you on a piece of work, I put it on a card, and you see everything waiting on you in one place: the Work page in the console. Each card has its own chat, and a message there reaches me straight away. I can propose a card and ask on it, but I can never approve one for you: an approval takes your PIN, or Face ID on your phone, and it covers exactly what you saw. If I change the card afterwards, I have to ask again. You can hold, reopen or remove a card at any time. It's switched off unless you turn it on.

## Summary of New Capabilities
- `GET /work-board`, `GET /work-board/cards/:id`, `POST /work-board/cards`, `POST /work-board/cards/:id/records`.
- `POST /work-board/cards/:id/tap` and `POST /work-board/settings` (the owner, dashboard PIN).
- `GET /mobile/work-board`, `POST /mobile/work-board/cards/:id/tap` (the owner's phone, Face ID).
- `GET /work-board/graduation`, `POST /work-board/graduation/pass`, and the daily `work-board-graduation` job that runs only when a record is due.
- Console Work page and a Home entry; `workBoard` in `/capabilities`.
- Config block `workBoard` (limits, pickup pacing, quiet window), added on update without `enabled`.

## Evidence
- `tests/unit/WorkCardStore.test.ts`, `WorkBoardService.test.ts`, `WorkBoardPickupController.test.ts`, `WorkBoardRuntime.test.ts`: the fold, approval, finishing, lanes, who may write what, limits, the credential check, every pickup rule, two machines replicating to each other.
- `tests/unit/work-board-wiring.test.ts`: every registration the feature needs, the system dispatch tag, the automatic admission, the `systemSource` field, the list filter.
- `tests/integration/work-board-routes.test.ts`: the production auth middleware, device authenticator and session guard: a signed phone tap, a replay and a wrong-state signature refused, a scoped session confined to its own card, the PIN tap bound to the card as shown, visibility both sides.
- `tests/e2e/work-board-alive.test.ts`: the real server on its boot path with a real journal: off answers 503; on, one card proposed, approved, handed over, asked, evidenced, finished and reopened; an approval in a rotated archive still counts after a restart.
- `tests/unit/console-work-model.test.ts`: the Work page's model and the Home rows.
