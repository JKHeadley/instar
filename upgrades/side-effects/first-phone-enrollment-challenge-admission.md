# First-phone enrollment challenge admission

The existing mobile challenge route recognizes the dedicated first-phone action. It checks transport and active owner phone status under the trust approval gate, validates the exact action fields and calls the nomination authority precheck before issuing a challenge. This action does not depend on the console having a PIN. Other actions retain their existing PIN rules.

No production composition supplies the precheck, so the action returns unavailable. There is no new submission or acceptance path in this checkpoint. The HTTP fixture injects the precheck to prove both refusal and challenge issuance through the real transport and device authentication code.

Independent review concurred after adding a dedicated computer refusal before nomination evaluation.
