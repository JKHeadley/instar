# Bounded first-page query for native Delete acceptance

The isolated protected history endpoint accepts the native client's existing first-page limit query. It accepts one integer from 1 through 100 and uses it before returning a signed history page. Duplicate or oversized values and unrelated options are refused. Exact context pagination uses its existing route. Normal startup and the standalone pins request contract are unchanged.

## 6b. Operator-surface quality

The isolated iOS build can use its usual first history request when opening the synthetic chat.

## Framework generality

The bounded value is independent of native application framework and keeps the same signed authority.

## Independent review

Concur. The query permits a single bounded scalar. The existing standalone pins and ordinary history paths retain their behavior.
