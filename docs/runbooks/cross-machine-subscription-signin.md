# Runbook: Sign a Machine In to Every Claude and Codex Account (Using Another Machine's Browser)

**Proven:** 2026-09-27, Echo, topic 57697 ("Mama PC test"). The Mama PC (Windows 11, Instar inside
WSL) went from 6 signed-out Claude accounts and 5 missing accounts to all 13 accounts (8 Claude,
5 Codex) signed in. Every account passed a live check. The only human involvement was Justin
rebooting the Mama PC. Total hands-on time was about 45 minutes, most of it working out the steps
recorded below.

Use this when a machine needs Claude Code / Codex logins but **cannot run a normal browser that the
agent can drive**: a Windows/WSL box, a headless Linux server, a machine with no Google profiles.
The same steps also work for a Mac. The standard single-machine procedure is the
`/subscription-signin` skill. This runbook is its cross-machine variant.

---

## The idea in one paragraph

Every Claude and Codex account here signs in "with Google". A Google account that is already signed
in inside a Chrome profile makes every later sign-in a few clicks. So keep **one Chrome profile per
Google account, on one Mac (the "browser machine")**. When another machine (the "target machine")
needs a login:

- The **target machine starts its own CLI login**. It generates and keeps the secret half of the
  login, so the finished login is minted on the target and **nothing is copied between machines**.
- The **browser machine opens the login link** in that account's own Chrome profile and approves it.
- **Claude** shows a paste-back code: the browser machine reads it and posts it to the target.
- **Codex** uses a device code: the target shows a 9-character code, and the browser machine types
  it on OpenAI's page.
- The **target registers and verifies** the account.

The browser machine drives Chrome with **Apple Events JavaScript, addressed to that Chrome's process
id**. It needs no screen, no mouse and no macOS Screen Recording or Accessibility permission, so a
locked Mac screen is not a blocker. (That was learned the hard way; see "Mistakes" below.)

---

## Part 1 — Google accounts (one-time, on the browser machine)

This was already in place on the Mac Studio from earlier work (2026-09-20 to 09-24). A new setup
needs it first.

For **each** Google account (`justin@sagemindai.io`, `headley.justin@gmail.com`,
`gearfinity3d@gmail.com`, `adriana@sagemindai.io`, `amrch2388@gmail.com`, `dawn@sagemindai.io`,
`echo@sagemindai.io`, `luna@sagemindai.io`):

1. **A registered Chrome profile.** Each account has its own profile directory under
   `.instar/state/playwright-profiles/<id>/` (`justin-google`, `headley-google`, `gearfinity-google`,
   `adriana-google`, `amrch-google`, `dawn-google`, `echo-google`, `luna-google`), registered with its
   Google identity:
   `POST /playwright-profiles` then `POST /playwright-profiles/<id>/accounts`
   `{"service":"google","identity":"<email>","owner":"agent"|"operator","vaultRefs":[...]}`.
   Check with `GET /playwright-profiles`.
2. **Credentials in the vault, by name only.** `google_password_<name>`, plus either
   `google_totp_<name>` (an authenticator secret the agent enrolled itself) or
   `google_backup_codes_<name>`, used when the person's own authenticator is on their phone.
   Backup codes are **additive**. Never "change authenticator app", because that removes the
   person's own second step. Mirror every credential into the operator's Bitwarden too.
3. **Signed in to Google once**, in that profile, in a normal browser. After that, Google offers
   the account in its account chooser and a sign-in is one click. If Google asks for the password
   or 2-step again, it is answered from the vault (see `/subscription-signin` section 3).
4. **Profile preferences, set before launching Chrome** (in `<profile>/Default/Preferences`):
   - `browser.allow_javascript_apple_events: true`, so the agent can run page JavaScript.
   - **Allow pop-ups** for `https://claude.ai:443,*`, `https://claude.com:443,*`,
     `https://auth.openai.com:443,*`, `https://chatgpt.com:443,*` and
     `https://accounts.google.com:443,*` (under `profile.content_settings.exceptions.popups`,
     `setting: 1`). **Without this, "Continue with Google" on Claude fails with "There was an error
     logging you in"**, because the sign-in pop-up is blocked. The scripts set it automatically.

---

## Part 2 — Claude accounts (paste-back code)

Per account. Automated by `signin-scripts/signin.sh`.

1. **Start the login on the target.** `POST {target}/subscription-pool/enroll` with
   `{"id","label","provider":"anthropic","framework":"claude-code","configHome"}`. `configHome` is
   the target's own folder for this account, e.g. `/home/echo/.claude-followme-<id>`. The reply
   carries `verificationUrl`. Cancel any stale pending login first
   (`POST {target}/subscription-pool/enroll/<id>/cancel`).
2. **Open the link in the account's Chrome on the browser machine**, the normal way:
   `open -na "Google Chrome" --args --user-data-dir=<profile dir> "<verificationUrl>"`.
   Find its main process id: the process whose arguments carry that `--user-data-dir` and no
   `--type=`. A direct binary launch does not answer Apple Events; `open -na` does.
3. **Drive the page by process id** (`signin-scripts/runw.js`: a raw Apple Event `CrSu/ExJa`
   targeted with `descriptorWithProcessIdentifier`, run by `osascript -l JavaScript`). The path is:
   - `claude.ai/login` → click **Continue with Google** → a Google pop-up opens and becomes
     **window 1**.
   - **Account chooser** → click the element whose `data-identifier` equals the expected email.
     Never pick another account.
   - **"You're signing back in to Claude"** → check the email on the page → **Continue**.
   - **Authorize page.** Confirm **"Logged in as <expected email>"** and that the permission list is
     the standard Claude Code set. Stop if either is wrong.
   - **Authorize starts greyed out.** It enables after the page sees activity: dispatch `focus` on
     the window plus `pointerdown` / `pointerup` / `pointermove` / `mouseover` events on the body
     and the button, then re-check every 3 s. It enabled within a few seconds every time. No real
     mouse is needed.
   - Click **Authorize** → `platform.claude.com/oauth/code/callback` shows the code.
4. **Send the code to the target without printing it.** Read it from the page into a pipe and post
   `{"code":"…"}` to `POST {target}/subscription-pool/follow-me/enroll/<id>/submit-code`. The reply
   `outcome: "held", reason: "missing-expected-email", got: "<email>"` is **expected** on this path:
   the login **completed** as that email, but the automatic pool-add is held because the plain
   enroll carries no operator-expected email. The credential is in place.
5. **Close only the Chrome you opened** (kill that one process id).
6. **Register the account if it is new on the target:** `POST {target}/subscription-pool` with
   `{"id","nickname","provider":"anthropic","framework":"claude-code","configHome","email"}`. The
   target reads the email from the fresh credential itself. An account the target already had
   simply turns `active` at the next poll.

## Part 3 — Codex accounts (device code)

Per account. Automated by `signin-scripts/codex.sh`.

1. **Start the login on the target:** `POST {target}/subscription-pool/enroll` with
   `{"id","label","provider":"openai","framework":"codex-cli","configHome"}` (e.g.
   `/home/echo/.codex-followme-<name>`). The reply has `userCode` (like `1N3S-MV9RC`) and
   `verificationUrl` `https://auth.openai.com/codex/device`.
2. **Open `https://auth.openai.com/codex/device`** in the account's Chrome on the browser machine.
3. **Drive the page:**
   - `auth.openai.com/log-in` → **Continue with Google** (the account chooser may be skipped).
   - **Consent page** → check that it shows the expected email → **Continue**.
   - **"Select a workspace"** appears for accounts that belong to more than one workspace (this
     happened for justin@sagemindai.io). **The pre-selected workspace may forbid device-code
     sign-in** ("Please contact your workspace admin to enable device code authentication"), and
     Continue then does nothing. Pick the workspace the account normally uses. Match the
     `chatgpt_account_id` in a known-good copy of that account's `auth.json` (on the Studio it was
     "Personal account"), then Continue.
   - **"Enter the 9-character code"** → fill inputs `character_1` … `character_9` with the code
     minus the dash. Set each value through the native value setter, then fire `input` / `change`
     events so the page notices. → **Continue** → **"Signed in to Codex"**.
4. **Finish on the target:** wait ~10 s, then `POST {target}/subscription-pool/enroll/<id>/complete`.
   A device-code login is not marked complete by itself.
5. **Register it if new:** `POST {target}/subscription-pool` with `provider: "openai"`,
   `framework: "codex-cli"`.

## Part 4 — Verify (never trust "active")

1. `POST {target}/subscription-pool/poll`, then `GET {target}/subscription-pool`. Every account
   should be `active` with `loginCheck: "ok"`. Codex accounts should show
   `lastQuota.source: "codex-app-server"`, a live read from OpenAI.
   **This caught a real failure:** Codex justin@sagemindai.io read `active` for days while it was
   actually signed out (`loginCheck` then showed `signed-out`).
2. **One real request per Claude account, run on the target**:
   `CLAUDE_CONFIG_DIR=<configHome> claude -p "Reply with exactly: OK" --max-turns 1` and read
   `oauthAccount.emailAddress` from `<configHome>/.claude.json` (example: `signin-scripts/v.sh`).
   Run it through a session spawned on the target (`POST {target}/sessions/spawn`, framework
   `codex-cli`, and a model the target's Codex CLI accepts; `gpt-6-sol` was refused there). Have it
   write results to a file under `.instar/tmp/`, and read that back with
   `GET {target}/api/files/download?path=…`. "You've hit your weekly limit" also proves the sign-in
   works; it only means the account is out of quota.
3. **Compare against the whole pool, not the target's own list.** The dashboard's "Accounts on each
   machine" grid (or `GET /subscription-pool?scope=pool`) shows what every other machine has. The
   Mama PC had been offline while 5 accounts were added elsewhere, so they did not exist there at
   all, and checking only its own list missed them.

---

## Running the scripts

From the browser machine's agent home (the Mac holding the profiles):

```bash
export TARGET_MACHINE_ID=<machine id of the target, from .instar/machines/registry.json>
S=docs/runbooks/signin-scripts
# Claude: ACCOUNT_ID  PROFILE_ID  EMAIL  [CONFIG_HOME — required when the account is new on the target]
bash $S/signin.sh sagemind-echo echo-google echo@sagemindai.io /home/echo/.claude-followme-sagemind-echo
# Codex: ACCOUNT_ID  PROFILE_ID  EMAIL  CONFIG_HOME
bash $S/codex.sh codex-adriana adriana-google adriana@sagemindai.io /home/echo/.codex-followme-adriana
```

- The scripts **stop instead of guessing** on any unexpected page, a wrong email, or a non-standard
  permission list, and they close only the Chrome they opened.
- **First launch after the preferences edit often shows no scriptable window** (Apple Event error
  `-1719`). Just run the same command again; the second launch works. This happened on every
  profile the first time.
- The Codex workspace picker is **not** automated; see Part 3 step 3.
- `v.sh` is an example verifier with this machine's account list and paths hard-coded. Adapt it.

## Mistakes made on the way (so nobody repeats them)

1. **Declared a false blocker.** The Studio screen was locked, and a screenshot failed. I told
   Justin I couldn't continue. That was wrong: the Apple Events method never needs the screen, and
   my first read had simply come before Chrome had a window. **Rule:** before calling anything
   blocked, re-run the known-working method at least once. (The Studio's display sleep and screen
   lock are now off regardless.)
2. **Checked only the target's own account list** and reported "all accounts done" while 5 were
   missing. Always compare against the pool-wide list.
3. **Trusted `active`.** One Codex account was signed out behind an `active` label. Always run a
   live check.

## Still open

- The target cannot yet **repair itself** when a login expires. Today the browser machine has to be
  driven by an agent. Plan: `docs/specs/remote-browser-signin-repair.md` (tracked as CMT-609).
- Telegram delivery was intermittently failing during this session (`origin-display-authority-unavailable`,
  `credential-capacity-unavailable`). It is unrelated to sign-in but worth knowing when reporting progress.
