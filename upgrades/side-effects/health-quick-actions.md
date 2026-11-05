# Side effects: quick actions on a health problem

## Summary of the change

Tier 2, as the brief set it: a device allowlist addition plus a change to what the degradation reporter records. Spec: `docs/specs/health-quick-actions.md`. Each problem gains Hide for a while, Hide from me and Ignore completely, with a Hidden list to undo them, in the console and the app. New store `src/monitoring/healthChoices.ts`; the reporter, `/health`'s LLM summary and `summarizeHealth` consult it.

## Decision-point inventory

- Which choices an item gets (`offerFor`): a declared table on stable ids. Enforced on the server and on rows from peers.
- Whether the reporter records an event (`isIgnored`): only for an id a person chose, exact match.
- Whether a read shows a row (`hidesNow`): exact id.

## 1. Over-block

A security or data-loss id gets only Hide for a while, so a false match on the word floor costs a person the permanent choices on that id. They can still hide it a week at a time, or ask the agent. Live readings can't be ignored; the screen says why. The cap of 200 live choices refuses a new one with a plain failure.

## 2. Under-block

Ignore binds to a feature name. Two different failures reported under one name share a choice: that is the finest identity that exists, and the confirmation says the agent won't hear about it even if it gets worse. Attention items already open for a problem stay open; they are a separate path with their own close. `openDegradation` (the never-silent ladder) isn't touched: it is keyed by component and doesn't feed this page.

## 3. Level-of-abstraction fit

The reporter is the only place that can make "stops tracking" true for an event, so Ignore lives at its door. The read filter lives per signal in `summarizeHealth`, before grouping. Offers live with the store so a peer's row is checked by the same rules a screen uses.

## 4. Signal vs authority compliance

The person holds the authority: nothing here decides on its own to hide anything. The id table only narrows what can be chosen, on ids, never on message text. A store or policy failure falls back to showing everything (`docs/signal-vs-authority.md`).

## 4b. Judgment-point check

No LLM is involved. Which ids count as security or data-loss is a reviewed list, read from each `report()` site, with a floor that only narrows.

## 5. Interactions

`getEvents`, `getRecentEvents`, `getUnreportedEvents` and `hasDegradations` filter ignored ids, so `/health`, `/health/degradations` and the daily digest agree. `/health/degradations` serves a hidden event as reported, at read time, so the digest doesn't turn it into an attention item; the stored event stays unreported, so it is raised normally once a snooze ends. The self-healer still runs on a hidden event. `/health`'s `status` and `degradations` change only for an ignored id. The lifeline reads `/health` for liveness, not these counts, and scripts see one problem fewer only because a person asked. `degradations.json` keeps events from before the choice as history; nothing reads it back into memory. The reporter now imports the store, which brings `healthChoices.ts` and `scrubSecrets.ts` into the Stage-B closure; both are declared as excluded, with reasons, in `src/data/stageBCertifiedSet.ts`.

## 6. External surfaces

Two owner routes on the device allowlist with their own bucket, two bearer-only peer routes, additive fields on `GET /mobile/health-issues`, and a new CLAUDE.md bullet through `migrateClaudeMd`. A session with the bearer could hide a problem from its operator. It can't be told apart from the console, so each row names where it came from, each choice is logged to `logs/health-choices.jsonl`, and the awareness text forbids doing it unasked.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The fix and "Ask the agent about this" stay first on each problem, and the quick actions sit directly under them, open, on arrival: each duration is one tap, not behind a menu, in the console. The Hidden list is a fold at the foot, since it's a return path, with its count in the title.
2. **Zero raw internals as primary content?** Yes. Every row is a plain title and one plain sentence. Keys are sent and never shown; a refused choice is translated from its code to words.
3. **Destructive actions de-emphasized?** Yes. Ignore is the last action, outlined rather than filled, and asks once in a sheet with one sentence and a quieter Cancel.
4. **Plain language + phone width?** Yes, read at 390x844 and 1280x728 on a stub of this answer: no horizontal scroll (scroll width 390), targets 44 px high, buttons wrap.

## 7. Multi-machine posture

Replicated. Push on write to online peers, pull every 5 minutes, later stamp wins per id, undo is a stamped removal with no time limit, and rows are validated on arrival. What a machine saw of a problem stays machine-local on purpose. The read itself stays this-machine, as `mobile-health-issues` §6 scopes it. A peer that doesn't answer is named on screen. The state file is under `.instar/state/`, which git sync excludes here, so the two can't fight.

## 8. Rollback cost

Revert the commit. `state/health-choices.json` and the log become inert files. Anything ignored starts being recorded again the moment the code is gone, which is the safe direction. The CLAUDE.md bullet stays and would describe a missing route until removed.

## Second-pass review

One security-and-adversarial round by an independent reviewer, which read the code and ran nothing. It found 8 design defects and 5 minor points. Fixed: LLM safety components and other unprotected ids got permanent Ignore; a choice could cover a family member that arrived after the person looked (the request now carries the shown keys); ids a row can't hold now get no choices; undone choices could revive after 30 days (stamps now have no time limit); an undo could fail validation; Hide skipped the self-healer and wrongly marked events reported; a transient read error could let a save overwrite the file; a restart could read a hidden problem as stopped; failure words could be false after a successful save; a peer's list could crowd out another's.

Accepted and written down, not fixed: the peer route uses the shared bearer rather than machine signatures, so a session could post to it. It could equally use the choice route, so signing that one route adds nothing while the bearer can choose at all. Rows from a peer now say only "another of this agent's machines". One hidden problem can mask a further reason `/health` can't name: it reads "Running, with one thing you've hidden", never healthy, the same limit any showing row has. With the remediator on (off by default), its own notices about a hidden problem still reach the person.

Proportion: one review round, as set. It found design defects and they were fixed in place; the changes are narrow and covered by tests, so no second round was run.
