# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Telegram updated Telegram Web K (build 2.2 (679)) on 2026-10-16. The typed Telegram browser route held correctly but silently: peer resolution refused the unknown build on a path that never recorded the failed build or raised the attention item the origin spec requires, and there was no runnable way to enroll a newly reviewed build.

- Browser reads (snapshot, peer resolution) now use the same bounded recovery as sends: one fresh-process recheck, then the failed build is recorded (`GET /telegram/origins/status` → browser recovery `failedBuilds`) and exactly one attention item is raised per failed build.
- Build 679 was reviewed against its public source maps (every driver contract unchanged; evidence in `docs/specs/reports/telegram-message-origin-evidence/web-k-2.2-679-review.md`) and added to a reviewed-build list.
- New local command `instar telegram-origin enroll-browser <profile>`: runs a read-only canary on the managed profile and enrolls the observed build only if it is on the reviewed list, keeping one prior reviewed build. Deliberately not an HTTP route. The running server picks the new enrollment up at its next browser start, without a restart.
- CLAUDE.md template and `migrateClaudeMd`: Web K update paragraph; attention wording corrected to "per failed build".

## What to Tell Your User

When Telegram updates its web app, my Telegram browser sending pauses until I've checked the new version is safe. Before, that pause happened quietly. Now you get one heads-up in the attention topic, and I can re-approve a checked version myself without restarting anything. Nothing is ever sent while it is paused.

## Summary of New Capabilities

- A Telegram web update that pauses browser sending now raises one attention item instead of failing silently.
- `instar telegram-origin enroll-browser <profile>` re-enrolls a reviewed Telegram Web build after a read-only check.

## Evidence

- Live 2026-10-16: `justin-telegram` enrolled for `web-k-2.2-676`; web.telegram.org/k served `apiManagerProxy-DYhbs4ln.js`, `app-DVSixCDs.js`, `index-xJZhS8vI.js`; route 409 `browser-preparation-or-recording-unavailable`; no `failedBuilds`, no attention item.
- Unit `tests/unit/telegram-origin/browser-reenrollment.test.ts`, migration `tests/unit/telegram-origin-browser-drift-migration.test.ts`, integration `tests/integration/telegram-origin-browser-drift.test.ts`, e2e `tests/e2e/telegram-origin-webk-drift-reenroll.test.ts`.
