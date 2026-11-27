# Side effects: native console pages and file browser

Six read-only GET routes for the owner's phone, built from the console's own routes over loopback, and six device allowlist entries.

1. Over-block: `secretShaped` hides files whose names contain words like key or token, including harmless ones such as `api-key-notes.md`. Acceptable: over-hiding costs little and the console still shows them.
2. Under-block: a secret in a plainly named file is only as hidden as the scrub patterns allow. A symlink is judged at its target.
3. Level fit: reading through the console routes keeps one owner for each rule. The cost is a loopback hop, measured at milliseconds.
4. Signal vs authority: no new authority over an action. `secretShaped` only hides output and cannot block an action. See `docs/signal-vs-authority.md`.
5. Interactions: pool reads count against the console routes' own rate limits (12 a minute); a 15 s cache on the four pages keeps refreshes well under it. A 429 shows as "can't read". `ownBucket` limits phones to 20 a minute on pages and 60 on files.
6. External surfaces: new phone routes and a CLAUDE.md line. The bearer never leaves the machine.
7. Multi-machine posture: Pace and Maturation proxied-on-read through the console's pool scope. Ideas read through the agent's single ledger. Development and Files machine-local with `hardware-bound-resource`, stated on screen for Files.
8. Rollback: revert the commit. The app shows "update the agent"; nothing durable is written.

**Independent review of the Files protection (2026-11-05):** five defects found and fixed: delimiter-only name matching, gaps in file scrubbing, no folding before the name check, the requested path being judged rather than the resolved one, and no scrub margin before the cuts. Each has tests. Remaining limits: a hard link is judged by its own name, a secret longer than the 2,048-character margin that crosses a cut is only partly scrubbed, and an ordinary password with no label can't be recognised.

## Second-pass review

**Reviewer:** codex-cli gpt-6-astra, five rounds on the spec and module

**Independent read of the artifact: concur**

Each round's design findings were fixed: pace and development summaries that could read as healthy when a part was unmeasured or unread, counts taken after caps, attention rows behind a cap, lost truncation flags. Round 5 said MINOR ISSUES; its two design points are fixed and have not been re-read. No same-family subagent review ran, because this worker cannot spawn one.

**Fallback note (2026-11-05):** the failed read, unreadable body and unresolved path are each marked as deliberate fallbacks; each is reported or refused, not silent.

**Second review (2026-11-05):** pattern lists won't cover every format, so `/mobile/files/read` now shows text only for prose and source types and answers "Open this one in the console." for the rest. Cuts drop the last unbroken run or line, key markers are read on the whole line, and key shapes are one list shared with the outbound policy layer (`src/core/credentialShapes.ts`), so outbound messages now also block the new shapes. Stated limits: the check-then-read race (needs local write access), hard links, hostile Unicode lookalikes, and secrets in forms no label or shape matches inside a source file.
