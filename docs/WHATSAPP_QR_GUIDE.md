# Using WhatsApp QR chats

The official WhatsApp Cloud API remains the recommended connection. QR linking is an experimental, unofficial alternative: WhatsApp does not support unofficial linked clients, and may restrict or permanently ban the number. Use a dedicated business number, not a personal or critical business number.

## Enable and link

1. Ask your operator to enable the experimental QR worker for the default shop as described in [the design](WHATSAPP_QR_DESIGN.md) and [worker protocol](WHATSAPP_QR_PROTOCOL.md). Disabled shops, tenant shops and sample/quick-login shops do not show the card or inbox tab.
2. As Owner, open **Company settings**. Below the official **WhatsApp connection** card, read **Link WhatsApp by QR code** and select **I understand the risk**. Other roles can view status but cannot acknowledge, pair or disconnect.
3. Select **Show QR code**. On your phone open WhatsApp → Settings → Linked devices → Link a device, then scan. Codes expire after 60 seconds; select **Get a new code** if necessary. Keep the settings page visible while connecting.
4. A connected status and masked phone number confirm the worker's connection. The risk notice remains available as an expandable section.

## Read and reply

Open **Messages → WhatsApp chats**. The existing **Cloud messages** view stays separate. Select a thread to read it; on a phone use **Back** to return to the list. **Load more** and **Load earlier** page through threads and messages. Suggested order chips open Sales Orders; these are suggestions, not automatic customer identity links.

Replies are limited to customers who messaged you within the last 24 hours. When the window closes, the customer must send another message first. The connection must also be active. Messages are limited to 4096 characters. Select **Send** or press Ctrl/Cmd+Enter. If the network fails, retrying unchanged text in the same composer reuses the original intent to avoid duplicate replies. Do not reload or switch threads to retry an uncertain send; this in-memory intent does not survive navigation.

Queued and Sending are not delivery confirmations. Sent means the worker reported sending. **Check your phone** means the outcome is uncertain: inspect WhatsApp rather than sending a duplicate. Failed and Cancelled remain visible. Rate-limit notices show the wait in seconds. Removed message bodies show **Message removed after 30 days**.

Only visible pages poll: the open chat every five seconds, the list every fifteen seconds, and a connecting QR card every two seconds. Connected settings poll every fifteen seconds while the card is on screen. QR pixels are generated locally using the vendored MIT QR encoder; no remote QR service, browser storage or API service-worker caching is used.

## Disconnect

As Owner, select **Disconnect** on the pairing card and confirm. Queued replies are cancelled; history remains subject to retention and erasure rules. Remote unlinking is not guaranteed: remove the linked device in the official phone app as well when required. Relinking requires scanning again. Acknowledging these risks is not customer consent.
