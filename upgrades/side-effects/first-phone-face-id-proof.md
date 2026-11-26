# First-phone dedicated Face ID proof verification

The dark codec verifies separate registration and confirmation transcripts using the shared Swift and Node vector. It rejects noncanonical key and signature encodings, the old presence format, changed assurance, cross-domain signatures, and altered binding generations. The existing ordered attempt key remains stable. Both dedicated transcripts require a canonical HTTPS origin.

The verifier takes the public key and transcript details from the trusted caller. Cryptographic verification alone cannot establish installed-key eligibility, current owner and holder state, or the availability of the first approval slot. Those predicates still belong at the witnessed transaction boundary.

No executable route, production caller, key registration, or permission mutation is introduced. Existing legacy calls continue using their original transcript. The verifier can be removed without migrating stored data.
