import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@23.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const webhookSecret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") || "").trim();
const stripe = new Stripe("sk_test_placeholder", { apiVersion: "2026-09-30.endive" as any });

// Accept old Stripe snapshots and the newer parent.subscription_details shape.
function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function invoiceEvent(event) {
  if (!['invoice.paid', 'invoice.payment_failed'].includes(event.type)) return null;
  const invoice = event.data?.object || {};
  const subscription = stripeId(invoice.parent?.subscription_details?.subscription)
    || stripeId(invoice.subscription);
  // Proration/manual invoices are not evidence that the recurring bill was paid.
  if (!subscription || !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason)) return null;
  const paid = event.type === 'invoice.paid';
  if (paid && invoice.status !== 'paid') throw new Error('Paid event has unpaid invoice');
  const lines = invoice.lines?.data || [];
  const ends = lines.filter(line => {
    const linked = stripeId(line.parent?.subscription_item_details?.subscription)
      || stripeId(line.subscription);
    return linked === subscription && !line.proration
      && !line.parent?.subscription_item_details?.proration;
  }).map(line => line.period?.end).filter(end => Number.isSafeInteger(end) && end > 0);
  if (!ends.length || !Number.isSafeInteger(invoice.created) || !Number.isSafeInteger(event.created)) {
    throw new Error('Incomplete subscription invoice snapshot');
  }
  return {
    p_subscription: subscription,
    p_invoice_created: invoice.created,
    p_event_created: event.created,
    p_paid: paid,
    p_period_end: new Date(Math.min(...ends) * 1000).toISOString()
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") || "";
  if (!webhookSecret || !sig) {
    console.error("Stripe webhook verification failed: missing secret or signature");
    return new Response("Bad signature", { status: 400 });
  }

  let evt: Stripe.Event;
  try {
    evt = await stripe.webhooks.constructEventAsync(
      raw,
      sig,
      webhookSecret,
      300,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (e) {
    console.error("Stripe webhook verification failed:", e instanceof Error ? e.message : String(e));
    return new Response("Bad signature", { status: 400 });
  }

  const obj: any = evt.data?.object || {};
  try {
    if (evt.type === "checkout.session.completed") {
      const email = String(obj.customer_details?.email || obj.customer_email || "").trim().toLowerCase();
      const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
      const subscription = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      if (email && subscription && obj.mode === "subscription" && obj.payment_status === "paid") {
        const { error } = await supabase.from("subscribers").upsert({
          email,
          stripe_customer_id: customer || null,
          stripe_subscription_id: subscription,
          status: "active",
          updated_at: new Date().toISOString()
        }, { onConflict: "email" });
        if (error) throw error;
      }
    }

    if (evt.type === "customer.subscription.updated" || evt.type === "customer.subscription.deleted") {
      const subscription = String(obj.id || "");
      const status = evt.type === "customer.subscription.deleted" ? "canceled" : String(obj.status || "inactive");
      const periodEnd = obj.current_period_end || obj.items?.data?.[0]?.current_period_end;
      const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
      const priceId = obj.items?.data?.[0]?.price?.id || null;
      const { error } = await supabase.from("subscribers").update({
        status,
        price_id: priceId,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: !!obj.cancel_at_period_end,
        updated_at: new Date().toISOString()
      }).eq("stripe_subscription_id", subscription);
      if (error) throw error;
    }

    const payment = invoiceEvent(evt);
    if (payment) {
      const { data, error } = await supabase.rpc("apply_subscription_invoice_event", payment);
      if (error) throw error;
      // Stripe retries if its invoice arrived before checkout mapped the email.
      if (data === "unmapped") {
        console.warn("Stripe invoice awaiting checkout mapping", evt.id);
        return new Response("Subscription mapping pending", { status: 503 });
      }
      console.log("Stripe invoice event processed", evt.id, evt.type, data);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
    return new Response("Webhook processing failed", { status: 500 });
  }
});