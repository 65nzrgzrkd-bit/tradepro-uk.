-- Payment ordering belongs to the current subscription mapping. No client grants.
alter table public.subscribers
  add column stripe_invoice_created bigint not null default 0,
  add column stripe_payment_event_created bigint not null default 0,
  add column stripe_payment_event_rank integer not null default 0;

create function public.apply_subscription_invoice_event(
  p_subscription text,
  p_invoice_created bigint,
  p_event_created bigint,
  p_paid boolean,
  p_period_end timestamptz
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  subscriber public.subscribers%rowtype;
  event_rank integer := case when p_paid then 2 else 1 end;
begin
  if p_subscription is null or p_subscription not like 'sub_%'
    or p_invoice_created is null or p_invoice_created <= 0
    or p_event_created is null or p_event_created < p_invoice_created
    or p_paid is null or p_period_end is null then
    raise exception 'Invalid subscription invoice event';
  end if;

  select * into subscriber from public.subscribers
    where stripe_subscription_id = p_subscription for update;
  if not found then return 'unmapped'; end if;

  -- Paying an old invoice must never reactivate an ended/paused subscription.
  if subscriber.status not in ('active', 'past_due') then return 'ineligible'; end if;
  -- A previous billing period must not change this period's access.
  if subscriber.current_period_end is not null
    and p_period_end < subscriber.current_period_end then return 'stale_period'; end if;

  if (p_invoice_created, p_event_created, event_rank) <=
     (subscriber.stripe_invoice_created, subscriber.stripe_payment_event_created,
      subscriber.stripe_payment_event_rank) then return 'stale'; end if;

  update public.subscribers set
    status = case when p_paid then 'active' else 'past_due' end,
    stripe_invoice_created = p_invoice_created,
    stripe_payment_event_created = p_event_created,
    stripe_payment_event_rank = event_rank,
    updated_at = now()
  where id = subscriber.id;
  -- Deliberately preserve cancel_at_period_end, period end, and access_override.
  return 'applied';
end;
$$;

revoke all on function public.apply_subscription_invoice_event(text,bigint,bigint,boolean,timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_subscription_invoice_event(text,bigint,bigint,boolean,timestamptz)
  to service_role;
