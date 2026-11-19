# Codex sessions run on the account they are recorded on (plain-English overview)

## What happened

Echo can use several Codex (ChatGPT) logins. Each login lives in its own folder on the Mac, for example `~/.codex` for Dawn's login and `~/.codex-followme-justin-gmail` for headley.justin. When a session is moved to a different login, usually so it uses an account with quota left, instar records the new account on the session and restarts Codex.

On 2026-11-17 Justin asked for the Android, remote-desktop and dashboard work to run on headley.justin. The sessions were moved, and instar's records said they were on headley.justin. But Justin's quota screen showed Dawn's usage growing and headley's barely moving. He was right. From about 4:40 PM to 7:50 PM PT those sessions' conversation files were being written in Dawn's folder, `~/.codex`. Later in the evening the sessions were restarted by hand on the right folder, and the processes running now use headley's folder.

## Why it happened

Codex picks its login from one setting, the `CODEX_HOME` folder. When instar restarts a Claude session on another account, it sets Claude's equivalent setting. For Codex it never did: the code that builds the Codex launch command ignored the login folder it was given. So Codex quietly kept using the server's default login (Dawn's) while the session was labelled with the other account. The quota was spent on the wrong account, under the right account's name.

## What changes

1. When a Codex session is started or restarted on a specific account, Codex is now pointed at that account's login folder.
2. A Codex conversation can only be resumed from the folder it runs in. Before restarting a session on another account, instar now copies the conversation's file into that account's folder. If both folders hold a copy, the newer one wins, and the older one is kept under a different name, never deleted. If no copy can be found, the session starts fresh with a note that its earlier conversation couldn't be reopened, instead of failing to start.

## What does not change

- A Codex session that isn't moved to a specific account still uses the default login, as before.
- Claude sessions are unchanged.
- No login, token or password is copied. Only the conversation history file is.

## Two fixes added after an independent review

- The history file is copied under a temporary name first and only then moved into place. If a copy stops halfway, the half-copied file never sits where Codex looks for it.
- A copy left behind can get out of date. Say a session moves from the default login to an account, and later restarts on the default login. The default login still has the older copy, which is missing the newer turns. Before restarting there, the newest copy is now brought back too. If no copy is found anywhere, the session behaves as it did before.
- A history file that disappears while it is being looked at counts as "not here". It is not treated as an error.

## What to check after this ships

After a move, the session's recorded account and its running process's `CODEX_HOME` should match. The account's usage on the quota screen should be the one that grows.
