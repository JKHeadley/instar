# A lower-memory verification trial

The Mini stopped its first test runs when the computer's available memory fell below the measured floor. The roughly one gigabyte in the early receipts was the memory used by worker processes, separate from the host floor. One later run could not confirm its memory reading and put the trial in quarantine. Reliable memory evidence still matters because the computer also runs other services.

This change lets the coordinator and Mini agree to run one unit worker in place of the earlier fixed two. Both sides must advertise the same signed policy, and the Mini's live worker setting must match it. Integration and lifecycle suites keep one shard each. The feature still runs one pull-request check at a time. The existing memory floor, reserve and quarantine protections still apply. The new setting must be shipped and calibrated before any trial resumes.
