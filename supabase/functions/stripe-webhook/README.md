# Subscription invoice recovery (5 November 2026)

The webhook now processes `invoice.paid`, reads both legacy and current invoice subscription references, and reads subscription period ends from subscription items. Only paid subscription Checkout sessions grant access.

The service-role-only SQL function serializes invoice updates, orders them by invoice creation and event creation, ignores duplicates, and gives successful payment priority when timestamps tie. It only changes active/past_due subscriptions and rejects invoices covering an older period. Scheduled cancellation, period end, and manual access overrides are preserved.

Validation: 16 invoice payload checks, 14 handler checks (mocked signature verifier/database transport), and 18 real Postgres assertions within a rolled-back transaction. Database tests do not commit fixture subscribers. The signing secret is never stored here.

Limits: these tests do not prove a live Stripe-signed delivery. Delayed/asynchronous Checkout fulfillment, subscription-event ordering, customer email synchronization, and refund/dispute/fraud handling still need further work before declaring the billing integration launch-ready. This change intentionally covers recurring invoice recovery, not every subscription lifecycle case. Tax settings and registrations have not been changed.

The runtime Stripe client uses a placeholder key exclusively for local signature verification; no Stripe API retrieval is performed by this handler. The existing server-side STRIPE_WEBHOOK_SECRET is still required.

Rollback: redeploy `rollback/stripe-webhook-v9.ts` as the edge function. The additive database columns/function may remain unused. Function requests authenticate with Stripe's signature, not Supabase JWTs.
