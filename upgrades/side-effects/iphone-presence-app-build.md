# iPhone build reporting

This small compatibility change records the last app build reported by a device for its own pairing. The existing device signature covers the same push registration body, including the optional build field. An owner can read the report from the device list or a signed Needs You read for that pairing.

The existing push revision still orders writes. A malformed or missing build report leaves the last known value intact. A push token clear also leaves the report intact. A build-only change does not cycle the push token version. Owner reads omit the field for pairings with no report. Team reads do not receive the field. The report is display metadata and is never an approval or permission signal.

There is no migration. Reverting the code stops recording and displaying the optional field. Existing registration and token behavior continue.

Tests exercise registry write ordering, the signed HTTP pipeline, and a disposable production-shaped boot with a paired device. The draft does not turn on owner admission or publish an iPhone build.
