# Malformed memory output no longer looks like a healthy machine

Instar measures memory pressure differently on macOS because the ordinary
free-memory number does not include memory the operating system can reclaim.
It runs the native `vm_stat` command, reads several page counters, and combines
them into total and available memory.

The reader already handled a command that throws or cannot run: it logs the
failure and falls back to a rough estimate based on the Instar process memory
and the machine total. But there was a second failure shape. The command could
succeed and return non-empty text that contained none of the expected page
counters. Every missing counter became zero, the total denominator became zero,
and the code returned zero-percent pressure. The machine then looked perfectly
healthy even though nothing had been measured.

The parser now rejects output whose total page count is zero. That rejection is
caught by the existing read-failure handler, so it uses the same logged RSS
fallback the original author already built. The throw path, fallback formula,
logging, thresholds, and real valid parser behavior are unchanged.

The regression deliberately supplies a non-empty string so it cannot pass
through the existing empty-output branch. With a simulated machine using
fifteen of sixteen gigabytes, malformed native output must produce the fallback
reading of 93.75-percent pressure, one gigabyte free, and sixteen gigabytes
total. Restoring the old parser makes that test report zero and fail. This keeps
unknown input from becoming a flattering health measurement without inventing
a new pressure policy.
