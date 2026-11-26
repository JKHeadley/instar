# Local history copy confirmation recheck

The private staging coordinator can now compare the sealed confirmation and every destination fingerprint while the fixed worker holds the actual writer lock. It exposes the verified first plan to a synchronous staging observer and discards the plan afterward.

The observer provides a point for future permit integration, with no authority to write. Ordinary preview and publication are unaffected.

The test uses two real SQLite connections to confirm the writer lock is held during the observation and released afterward. A changed destination prevents observation.
