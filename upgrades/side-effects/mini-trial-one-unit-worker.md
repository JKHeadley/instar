# Side-effects review

The policy admits either one or two unit workers using the existing signed request. Both modes require the worker count in the host setting to match the signed value. Unsupported or mismatched policies fail closed. The worker count in the verifier child comes from the admitted trial policy. Integration and lifecycle shard counts stay at one each.

This change adds no authority or new dispatch path. It preserves memory measurement, reserve, quarantine, recovery, leases and one attempt at a time. Existing two-worker configurations retain their behavior. A mixed-version peer rejects or fails to advertise a one-worker policy, so enable that opt-in only once both runtimes contain the change. Revert to the existing two-worker configuration on both hosts to back out the option.

## Second-pass review

Reviewer: /root/unit_exit_review. The reviewer concurred for publication with the existing trial opt-in and confirmed exact signed policy comparison, worker propagation and preservation of capacity defenses. It identified that synthetic HTTP acceptance evidence cannot prove the actual process launch count. Coordinator lifecycle dispatch and mismatch refusal are covered by tests. A real guarded one-worker trial remains a rollout gate.
