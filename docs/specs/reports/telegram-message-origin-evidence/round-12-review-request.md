# Corrective round12

The spec now has concrete authority/source anchors and explicitly selects existing PendingRelayStore SQLite/WAL rather than a new queue product. It explains why external brokers add a second deployment/ownership domain. It requires a complete contract-to-test conformance matrix at activation; the actual ELI16 companion is now inlined for review.

Round11 GPT item4 requests this exact text that is ALREADY PRESENT in the reviewed spec: "Hard invariant: only TelegramOriginOutageNotifier may consume preclaimed outage permits. A source boundary lint restricts imports/calls of the private consumption entry point to that module, and behavioral boundary tests reject counterfeit ordinary-operation references even if the lint is sabotaged." Please verify the actual Recording-outage notification section and withdraw the item if it adds no requirement, rather than repeating it. No author reclassification is claimed.

Return explicit DESIGN/PRECISION counts. Claude's prior MINOR M1/M2 taxonomy is ambiguous: the required vocabulary is DESIGN (behavior/implementation change) or PRECISION (wording only). Both M1/M2 requested additions are now incorporated. Alternatives remain welcome but direct operator requirements and explicit test obligations are not claims that implementation verification has already happened.
