# Side effects: open a chat's session on any machine

Change: `GET /mobile/conversations/session` used to answer "open the dashboard on <machine>" when the chat's session ran on another machine. It now looks that session up in the pool's session listing (`GET /sessions?scope=pool`, read over this server's loopback, where each peer's rows carry `conversationRef`). It answers `active:true, remote:true, sessionName, machineId`, and the app opens the session natively through the existing relay routes. A machine that isn't answering gets a plain sentence with `retry:true`. An older peer gets "needs the latest Instar update". **Tier 1**: one route's answer changes; no new route, no allowlist change, no new authority.

1. **Over-block.** None. A remote session that used to dead-end now opens.
2. **Under-block.** The phone sees a remote session's name and machine, as the session list already shows it. Typing, keys and files still go through the relay routes, which keep each machine's own rules (`allowRemoteInput`).
3. **Level-of-abstraction fit.** It reuses the dashboard's own pool listing and the app's existing remote session view. Nothing is duplicated.
4. **Signal vs authority.** Read-only lookup.
5. **Interactions.**
   - The route is now async. Its pool read is bounded at 10 s, within the 30 s route budget.
   - A peer on an older version (no `conversationRef` on its rows) is named as needing the update, not guessed at.
6. **External surfaces.** New answer fields: `remote`, `machineId` and `retry`. The old "open the dashboard on …" sentence is gone.
7. **Multi-machine posture.** This is exactly the multi-machine case: one agent, sessions on several machines, one phone.
8. **Rollback.** Revert. The phone shows the old sentence again.

## 6b. Operator-surface quality

1. **Primary action first.** Tapping Session opens the session.
2. **No raw internals.** One sentence when it can't, naming the machine.
3. **Destructive de-emphasized.** Nothing destructive is added.
4. **Plain at phone width.** No new layout; an alert with Try again.

## Class-Closure Declaration

- **unbounded-self-action — closure: n/a.** A read on the person's tap, nothing self-triggered.
