export function lifecycleEvent(event) {
  const obj=event.data?.object||{};
  const id=value=>typeof value==='string'?value:value?.id||null;
  const checkout=['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type);
  if(checkout && obj.mode!=='subscription')return null;
  if(!checkout && !['customer.subscription.updated','customer.subscription.deleted'].includes(event.type))return null;
  if(!Number.isSafeInteger(event.created)||event.created<=0)throw Error('Missing event creation time');
  if(event.type==='checkout.session.async_payment_succeeded' && obj.payment_status!=='paid')throw Error('Async success without paid status');
  const ends=(obj.items?.data||[]).map(item=>item.current_period_end).filter(Number.isSafeInteger);
  const end=obj.current_period_end||(ends.length?Math.min(...ends):null);
  return {
    p_kind:checkout?(obj.payment_status==='paid'?'checkout_paid':'checkout_pending'):'subscription',
    p_email:checkout?String(obj.customer_details?.email||obj.customer_email||'').trim().toLowerCase():null,
    p_customer:id(obj.customer),p_subscription:checkout?id(obj.subscription):id(obj),
    p_status:checkout?null:(event.type==='customer.subscription.deleted'?'canceled':obj.status),
    p_period_end:checkout||!end?null:new Date(end*1000).toISOString(),
    p_price:checkout?null:id(obj.items?.data?.[0]?.price),
    p_cancel:checkout?false:!!obj.cancel_at_period_end,p_created:event.created
  };
}
