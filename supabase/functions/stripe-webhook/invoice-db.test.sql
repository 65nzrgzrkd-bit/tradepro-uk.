begin;
insert into public.subscribers(email,stripe_subscription_id,status,current_period_end,cancel_at_period_end,access_override)
values ('fixtivo-transaction-test@example.invalid','sub_fixtivo_transaction_test','active','2030-01-01',true,true);
do $$
declare result text; s public.subscribers%rowtype;
begin
  result := public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',100,110,false,'2030-01-01');
  assert result='applied';
  select * into s from public.subscribers where stripe_subscription_id='sub_fixtivo_transaction_test';
  assert s.status='past_due';
  assert s.cancel_at_period_end and s.access_override;
  result := public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',100,120,true,'2030-01-01');
  assert result='applied';
  select * into s from public.subscribers where stripe_subscription_id='sub_fixtivo_transaction_test';
  assert s.status='active';
  assert s.cancel_at_period_end and s.access_override and s.current_period_end='2030-01-01'::timestamptz;
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',100,110,false,'2030-01-01')='stale';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',100,120,true,'2030-01-01')='stale';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',100,120,false,'2030-01-01')='stale';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',90,130,true,'2030-01-01')='stale';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',130,140,false,'2029-12-01')='stale_period';
  assert public.apply_subscription_invoice_event('sub_unmapped_fixture',100,110,true,'2030-01-01')='unmapped';
  update public.subscribers set status='canceled' where stripe_subscription_id='sub_fixtivo_transaction_test';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',140,150,true,'2030-02-01')='ineligible';
  update public.subscribers set status='paused' where stripe_subscription_id='sub_fixtivo_transaction_test';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',140,150,true,'2030-02-01')='ineligible';
  update public.subscribers set status='incomplete_expired' where stripe_subscription_id='sub_fixtivo_transaction_test';
  assert public.apply_subscription_invoice_event('sub_fixtivo_transaction_test',140,150,true,'2030-02-01')='ineligible';
  assert not has_function_privilege('anon','public.apply_subscription_invoice_event(text,bigint,bigint,boolean,timestamptz)','execute');
  assert not has_function_privilege('authenticated','public.apply_subscription_invoice_event(text,bigint,bigint,boolean,timestamptz)','execute');
  assert has_function_privilege('service_role','public.apply_subscription_invoice_event(text,bigint,bigint,boolean,timestamptz)','execute');
end $$;
select '18 database assertions passed; fixture rolled back' as validation;
rollback;
