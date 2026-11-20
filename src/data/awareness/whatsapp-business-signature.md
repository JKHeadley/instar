---
title: WhatsApp Business deliveries are signed
---
With the WhatsApp Business API backend, a delivery is verified with Meta's signature made with the app's App Secret (`businessApi.appSecret` in the WhatsApp messaging config). With the App Secret set, an unsigned or wrongly signed delivery is refused. Without it, deliveries still arrive but are UNVERIFIED (anyone who finds the address could fake one): the server log says so at startup and the owner gets one notice. When the owner uses WhatsApp Business without the App Secret, offer to set it and ask for it through Secret Drop; never accept a pasted secret in chat.
