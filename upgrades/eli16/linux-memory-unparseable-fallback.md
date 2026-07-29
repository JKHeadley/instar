# Malformed Linux memory output no longer looks healthy

Instar reads `/proc/meminfo` on Linux to calculate how much of the host's memory
is under pressure. That calculation needs a total-memory value.

Previously, a successful file read with unexpected or malformed text parsed the
total as zero and returned zero-percent pressure. The pressure classifier then
treated the host as normal, even though no memory measurement existed. Read
errors already had a visible fallback that estimates pressure from process RSS,
but the successful-yet-unparseable path never reached it.

The Linux parser now rejects content that has no parseable `MemTotal`. The
existing try/catch logs the degradation and invokes the existing RSS fallback,
exactly as it does for a failed read. Valid `MemAvailable` and
`MemFree+Buffers+Cached` calculations are unchanged.

Tests cover the parser boundary and the full reader path. Restoring the old
zero fallback makes the parser accept garbage and makes the end-to-end reading
return zero instead of the injected high-pressure fallback.
