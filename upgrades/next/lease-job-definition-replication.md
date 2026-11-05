# Private scheduled-job transfer for lease handoffs

## What Changed

Machines can exchange explicitly marked user job definitions and declared project files over a signed, encrypted peer connection. The feature begins off by default and its first enabled stage only previews received files. An operator must approve the exact file root on the source before export and again on the recipient before installation. The scheduler checks imported files before each run and alerts on transfer or integrity gaps.

## What to Tell Your User

A lease handoff can now expose jobs that exist only on another machine. Private transfer can copy an approved job and its declared files to the new holder once both machines have been explicitly enabled and the source and recipient approvals are given. This does not turn on git-sync or copy Instar configuration, tokens, or secrets.

## Summary of New Capabilities

- Signed, recipient-encrypted transfer of individual approved jobs and declared files.
- Quarantine, preview, PIN-gated approval, revocation, and rollback with scheduler admission fencing.
- Durable transfer gaps and run-time file integrity checks.
- Crash-safe pending state that withholds incomplete imports.
