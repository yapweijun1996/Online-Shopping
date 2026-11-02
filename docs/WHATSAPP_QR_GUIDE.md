# Using WhatsApp QR chats

The official WhatsApp Cloud API remains the recommended connection. QR linking is an experimental, unofficial alternative: WhatsApp does not support unofficial linked clients, and may restrict or permanently ban the number. Use a dedicated business number, not a personal or critical business number.

## Enable and link

1. Ask your operator to provision a fixed worker slot and, for a tenant, have SuperAdmin enable its QR policy. Default uses slot 0; at most one admitted tenant uses slot 1. Unprovisioned/disabled shops and public-demo/quick-login shops remain unavailable. See [the release gates](GCP_DEPLOY.md#fixed-slot-protected-release).
2. As Owner, open **Company settings**. Below the official **WhatsApp connection** card, read **Link WhatsApp by QR code** and select **I understand the risk**. Other roles can view status but cannot acknowledge, pair or disconnect.
3. Select **Show QR code**. On your phone open WhatsApp → Settings → Linked devices → Link a device, then scan. Codes expire after 60 seconds; select **Get a new code** if necessary. Keep the settings page visible while connecting.
4. A connected status and masked phone number confirm the worker's connection. The risk notice remains available as an expandable section.

## Read and reply

Open **Messages → WhatsApp chats**. The existing **Cloud messages** view stays separate. Select a thread to read it; on a phone use **Back** to return to the list. **Load more** and **Load earlier** page through threads and messages. Suggested order chips open Sales Orders; these are suggestions, not automatic customer identity links.

Like WhatsApp Web, Messages shows your chats with avatars, last message and time, a search box and day separators. You can reply to any listed chat while the connection is active; there is no 24-hour reply window. Messages you sent from your phone appear in the chat as outgoing messages labelled **Sent from your phone**.

**What is imported.** When you link WhatsApp, WhatsApp sends your recent chats once. The panel imports direct one-to-one text messages from the last 30 days (at most 5000 messages) with the contact names WhatsApp provides. Groups, status, broadcasts, newsletters, media, voice notes and reactions are not imported, and imported history never adds an unread badge. After that, new text messages (including those you send from your phone) appear as they happen. To import your chats again, choose **Disconnect** and link again; WhatsApp only sends the history while linking. Messages older than 30 days lose their text (retention) while the row stays.

Messages are limited to 4096 characters. Select **Send** or press Ctrl/Cmd+Enter. If the network fails, retrying unchanged text in the same composer reuses the original intent to avoid duplicate replies. Do not reload or switch threads to retry an uncertain send; this in-memory intent does not survive navigation.

Queued and Sending are not delivery confirmations. Sent means the worker reported sending. **Check your phone** means the outcome is uncertain: inspect WhatsApp rather than sending a duplicate. Failed and Cancelled remain visible. Rate-limit notices show the wait in seconds. Removed message bodies show **Message removed after 30 days**.

Only visible pages poll: the open chat every five seconds, the list every fifteen seconds, and a connecting QR card every two seconds. Connected settings poll every fifteen seconds while the card is on screen. QR pixels are generated locally using the vendored MIT QR encoder; no remote QR service, browser storage or API service-worker caching is used.

## Disconnect

As Owner, select **Disconnect** on the pairing card and confirm. Queued replies are cancelled; history remains subject to retention and erasure rules. Remote unlinking is not guaranteed: remove the linked device in the official phone app as well when required. Relinking requires scanning again. Acknowledging these risks is not customer consent.

Platform disable/suspension revokes QR access; resume does not automatically
re-enable or pair. Ask the operator to resolve pending cleanup before reusing a
slot. An unavailable worker is not proof it stopped. Remove linked devices in
the official phone app when required; no automatic Cloud failover or resend.
