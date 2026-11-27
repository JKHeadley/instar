# First-phone ordered decision policy

The dormant reducer checks the exact challenge, verifies the v2 signature against the nominated presence key for consumption, and preserves the first supplied terminal outcome. An exact retry can recover that decision. A conflicting cancellation, consumption, or altered request cannot replace it.

The caller must provide a verified current challenge and enforce the empty-slot comparison inside a serialized witnessed write. This module performs no storage or production acceptance.
