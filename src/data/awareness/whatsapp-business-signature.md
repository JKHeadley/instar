---
title: WhatsApp Business deliveries are signed
---
With the WhatsApp Business API backend, a delivery is accepted only when Meta signed it with the app's App Secret (`businessApi.appSecret` in the WhatsApp messaging config). Without that setting every WhatsApp Business message is refused and the server log says so at startup. When the owner uses WhatsApp Business and messages stop arriving, check that setting first and ask the owner for the App Secret through Secret Drop; never accept a pasted secret in chat.
