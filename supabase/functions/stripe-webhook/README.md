# Subscription invoice recovery (5 November 2026)

The webhook now processes `invoice.paid`, reads both legacy and current invoice subscription references, and reads subscription period ends from subscription items. Only paid subscription Checkout sessions grant access.

The service-role-only SQL function serializes invoice updates, orders them by invoice creation and event creation, ignores duplicates, and gives successful payment priority when timestamps tie. It only changes active/past_due subscriptions and rejects invoices covering an older period. Scheduled cancellation, period end, and manual access overrides are preserved.

Validation: 16 invoice payload checks, 12 lifecycle payload checks, 15 handler checks (mocked signature verifier/database transport), and 44 real Postgres assertions within rolled-back transactions. Total: 87 assertions. Database tests do not commit fixture subscribers. The signing secret is never stored here.

Limits: these tests do not prove a live Stripe-signed delivery. Pending Checkout sessions are mapped without granting access. invoice.paid can activate the mapped incomplete subscription when settlement succeeds. checkout.session.async_payment_succeeded is supported too, but is not yet selected in the Dashboard. Subscription snapshots use a separate ordering cursor; canceled IDs remain terminal and conflicting same-second snapshots return 503 for reconciliation instead of guessing. Customer email synchronization and refund/dispute/fraud handling still need work before declaring the integration launch-ready. Conflicting subscription IDs also return 503 and require reconciliation; unsupported old IDs may continue retrying. Real Stripe delivery, new subscriber access, and cancellation still require end-to-end validation. Tax settings and registrations have not been changed.

The runtime Stripe client uses a placeholder key exclusively for local signature verification; no Stripe API retrieval is performed by this handler. The existing server-side STRIPE_WEBHOOK_SECRET is still required.

Rollback: redeploy `rollback/stripe-webhook-v9.ts` as the edge function. The additive database columns/function may remain unused. Function requests authenticate with Stripe's signature, not Supabase JWTs.
