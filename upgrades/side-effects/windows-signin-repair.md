# Side-effects review: Windows sign-in repair

**Summary.** Tier 1: an opt-in addition, off unless a WSL machine sets `navigation: agent-session`. Effort: one review round.

**Decision points.** One changed: repair admission counts a WSL profile with no Windows folder as `profile-directory-missing`. It applies only on the WSL helper path, is a structural fact and not a judgment, and its refusal is visible in `blockers`.

1. **Over-block** — A WSL profile whose Chrome really lives in the Linux filesystem is refused. No such setup can work: the helper drives Windows Chrome only. The folder spelling rule mirrors `ndrive.sh`, so it rejects nothing the wrapper would accept, except a path over 240 characters.
2. **Under-block** — A folder for the wrong account would pass admission; the helper still checks the account, and the arbiter's email check still decides. A folder that is the operator's own Chrome passes the registry but `ndrive.sh` refuses it (`ERR profile-reserved-folder`). The helper needs a Windows desktop session and `canfocus` refuses while the operator is active, so a repair can time out and count as `agent-sign-in-unfinished` within its attempt budget.
3. **Level of abstraction** — Reuses the helper, admission, lease and arbiter unchanged. The driver stays hash-pinned and untouched. Windows detail stays in the prompt, the skill and one registry field.
4. **Signal vs authority** — No brittle check gains blocking authority. The arbiter still alone decides success. See `docs/signal-vs-authority.md`.
5. **Interactions** — The host-wide seat lease serializes helpers, and `ndrive.sh`'s per-agent lock serializes driver calls. The last-resort drive is withheld on WSL so a repair never falls into a browser that cannot open the folder. A helper seat must be a healthy account, as on macOS.
6. **External surfaces** — One new route, `PATCH /playwright-profiles/:id`, Bearer-protected and limited to one field. Typing a sign-in link with `typesecret` keeps it off argv. Sign-in traffic to Google, Claude and OpenAI comes from the Windows machine's own Chrome.
7. **Multi-machine posture** — Machine-local by design: Chrome profiles and config belong to one machine, and profiles are never copied. Repair state already reads across machines through `?scope=pool`.
8. **Rollback** — Set `navigation` back or `enabled: false`, or revert. The leftover registry field is ignored, and the skill subsection is harmless text.

## Second-pass review

An independent review raised six concerns, all fixed in this change: the new-agent example path was invalid JSON; the folder rule accepted `~`, which `ndrive.sh` refuses; the prompt's "fill by index" rule contradicted the link step; the link step had no focus proof, so `url` is now read before Enter; the helper now sets `ND_EXPECT_HOST` on every click or keystroke, matching the macOS focus check in strength; and the link now travels through a private file, with page dumps in the binding folder and not a shared one. The startup log also no longer reports a last-resort model on WSL. Concur after these fixes.

A second independent pass (2026-10-31) checked each fix against the code and concurred, with no macOS regression. From its notes, this change also tells the helper where to find its binding folder, and keeps signed-in profiles out of shared Windows folders in the skill's example.
