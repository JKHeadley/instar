# Checking peer creation evidence for protected App history

This unmounted helper compares the authenticated journal sender with the
outer entry and inner origin, then compares the entire normalized creation
event with the conflict-free local record. Absent local evidence remains
pending. A conflict or mismatch cannot authorize retention.

The caller must supply an authenticated sender independently of the record.
Reopening the conversation store preserves the local check, while durable
transport evidence and observer wiring still require separate work. The
helper adds no route, background task, configuration, or production effect.

## 6b. Operator-surface quality

The verifier has no user-facing output. Its focused tests cover missing,
matching, and conflicting evidence after reopening local storage.

## Framework generality

The check uses the existing journal and conversation contracts independently
of the device platform.
