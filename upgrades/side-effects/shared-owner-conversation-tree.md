# Shared owner conversation tree read

The dashboard can request the same bounded graph tree used by signed mobile
owners. It uses existing dashboard operator proof. A service bearer alone
cannot open the tree. The route rechecks the grant before returning content
and uses the existing read model, cursor and readiness handling.

## 6b. Operator-surface quality

The dashboard can read nested saved groups in one request and report
incomplete or unavailable data through the same fields as mobile.

## Framework generality

The same projection serves desktop and mobile with their existing
authentication rules.
