<!-- bump: patch -->
## What Changed

Pairing messages that send the owner to the dashboard now carry a direct link (Echo Bugs topic 10000002573; Instar feedback fb-300d9f7d-6d3, fb-9566b1d3-f4d).

- **The refusal for a pasted invite** (for example, an agent with no owner set) links straight to the console's Other agents page with "Connect another agent" open and the paste box focused: `…/dashboard/console/#/people/agents?connect=paste`. The invite itself is never put in the link.
- **The link uses the agent's real address** through the shared operator-link resolver: the tunnel when up; the local address only with no tunnel, said plainly ("opens only on the computer it runs on"); and, while a tunnel is still starting, no link with a plain reason.
- **Refused or expired button taps:** a toast cannot hold a link, so the link is posted once per invite (every 10 minutes at most) in the invite's topic, and the toast points at it.
- **The Finish prompt with Telegram approval off, the "finishing by myself" notice, and the Telegram adapter's fallback reply** use the same linked sentence. The shared core notice text takes an optional host line and is unchanged without it.
- **Someone known not to be the approver** (another member of a group chat) gets no dashboard address: the reply says the person who approves new connections can do it on the dashboard. The adapter's no-handler tap toast names the Other agents page instead of the old Threadline tab.
- **Agent instructions:** the "Connect with another agent" section of CLAUDE.md gains one line: every dashboard pointer in pairing is a direct link (`GET /tunnel` + `/dashboard/console/#/people/agents`, `?connect=paste` for pasting), never the invite in a link. `PostUpdateMigrator` adds the line to existing agents that already have the section (content-sniffed, idempotent).
- Builds on PR #3087 (refused-invite receipts and approver wording), which is unchanged.

## What to Tell Your User

When I can't take a pairing invite from Telegram, I now give you a link that opens the right dashboard page with the paste box ready. If I have no address your phone can open, I tell you that plainly.

## Summary of New Capabilities

- Direct dashboard links in every pairing "use the dashboard" message.
- `#/people/agents?connect=paste` opens the console's invite paste box.

## Evidence

- Unit: `tests/unit/threadline/pairingDashboardLink.test.ts`, `tests/unit/threadline/PairingInviteTelegram.test.ts`, `tests/unit/pairing-invite-never-persisted.test.ts`, `tests/unit/console-agents.test.ts`, `tests/unit/threadline/pairing-handshake.test.ts`, `tests/unit/agent-connect-knowledge.test.ts` (template line + migration, idempotent).
- Integration: `tests/integration/pairing-invite-telegram-routes.test.ts`.
- E2E: `tests/e2e/threadline/pairing-handshake-production-path.test.ts`.
