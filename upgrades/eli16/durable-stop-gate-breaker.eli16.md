# Stop-gate timeout recurrence — plain-English code overview

Instar has a turn-ending judge that must answer quickly. If its model provider
does not answer within two seconds, Instar safely lets the turn end and records a
degradation. A circuit breaker already stopped repeatedly launching a provider
that was known to be too slow, but that breaker lived only in memory. Every
software update restarted the server, erased the brake, and allowed the same
provider to consume a fresh retry budget. The development agent accumulated 179
identical timeout records across more than eighty releases.

The breaker now stores a small health row in the Stop Gate's existing local
SQLite database: the failure count, cooldown deadline, and a temporary lease for
the one allowed recovery probe. A new server loads that row before serving Stop
events. While the cooldown is active it returns the same safe fail-open result
without calling the provider. When the cooldown expires, an atomic lease admits
one probe even if multiple Stop events arrive together. A usable verdict clears
the state; another unusable result reopens it.

No conversation text, prompt, credential, identity, or model output is stored.
The key represents only the resolved provider route, so a real routing change can
probe immediately while a package-version change cannot reset the brake. A
credential or binary repair is checked automatically within five minutes, and
the authenticated `instar gate reset-breaker` action can request an immediate
probe. The existing fail-open safety direction does not change.

The broader process gap is closed too. The loop-safety standard now says routine
restart cannot mint a fresh retry budget while the same pressure remains, and the
shared convergence ratchet rebuilds restart-sensitive controllers at several
points and before every tick. The regression is therefore guarded as a class,
not merely patched at one timeout callsite.
