import assert from 'node:assert/strict';
import { invoiceEvent } from './invoice-event.mjs';
const base = {type:'invoice.paid',created:200,data:{object:{created:100,status:'paid',billing_reason:'subscription_cycle',parent:{subscription_details:{subscription:'sub_fixture'}},lines:{data:[{parent:{subscription_item_details:{subscription:'sub_fixture',proration:false}},period:{end:2000000000}}]}}}};
let checks=0;
const check=(fn)=>{fn();checks++;};
check(()=>assert.equal(invoiceEvent(base).p_subscription,'sub_fixture'));
check(()=>assert.equal(invoiceEvent(base).p_paid,true));
check(()=>assert.equal(invoiceEvent(base).p_period_end,new Date(2000000000000).toISOString()));
const legacy=structuredClone(base);delete legacy.data.object.parent;legacy.data.object.subscription={id:'sub_fixture'};legacy.data.object.lines.data=[{subscription:'sub_fixture',proration:false,period:{end:2000000000}}];
check(()=>assert.deepEqual(invoiceEvent(legacy),invoiceEvent(base)));
const failed=structuredClone(base);failed.type='invoice.payment_failed';failed.data.object.status='open';
check(()=>assert.equal(invoiceEvent(failed).p_paid,false));
for(const reason of ['manual','subscription_update',undefined]){const e=structuredClone(base);e.data.object.billing_reason=reason;check(()=>assert.equal(invoiceEvent(e),null));}
const unrelated=structuredClone(base);unrelated.type='charge.refunded';check(()=>assert.equal(invoiceEvent(unrelated),null));
const noSub=structuredClone(base);delete noSub.data.object.parent;check(()=>assert.equal(invoiceEvent(noSub),null));
for(const path of ['status','lines','created']){const e=structuredClone(base);delete e.data.object[path];check(()=>assert.throws(()=>invoiceEvent(e)));}
for(const line of [{subscription:'sub_other',period:{end:2000000000}},{subscription:'sub_fixture',proration:true,period:{end:2000000000}},{parent:{subscription_item_details:{subscription:'sub_fixture',proration:true}},period:{end:2000000000}}]){const e=structuredClone(base);e.data.object.lines.data=[line];check(()=>assert.throws(()=>invoiceEvent(e)));}
console.log(`${checks} invoice payload checks passed`);
