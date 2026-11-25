# Side-effects review for local round launch exclusion

Within the single supervised process, managed admission rechecks the approved item, takes the existing round lock and persists the work claim before releasing the lock. The ordinary executor checks the durable claim under the same lock before initial allocation and before any child relaunch. A changed round can therefore refuse work that already has a managed claim.

The packaged lifecycle test injects the same store into both paths. The production executor still has no managed claim reader or managed launcher. No flag or existing project changes. An unset reader preserves prior ordinary behavior while this feature is dark.

## Second-pass review

**Reviewer:** shared_round_admission_review, independent Instar second-pass agent

Concur for the single-process fixture composition. A production restart can leave the detached ordinary child alive after its parent PID lock expires. The lock also cannot establish ownership between independently active server processes. Production must pass a required claim reader to ordinary entry points and fence old ordinary children before accepting new managed work. A terminal or aborted managed row currently stays held. Production needs verified retirement and retry handling before turning this on.
