# Keep the evidence when a unit test process stops without explaining why

Sometimes the unit test runner exits with an error even though its report does not name a failed test. The useful message can appear early in the process output. The recent lines may only show unrelated tests finishing, and the checkout can be removed later to reclaim disk space. The result is a failed verification with too little evidence to decide who should investigate.

For this failure class, Local Verify now saves a private transcript outside the checkout. It includes the beginning and end of each stream and records how many bytes it omitted if the stream was too large. The verifier keeps eight recent transcripts per machine. The ordinary test verdict stays independent of transcript storage, and the audit records the location without including raw test output. Operators who need to inspect the transcript can read it on the machine where the run took place.
