# Carry the original app message safely to the new holder

When one machine saves an app message during a handover, the machine that receives it next needs evidence that it is the same message the phone sent. This checkpoint binds the signed message, the exact request identifier, the conversation and the saved record into an acknowledgement signed by the machine that accepted it. The receiving machine can check that evidence against the original phone signature. For ordinary messages, it also recomputes the request fingerprint from what the phone signed. When a secret was deliberately removed, the evidence binds the redaction without storing that secret.

This checkpoint verifies historical custody. The receiving machine must still verify that the phone has access now and obtain the current holder’s dispatch claim. The app route has not been changed at this stage.
