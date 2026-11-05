alter table public.subscribers
  add column stripe_lifecycle_event_created bigint not null default 0,
  add column stripe_payment_confirmed boolean not null default true;

create function public.apply_subscription_lifecycle_event(
  p_kind text, p_email text, p_customer text, p_subscription text,
  p_status text, p_period_end timestamptz, p_price text,
  p_cancel boolean, p_created bigint
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare s public.subscribers%rowtype; paid boolean := p_kind='checkout_paid';
begin
  if p_kind is null or p_kind not in ('checkout_paid','checkout_pending','subscription')
    or p_subscription is null or p_subscription !~ '^sub_[A-Za-z0-9_]+$'
    or p_created is null or p_created <= 0 then raise exception 'Invalid lifecycle event'; end if;

  if p_kind in ('checkout_paid','checkout_pending') then
    if p_email is null or p_email not like '%@%' or p_customer is null then
      raise exception 'Missing checkout identity';
    end if;
    insert into public.subscribers(email,stripe_customer_id,stripe_subscription_id,status,
      stripe_payment_confirmed,stripe_lifecycle_event_created)
      values(lower(trim(p_email)),p_customer,p_subscription,
        case when paid then 'active' else 'incomplete' end,paid,p_created)
      on conflict(email) do nothing;
    select * into s from public.subscribers where email=lower(trim(p_email)) for update;
    if s.stripe_subscription_id=p_subscription then
      -- Checkout replays cannot undo a cancellation or later payment failure.
      if paid and s.status='incomplete' then
        update public.subscribers set status='active',stripe_payment_confirmed=true,updated_at=now() where id=s.id;
        return 'applied';
      end if;
      return 'already_mapped';
    end if;
    -- Only replace an ended mapping with a genuinely newer signup.
    if s.stripe_subscription_id is not null and
      (s.status not in ('canceled','incomplete_expired','inactive') or
       p_created <= greatest(s.stripe_lifecycle_event_created,s.stripe_payment_event_created)) then
      return 'conflict';
    end if;
    update public.subscribers set stripe_customer_id=p_customer,stripe_subscription_id=p_subscription,
      status=case when paid then 'active' else 'incomplete' end,
      current_period_end=null,price_id=null,cancel_at_period_end=false,
      stripe_payment_confirmed=paid,stripe_lifecycle_event_created=p_created,
      stripe_invoice_created=0,stripe_payment_event_created=0,stripe_payment_event_rank=0,
      updated_at=now() where id=s.id;
    return 'applied';
  end if;

  select * into s from public.subscribers where stripe_subscription_id=p_subscription for update;
  if not found then return 'unmapped'; end if;
  if p_status is null or p_status not in ('active','trialing','past_due','canceled','paused','unpaid','incomplete','incomplete_expired')
    or p_cancel is null then raise exception 'Invalid subscription status'; end if;
  -- A canceled Stripe subscription ID is terminal; renewal needs a new ID.
  if s.status='canceled' and p_status<>'canceled' then return 'terminal'; end if;
  if p_created < s.stripe_lifecycle_event_created then return 'stale'; end if;
  -- Without retrieval, conflicting snapshots in the same second are ambiguous.
  -- Accept cancellation; otherwise ask Stripe to retry rather than guess.
  if p_created=s.stripe_lifecycle_event_created and p_status<>'canceled'
    and not (s.current_period_end is null and s.price_id is null and s.stripe_invoice_created=0) then
    if p_status<>s.status or p_cancel<>s.cancel_at_period_end or p_period_end is distinct from s.current_period_end then
      return 'ambiguous';
    end if;
    return 'duplicate';
  end if;
  if p_status in ('active','past_due') and p_created <= s.stripe_payment_event_created then
    p_status := case when s.stripe_payment_event_rank=2 then 'active' else 'past_due' end;
  end if;
  -- An asynchronous payment's subscription may become active before payment settles.
  if p_status='active' and not s.stripe_payment_confirmed then p_status:='incomplete'; end if;
  update public.subscribers set status=p_status,price_id=p_price,
    current_period_end=p_period_end,cancel_at_period_end=p_cancel,
    stripe_lifecycle_event_created=p_created,updated_at=now() where id=s.id;
  return 'applied';
end;
$$;
revoke all on function public.apply_subscription_lifecycle_event(text,text,text,text,text,timestamptz,text,boolean,bigint) from public,anon,authenticated;
grant execute on function public.apply_subscription_lifecycle_event(text,text,text,text,text,timestamptz,text,boolean,bigint) to service_role;

create or replace function public.apply_subscription_invoice_event(
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
  if subscriber.status not in ('active', 'past_due')
    and not (p_paid and subscriber.status='incomplete') then return 'ineligible'; end if;
  if p_event_created < subscriber.stripe_lifecycle_event_created then return 'stale_lifecycle'; end if;
  -- A previous billing period must not change this period's access.
  if subscriber.current_period_end is not null
    and p_period_end < subscriber.current_period_end then return 'stale_period'; end if;

  if (p_invoice_created, p_event_created, event_rank) <=
     (subscriber.stripe_invoice_created, subscriber.stripe_payment_event_created,
      subscriber.stripe_payment_event_rank) then return 'stale'; end if;

  update public.subscribers set
    status = case when p_paid then 'active' else 'past_due' end,
    stripe_payment_confirmed = subscriber.stripe_payment_confirmed or p_paid,
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
