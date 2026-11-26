# Coding-tools startup context trial

The scheduled coding-tools review can start Claude with a set of project integrations. The six latest successful runs made 52 recorded tool calls, all to Bash. The trial tests whether the review can start with a smaller set of instructions and still have the tools it uses.

The trial is off by default. To opt in on an authorized development agent, set `jobs.codingToolsCurrentWithoutProjectMcp` to true. It applies only to the user-defined `coding-tools-current` job when its manifest leaves integration access unspecified. A manifest that explicitly requests project access keeps it. Claude uses the existing empty integration configuration, and its normal Bash entry point stays available. Removing the flag or setting it to false restores the default for subsequent starts.

A controlled startup pair with the job's Claude profile recorded 74,770 input tokens with the usual integrations and 59,798 with the empty integration configuration. That is about a 20% reduction in this measurement. The live schedule and updater were left in place. A live trial would need to compare complete scheduled runs before concluding that the same savings apply to the full review.
