# Holder-local timeout for first-phone version 2

The disabled helper closes local admission at the monotonic deadline, including when a delayed timer has not run. It requests cancellation for the exact attempt key and digest. It keeps admission closed after a refused or unavailable write, and a host retry can submit the same cancellation. An exact witnessed acceptance that won first remains recoverable.

No production route calls the helper. The caller must provide real ordered cancellation and handle retries and restart invalidation. The timer has no trusted wall-clock meaning.
