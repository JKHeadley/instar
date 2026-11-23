# Explain A Reply From Verified Facts

During a controlled Telegram test, the person replied to the correct question with “1) yes”. The server correctly left the settings alone because the confirmation protocol requires the exact word yes. It also gave the agent the right context: this was a reply to an existing question. The agent read that context and sent the registered reminder, but then added a second explanation that falsely blamed a missing reply link.

This change gives the agent clearer, structured facts at the point where it needs to compose a response. The server will identify a verified native reply separately from whether its text is an exact yes. The successful question API response will also include the actual delivered message receipt and say whether the question remains registered. A confirmed registered reminder is already the user-facing response; the agent should finish that turn without sending another approval instruction.

The confirmation rules do not change. A model cannot approve settings, a request still needs the verified owner and exact identified change, and an uncertain send cannot be called delivered. No general message filter or suppression rule is added. Ordinary conversation and later progress updates remain available.

The work is a separate communication repair after the batch protocol change, as the Chief of Staff directed. It will be checked with focused unit, HTTP and lifecycle regressions and a new real Telegram exercise. The earlier bad explanation and failed test history will remain recorded. No one should call the overall conversation experience clean until this follow-up actually passes.
