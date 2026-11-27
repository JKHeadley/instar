# Side-Effects Review — Privacy-on inbound files

**Version / slug:** `memory-privacy-inbound-files`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent Codex subagent — concurred after the file-claim correction

## Summary of the change

Tier 2, security-sensitive but reversible. `SessionManager` now includes Telegram's actual document directory when staging files for a scoped session and gives a file-specific retry instruction. Adapters identify files they actually downloaded, and the session manager records those files for the receiving conversation before staging. `memorySessionPolicy` stages references inside generated long-message wrappers, checks canonical paths and regular files, and writes unique inbox names. Tests cover PDF bytes, long wrappers, symlink escapes, alias paths, stale files, and unclaimed files. Eight runtime/test files changed; one spec review round and two reviewer passes, one commit/gate attempt planned.

## Decision-point inventory

- Inbound file staging — modified. Only a recent regular file inside a configured inbound root with a server-recorded claim for this conversation can be copied; a symlink outside is refused.
- Session file access — passed through. No sandbox or tool permission is widened.

## 1. Over-block

An attachment queued more than ten minutes remains outside the scope, matching the approved spec's age rule. A legitimate hard-linked or symlinked attachment is also left outside rather than copied. The session should ask for that specific file again.

## 2. Under-block

Claims live in the server process. A restart before a queued file message is injected loses its claim, so that file is not copied and the agent asks for a resend. An attachment queued more than ten minutes also ages out. An adapter path not yet covered by this claim wiring is similarly left unreadable.

## 3. Level-of-abstraction fit

The copy belongs at the existing session injection boundary because it knows the session scope and handles fresh and running sessions. The claim is made by the adapter or server when it creates the file, not by text the sender types. Canonical path checks are structural filesystem validation, and the sandbox remains the authority over the session's reads.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). This is a hard filesystem invariant, not a judgment about message meaning. The change holds no new semantic blocking authority. The sandbox policy still decides the file access boundary; the staging helper only decides whether to create a copy inside it.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals judgment point. File regularity, canonical containment and age are enumerable structural conditions already present in the approved design.

## 5. Interactions

The long-message copy happens before the first-party bootstrap injection and also applies to a running session's injected message. Nested wrappers are rewritten at most two levels. Unique target names avoid one file replacing another with the same basename. The root list now matches Telegram's download path and uses its configured state directory. Claims are tied to the session's Telegram topic or Slack channel and to the file's identity. The ten-minute rule remains in force, so a long queue can still make a valid attachment unavailable.

## 6. External surfaces

People can send PDFs into a privacy-on session when the file is within the allowed age. If one file cannot be read, the agent gets a file-specific retry instruction. No connected tool, outbound route, or other person's scope is opened.

## 7. Multi-machine posture

Machine-local by design. Inbound files and scope inboxes are local to the machine serving the session. A moved topic needs its attachment to be present on the destination machine; this change does not replicate files. Each machine uses the same canonical validation.

## 8. Rollback cost

A revert removes the nested rewrite, Telegram document root, and retry instruction. Existing staged copies remain in session scope inboxes until that scope's normal lifecycle; there is no migration or external side effect to reverse.

## Second-pass review

The first pass identified a concrete cross-conversation leak: a sender could name another recent file in a shared inbound directory. The patch now requires an adapter/server claim bound to the conversation and file identity. On the second pass, the independent reviewer concurred with that correction and found no remaining concrete blocker. Process-local claims can be lost on restart; Slack threads share the channel audience under the existing policy.
