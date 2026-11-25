# Exact Telegram request fixture

This dormant parser accepts a literal text-only request from a supplied authenticated ingress record. It keeps the payload byte-for-byte and hashes the source coordinates, authenticated sender, time and complete request text.

- Authority. The caller must obtain the evidence at trusted ingress, resolve the current owner and validate record freshness before using this parser. The parser grants no authority and has no live caller.
- Coverage. Missing source facts, bot or channel authorship, media, forwards and quote or reply metadata fail closed. A source row must use a canonical bot scope and real Telegram coordinates.
- Delivery. The parsed fingerprint must still resolve to a currently accepted pairing. The existing one-use reservation is a separate operation at the send boundary.
- Rollback. This checkpoint creates no stored state or public route.

Independent review concurred after the parser explicitly refused missing and non-string bot scopes.
