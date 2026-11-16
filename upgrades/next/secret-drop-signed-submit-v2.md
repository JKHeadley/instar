# Secret Drop: signed agent-to-agent submissions use an unambiguous format

## What Changed

When one agent hands a secret to another through Secret Drop, the sending agent signs the submission with its key and the receiver checks that signature. The signed format is now versioned. Version 2 (`_sigv: "2"`) encodes the values so that two different sets of values can never share a signature, and it signs the same trimmed values the receiver stores. Submissions from older senders, with no version, are still accepted when none of their values spans more than one line. A multi-line value from an older sender is refused with a plain message asking to update Instar on the sending machine; the link stays valid so it can be sent again. `SecretDrop.submitWithReason` reports why a submission was refused.

## What to Tell Your User

Nothing changes for normal secrets. If an older Instar on another machine tries to hand over a multi-line secret (such as a key file), it is asked to update first and then send again.

## Summary of New Capabilities

None. Security hardening of signed Secret Drop submissions.
