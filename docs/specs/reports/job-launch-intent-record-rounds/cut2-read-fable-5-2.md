**Prior fixes: both hold.**
- `jobMigrate.ts:164` is the hand-picked `buildPerSlugManifest` call, and §1 now names it.
- `MANIFEST_KEYS` (`JobPortableBundle.ts:13`) guards both export (`:52`) and import (`:101`), so one edit covers both directions.
- The D9 shed order now matches the code: appended means shed last (`JobRunHistory.ts:186`, `:718`).

**Hunt for other hand-listed job fields.** I found five more sites; none changes what gets built.

1. **PRECISION — the old dashboard job editor.** `dashboard/index.html:8656` builds a manifest from eight fields, and `POST /jobs/:slug/save` (`routes.ts:19786`) writes it whole with no merge. It would drop `thinkingMode`, but it already omits `expectedDurationMinutes` and `enabled`, which `validateManifest` requires (`AgentMdJobLoader.ts:827`, `:833`). By my reading, any such save already leaves the job unloadable; I did not run it. This is an existing bug worth its own report, and it matters here only because the D8 job is a user job with that Edit button. Name the path as excluded from "every definition path".
2. **PRECISION — user-job frontmatter is decorative.** `manifestToJobDefinition` reads only `manifest.*`. A `thinkingMode` written in a user job's `.md` loads cleanly and does nothing. `writeUserTemplate` (`jobMigrate.ts:124`) also hand-lists frontmatter and will not carry it. The CLAUDE.md line should say the manifest is where it takes effect.
3. **PRECISION — console display list.** `JOB_KEYS` (`dashboard/console/schedule.js:18`) will not show the field. Display only.
4. **No change needed.** `canonicalScheduleHash` (`MigrationInvariants.ts:261`) and the bundle observation check (`JobPortableSync.ts:189`) list fields but compare only schedule, enabled, priority, model and dependencies.
5. **No change needed.** `addJob` (`commands/job.ts:45`) builds a fixed legacy entry with no option for the field.

**Other precision items**

6. **§3 wording.** The main path passes an inline literal to `spawnSession` (`JobScheduler.ts:3120`). A variable named `spawnOpts` exists only at the triage site (`:2929`), which is a non-goal. Say "the `spawnSession` options at `:3120`".
7. **Mixed versions.** A peer on an older build refuses a bundle carrying the field (`unknown-manifest-field`), and an older loader withholds a job whose frontmatter has an unknown key. Both fail closed. The posture's "travels with them" needs "between machines on this version or later", and Rollback needs "remove the field before downgrading".
8. **Round-trip test, install step.** `InstallBuiltinJobs` only processes shipped templates, so that step needs a built-in-shaped fixture; one user fixture cannot pass through it.
9. **D8 still unconfirmed.** I found no `bugs-overseer` under the agent home's jobs directory, the same result as the previous read. Its model and run rate need confirming on the machine that holds it.

**Code claims checked and accurate**
- `JobScheduler.ts` 3137, 3157, and the three excluded `recordStart` sites.
- `SessionManager.ts` 4650, 4844, 4881 (tmux exec at 4889), 5328, 7030.
- `frameworkSessionLaunch.ts` 349-394, 496, 1023.
- `AgentMdJobLoader.ts` 80, 163, 1513; `buildPerSlugManifest.ts:63`; `InstallBuiltinJobs.ts:286`; `JobRunHistory.ts:373`.

**Not verified:** the sha256 (the hash command was refused), "Rule 30", and `PipeSessionSpawner.ts:421`.

VERDICT: CONVERGED (no DESIGN findings)