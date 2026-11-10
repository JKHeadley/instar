## What Changed
The owner's phone can add a Claude or Codex account with Face ID and go straight to its sign-in page.
- **New route `POST /mobile/accounts/add`** `{provider: "claude" | "codex", nickname?, email, challenge, presenceSig}`: owner phone only, behind the app's Face ID write gate. Challenge `POST /mobile/permissions/challenge {action: "account-add", target: "<provider>"}`, signed line `account-add <provider>`.
- **The server picks everything a phone cannot know:** a fresh pool id (`[codex-]<name>-<4 hex>`, never one already used here, on another machine, by a waiting sign-in or by a login folder), the framework (`claude-code` / `codex-cli`) and the login folder (`~/.claude-followme-<id>` / `~/.codex-followme-<id>`), then starts the sign-in on the serving machine through the follow-me sign-in core (now shared with `follow-me/enroll/start`). The answer is start-cell's shape.
- **The account joins the pool only when its sign-in completes and the signed-in email matches**, through the existing follow-me completion and the pool's verified add. The route accepts no credential: any field beyond the five is refused. An email already in the pool answers 409 `account-already-added` with the account id; a second tap returns the same waiting sign-in.

## What to Tell Your User
You can now add a Claude or Codex account from the app: pick which one, type the account's email, confirm with Face ID, and the sign-in page opens. The account shows up once you finish signing in with that email. The app update that uses this comes separately.

## Summary of New Capabilities
- Add a Claude or Codex account from the owner phone with Face ID (`POST /mobile/accounts/add`), straight into its sign-in.

## Evidence
- `tests/unit/account-add-face-id.test.ts`: the signed line, the kind mapping, id derivation and collisions.
- `tests/integration/account-add-face-id.test.ts`: owner ok (Claude and Codex); member, team and bearer 403; bad signature 401; replay 401; a Claude proof cannot add Codex; credential-shaped and malformed fields 400; core refusal passthrough; 503 with no core.
- `tests/e2e/account-add-face-id-alive.test.ts`: on the production boot path the route starts a real follow-me sign-in for a fresh id in the right folder layout, answers start-cell's shape, reuses it on a second tap, leaves the pool untouched until completion, and refuses an email already in the pool.
