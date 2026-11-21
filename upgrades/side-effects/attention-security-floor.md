# Side-effects review: attention security floor recognises two missed shapes

## Summary of the change

One regular expression (`SECURITY_RE` in `src/core/AttentionLifecycle.ts`) gains three alternatives and loses one word boundary. Rows it matches are classed `security` and are never expired or superseded by the attention lifecycle pass.

## 1. Over-block

The only effect of a match is that a row is never auto-closed. Measured against all 4,522 current rows on four machines: two rows newly match, both genuine security asks. "rotate" still needs a word boundary after it, so "Rotating log files" does not match (tested).

## 2. Under-block

Unchanged for everything the old pattern matched; it is a strict superset.

## 3. Level-of-abstraction fit

The class decision already lives in this one function; the fix stays there.

## 4. Signal vs authority compliance

The pattern grants no authority; it only withholds the system's own close.

## 5. Interactions

`decideAttentionExpiry`, `planAttentionSupersessions` and `clearAttentionCondition` all read the class through `classifyAttentionLifecycle`; a security row is refused by each, as before.

## 6. External surfaces

None.

## 7. Multi-machine posture

Each machine classifies its own rows; no replicated state changes.

## 8. Rollback cost

Revert the one line.

## Conclusion

Safe, narrow, measured.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` — not applicable: this narrows what the existing pass may close; it adds no self-triggered action.
