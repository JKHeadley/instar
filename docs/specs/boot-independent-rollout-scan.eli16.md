# Keep the Agent Available While It Checks Feature Releases

The agent periodically reads feature specifications and release records to work out which changes have been built and released. That useful housekeeping was running in a way that could stop the server from doing anything else. During the Studio incident, those reads overlapped long gaps in the server log. The server stopped answering health checks, was restarted, and then missed the regular renewal that lets it remain the active machine.

This repair lets those reads wait without freezing the server. The same safe Git tools and the same files remain in use. Health requests and lease renewals can continue while the release records load. A second scan cannot start while the first one is still working. Stopping the server also stops the scan before its supporting storage closes.

We will test the whole journey with a large temporary repository, a real health endpoint and a real isolated lease coordinator. The test records response and renewal gaps through both loading and applying the results. It compares the old synchronous behavior with the repaired behavior, so an early successful response cannot hide a later freeze. No real owner messages, production lease or production server are involved in that test.

This change does not relax lease expiry or give two machines permission to lead. It keeps the current restart rules. Preventing an additional restart after a boot loses authority needs a separate audit of every service that depends on being the lead, and the Chief has explicitly assigned that as the next repair after this one lands.

Local test success will mean the isolated repair passed its checks. It will not mean the Studio or every other machine is already updated. The final revision still needs the normal complete verification and release process before we can report it as deployed.
