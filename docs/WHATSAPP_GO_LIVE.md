# WhatsApp go-live checklist (slice 7)

Status: checklist for the owner. The code is merged (slices 0 to 6, see [WHATSAPP_IMPLEMENTATION_PLAN.md](WHATSAPP_IMPLEMENTATION_PLAN.md)); nothing is sent until the steps below are done. Meta facts are marked **[assumed]**: they come from general knowledge of the WhatsApp Business Platform and must be checked against Meta's current documentation as each step is done.

## 0. The decision that blocks everything: which site gets the real account

The live shop currently runs with quick sign-in on (`SELLER_QUICK_LOGIN=1`, the passwordless "Try the seller dashboard" entry), shop mode `production`, and 6 sample orders. While quick sign-in is on, the server refuses to connect an account, hides connections and messages, and never starts the message worker, because anyone could reach the seller area.

| Option | What it means | Cost |
| --- | --- | --- |
| A. Turn quick sign-in off on the live shop | Real account on `shop.gmb01.xyz` / `seller.gmb01.xyz`; the passwordless sample entry disappears | Simplest; the sample entry is lost until another site exists |
| B. A separate stack for the real account | Second Compose project with its own database and hostnames, quick sign-in off; the current site stays the sample | More containers and host work; this is also the shape of the future per-client tenant |
| C. Test only with Sandbox first | Same as A, but only the Sandbox connection and Meta's test number until the owner is happy | Same cost as A, smaller blast radius |

Recommendation: C, then A. Turning it off is a host change (`SELLER_QUICK_LOGIN=0` in the updater's `runtime.env` on the MacBook Air, followed by a redeploy); it is not done until the owner chooses.

## 1. What the owner prepares in Meta (all **[assumed]**)

1. A Meta Business account, and a developer app of type Business with the WhatsApp product added.
2. A WhatsApp Business Account (WABA) and a phone number. For a first test Meta provides a test number and lets you add a few recipient numbers (use the owner's own).
3. Values to collect: **Phone number ID**, **WhatsApp Business Account ID**, **App secret** (app settings, basic), and a **permanent access token** (a system user with the messaging and management permissions; the temporary token expires within about a day and is only good for a quick check).
4. Four message templates, category Utility, in every language the shop uses, with exactly the names and variables in the plan's "Template contract": `order_submitted`, `order_confirmed`, `order_rejected` (`{{1}}` buyer name, `{{2}}` order number) and `order_shipped` (`{{3}}` carrier, `{{4}}` tracking number). Approval takes minutes to a day or more.
5. Sending to arbitrary customers (outside the test recipients) needs business verification and a registered number; this can take days and is outside the code.

Never paste the token or the app secret into chat, git, or an issue. They go only into the seller page.

## 2. What happens on the day (in this order)

1. Owner decides section 0. If A or C: set `SELLER_QUICK_LOGIN=0`, redeploy, confirm the passwordless entry is gone and the login page asks for the password.
2. Owner signs in, opens Settings, **WhatsApp connection**, picks **Sandbox**, pastes the four values and presses Connect. Expected: status Connected, token hint, Meta's display number and verified name. A rejected token shows "Meta rejected the credentials".
3. Owner copies the callback URL and the **verify token** from the card into the app's webhook settings in Meta, verifies, and subscribes the `messages` field. Expected: Meta accepts the handshake (the server answers the challenge only for the stored verify token).
4. Place one real order from the shop with the owner's own number (the number added as a test recipient), WhatsApp consent ticked. Expected within about 15 seconds: a message row `ACCEPTED`, the message on the phone, then `DELIVERED` and `READ` from Meta's receipts.
5. Confirm and ship that order in the seller area: two more messages. Reply from the phone: the reply appears under Messages and on the order, unread count in the menu.
6. Break something on purpose once: rename a template in Meta, place an order, expect `FAILED` ("WhatsApp did not accept this message") and that **Send again** works after fixing it.
7. Only then connect **Production** with the real number, or switch the existing connection.

## 3. Rollback

Press **Disconnect** on the card: the stored secrets are cleared and no message is sent after the next tick. Messages already queued stay in the table and are failed when the worker finds no connection. Setting `SELLER_QUICK_LOGIN=1` again also stops the worker. The master key and database are untouched.

## 4. Known limits to accept before go-live

- A message whose outcome is unknown is never retried automatically; the seller decides in the Messages page (a short window of work for the owner each time).
- A delivery receipt that arrives before the send result is recorded leaves that message at `ACCEPTED`.
- Replies keep text only; images and other media say "Open WhatsApp".
- Buyer reply retention and lawful basis (DEC-07) are not decided; the owner must confirm before buyers' real replies are stored.
- Single backend process; a second replica would need the claim to be re-checked.
