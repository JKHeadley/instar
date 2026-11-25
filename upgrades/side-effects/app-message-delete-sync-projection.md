# Private App message removal sync projection

The new store projection returns authorized message rows and exact removal markers under one prepared custody proof. It suppresses removed originals, returns only four fields for a marker, and retains the cursor before unresolved access or missing original evidence. A confirmed denial advances without the marker. The existing events route filters raw removal facts while the feature remains off.

This checkpoint adds no signed route or client behavior. Production needs reader and visibility-epoch cursor binding, sanitized payloads, and cache reconciliation on epoch changes.

## 6b. Operator-surface quality

A client can receive an exact removal while keeping its cursor and older message pages consistent. Unresolved access delays the page without losing the marker.

## Framework generality

The projection does not depend on the client platform or agent harness.
