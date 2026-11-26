# Guarded publication of an App session copy

A protected caller can check authorization before reusing an existing copy and again after staging a new copy and immediately before publishing it. A denied staged copy is removed without publishing its destination. The callback is optional and current call sites do not supply it. Existing copies remain under the existing retention policy. This checkpoint prepares the store for the bound-session route to supply current message and custody evidence.

## 6b. Operator-surface quality

The store can stop a file from being published to the session if its authorization changes during the copy.

## Framework generality

The check runs at the local file publication boundary regardless of how the session is driven.

## Independent review

Concur for the unmounted store guard. A protected copy stays outside the destination directory until the final synchronous check and rename. A refusal discards the staged file.
