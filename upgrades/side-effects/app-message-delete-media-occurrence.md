# Removal-aware attachment occurrence lookup

The App store checks the current custodian proof before selecting a non-purged matching attachment from a surviving message in the named conversation. A second readable occurrence of the same file remains eligible when the first is removed. The index and original stored attachment must agree. The lookup yields the exact proof so its eventual caller can revalidate before serving bytes. It does not mutate attachment references, blobs, journals or production routes. The JavaScript projection inspects at most 100 candidate occurrences and refuses incomplete results.

## 6b. Operator-surface quality

A deleted attachment occurrence cannot justify a download. Another surviving message can still justify opening the same file.

## Framework generality

The occurrence is keyed by conversation, exact message and attachment. The store API is independent of client platform and HTTP transport.

## Independent review

Concur for the unmounted store helper. It checks the exact stored attachment identity, hash and size, excludes custodian removals and returns proof for final delivery checks.
