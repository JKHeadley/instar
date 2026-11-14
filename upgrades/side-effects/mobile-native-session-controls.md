# Side effects: the app's session screen reaches the dashboard's controls

Change: a controls menu for the iPhone app's session screen. New owner-phone routes: keys, attachments, three reads and five Face ID writes. A hop from the machine a phone reached to the machine running the session. **Tier 2**, about 2,000 lines across 14 server files including tests. Three review rounds, the cap, each finding design defects until the last; one commit attempt recorded at the time of writing. Rounds at the cap are in line with a change this wide: it adds device access to session writes across machines.

**Second-pass reviewer:** independent reviewer subagents, three rounds; see `docs/specs/reports/mobile-native-session-controls-convergence.md`.

1. **Over-block.** A door or model the dashboard's menu wouldn't offer is refused on the phone, though a chat pin would accept it, so a person who wants that uses chat. A new session's name with a credential shape is refused. Door and machine stay Telegram-only, as on the dashboard, so an app-conversation or Slack session can't switch from here; the menu says so. The 200 MB per hour limit could stop a burst of real files; the words say to wait.
2. **Under-block.** A modified app on the owner's phone can send Ctrl+C or a file without the 5-minute local check. It still needs the Secure Enclave key, which already lets it type. Name a door whose readiness changed between the options read and the write: `applyWrite` falls back with a notice, as it does for the console.
3. **Level-of-abstraction fit.** No copy of what a control does: each runs the dashboard's route, with the rules and refusals there. Writes reuse `writeGate`, `proven`, `ActionChallengeStore` and the audit file. The dashboard's words are mirrored in the server module, because a server module can't import a dashboard one, with tests holding both shapes. That mirror can drift.
4. **Signal vs authority.** The gates are deterministic: exact route patterns, cryptographic proof, fixed key names, exact comparison with an option list, an existing boolean. Nothing brittle holds judgement over an agent. No new detector.
5. **Interactions.** Shares the `permission-actions` bucket (12 per minute) with approvals and key requests. Self-calls hit `spawnLimiter` and `remoteCloseLimiter` under the loopback address, shared with this machine's own dashboard calls over loopback. A door switch replaces the session, so `session-replaced` on the old id is expected: the app holds polling while it follows, and an old app build sees the existing message. The old spec's "never proxies" sentence is reversed; the two changed tests say so. `redact=device` on the transcript route changes nothing for other callers.
6. **External surfaces.** New: 10 device routes, 6 pool-token relay routes, one query parameter, 5 action kinds, 5 route budgets. Phones now see saved attachment paths, as the console does. Agent awareness: CLAUDE.md bullet with migration, capability entry. Pool peers get relay calls per phone poll (bounded by the 90-per-minute output bucket).
7. **Multi-machine posture.** Output, input, keys, attachments and history: proxied through the machine the phone reached. Door, close, move: run on the owner or the lease holder. The new-topic default stays machine-local by design and says so. Challenges, replay and audit are machine-local on the reached machine. An older peer answers 404 on the relay paths, and the phone says it needs the update. No notices, no generated URLs, no new durable state to strand on a transfer.
8. **Rollback.** `mobilePairing.permissionActions` off stops the five writes at once. Revert for the rest. No migration to undo beyond a CLAUDE.md bullet that describes routes which would then answer 403, and the next migration would not remove it, so a revert should delete that line too. Files already attached stay until the existing 30-day cleanup.

## Second-pass review

**Reviewer:** three independent reviewer subagents reading the artifact's subject (spec and code) by round.
**Independent read: concur after fixes.** Round 3 found no security defect and one reliability defect, fixed. That fix was not read again, since the rounds reached the cap for this tier.

## After Local Verify

The first verify failed one test: `tests/unit/mobile-native-console-pages-claudemd.test.ts` pins the console pages bullet right after the ask-and-cancel bullet, and this change had put its own bullet between them. The bullet and its migration now follow the owner health reading bullet, the last in the block, so each existing bullet keeps its neighbour. No behaviour change beyond where the line sits.

Main then gained PR 2823, whose health quick actions bullet took the same place. Forward-merged: both kept, this bullet after it, anchored on it in the migration.
