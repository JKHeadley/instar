# Local retention of App removal-read custody

The unmounted store records one immutable creation-event and custodian tuple per App conversation. A successful write uses a private staged file, file synchronization, atomic no-replace publication and directory synchronization. An exact repeated write can confirm the existing tuple. A conflict or corrupt record cannot replace it. Reading fresh state creates no files. No write flag, route, advertised capability, replication or live enrollment changes.

Local absence cannot authorize an old read. Fleet activation still needs authoritative distribution of the requirement and fencing of incompatible serving builds. A restored, incomplete local state directory is outside this store's authority.

## 6b. Operator-surface quality

A later restart can recover the recorded serving machine for a protected conversation. This checkpoint changes no app behavior.

## Framework generality

The record binds an App creation event and machine independently of native client and harness.

## Independent review

Concur after making a post-open disappearance unavailable and handling scratch-cleanup errors as retention failure. The exact retry never replaces an existing binding.
