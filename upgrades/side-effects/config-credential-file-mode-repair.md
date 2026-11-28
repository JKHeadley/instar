# Side-effects review: repair an open config.json to 0600 on load, create it owner-only

## What changes
- `src/config/LiveConfig.ts`: every load (`refresh`) checks the mode of `config.json`. If any group or other bit is set, it `chmod`s the file to 0600. This is best effort: on a read-only mount the read still succeeds and the mode stays as it was. Windows is skipped.
- `src/commands/init.ts` (two writes) and `src/commands/setup.ts` (one write): a newly created `config.json` gets mode 0600.
- `tests/unit/config-credential-file-mode.test.ts`: three new cases. Loading a 0664 file repairs it to 0600. `set` on a file that started at 0664 leaves it at 0600. An owner-only file is left unchanged on load.

## Why
The review of this PR found that the earlier rewrite-only fix (0600 on the temporary file) did not repair a config that was already open, from an older install or a hand edit, and did not cover the installer's first write. Its test started from 0600, so it could catch neither case.

## Side effects considered
- **Who can read the file afterwards:** only the owner. Agents run as the owning user, and nothing in instar reads config.json as another user. Sharing between machines goes through git and sync, which do not carry file modes in a way this affects.
- **mtime and the change watcher:** `chmod` changes ctime, not mtime, so LiveConfig's mtime-based reload does not fire again. There is no reload loop.
- **Existing files written by `writeFileSync` without a mode:** Node keeps an existing file's mode, so a later rewrite does not widen it. The next load narrows any open file.
- **Failure:** if `chmod` throws (a read-only file system, or a file owned by someone else), it is caught and the read continues unchanged.
- **Rollback:** revert the commit. No data or format changes.

## Tier
Tier 1: 11 lines across three source files, no new capability, no migration and no route. Signal-vs-authority does not apply; this is a file-mode hygiene fix.

## Tests
- Focused tests: `config-credential-file-mode` 5/5. Neighbouring config, init and setup tests: 120/120. `tsc --noEmit` is clean.
