const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const code=stripTypeScriptTypes(fs.readFileSync(__dirname+'/index.ts','utf8').replace(/^import .*;\n/gm,''));
let handler,event,rpcResult={data:'applied',error:null},calls=[],checks=0;
class Stripe {constructor(){this.webhooks={constructEventAsync:async(raw,sig)=>{if(sig!=='valid')throw Error('Bad signature');return event;}};}static createSubtleCryptoProvider(){return {};}}
const client={rpc:async(name,args)=>{calls.push({name,args});return rpcResult;},from:table=>({upsert:async args=>{calls.push({table,args});return {error:null};},update:args=>({eq:async()=>{calls.push({table,args});return {error:null};}})})};
vm.runInNewContext(code,{Stripe,createClient:()=>client,Deno:{env:{get:k=>k==='STRIPE_WEBHOOK_SECRET'?'fixture_secret':'fixture'},serve:fn=>handler=fn},Response,console:{log(){},warn(){},error(){}},Date,Number,Math,String,Error});
const req=(method='POST',sig='valid')=>new Request('https://fixture.invalid',{method,headers:{'stripe-signature':sig},...(method==='POST'?{body:'{}'}:{})});
const check=(value,expected)=>{assert.deepEqual(value,expected);checks++;};
(async()=>{
check((await handler(req('GET'))).status,405);
check((await handler(req('POST','invalid'))).status,400);check(calls.length,0);
event={id:'evt_fixture',type:'invoice.paid',created:200,data:{object:{created:100,status:'paid',billing_reason:'subscription_cycle',parent:{subscription_details:{subscription:'sub_fixture'}},lines:{data:[{parent:{subscription_item_details:{subscription:'sub_fixture',proration:false}},period:{end:2000000000}}]}}}};
check((await handler(req())).status,200);check(calls[0].name,'apply_subscription_invoice_event');check(calls[0].args.p_paid,true);
rpcResult={data:'unmapped',error:null};check((await handler(req())).status,503);
rpcResult={data:null,error:{message:'fixture error'}};check((await handler(req())).status,500);
calls=[];event={id:'evt_checkout',type:'checkout.session.completed',data:{object:{mode:'subscription',payment_status:'unpaid',customer_email:'test@example.invalid',subscription:'sub_fixture'}}};
check((await handler(req())).status,200);check(calls.length,0);
event.data.object.payment_status='paid';check((await handler(req())).status,200);check(calls[0].args.status,'active');
calls=[];event={type:'customer.subscription.updated',data:{object:{id:'sub_fixture',status:'active',items:{data:[{current_period_end:2000000000,price:{id:'price_fixture'}}]}}}};
check((await handler(req())).status,200);check(calls[0].args.current_period_end,new Date(2000000000000).toISOString());
console.log(`${checks} handler checks passed (mocked Stripe verification and database transport)`);
})().catch(e=>{console.error(e);process.exitCode=1});
