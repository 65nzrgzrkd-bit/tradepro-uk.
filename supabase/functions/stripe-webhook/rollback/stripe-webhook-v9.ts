import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const webhookSecret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") || "").trim();
const stripe = new Stripe("sk_test_placeholder", { apiVersion: "2025-06-30.basil" as any });

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
      if (email && subscription) {
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
      const currentPeriodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
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

    if (evt.type === "invoice.payment_failed") {
      const subscription = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      if (subscription) {
        const { error } = await supabase.from("subscribers").update({
          status: "past_due",
          updated_at: new Date().toISOString()
        }).eq("stripe_subscription_id", subscription);
        if (error) throw error;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
    return new Response(String(e), { status: 500 });
  }
});