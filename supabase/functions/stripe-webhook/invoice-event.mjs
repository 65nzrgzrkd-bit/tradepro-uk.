// Accept old Stripe snapshots and the newer parent.subscription_details shape.
export function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export function invoiceEvent(event) {
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
