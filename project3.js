'use strict';
// Authenticated WhatsApp 2 -> Project 3 connector. No historical order replay.
const BASE=String(process.env.PROJECT3_BASE_URL||'').trim().replace(/\/+$/,'');
const TOKEN=String(process.env.PROJECT3_API_KEY||'').trim();
const isConfigured=()=>/^https:\/\//i.test(BASE)&&Boolean(TOKEN);
function cents(v){const n=Number(v);if(!Number.isFinite(n)||n<0)throw Error('Invalid WhatsApp cart price.');return Math.round(n*100);}
function cartToItems(cart){
 if(!Array.isArray(cart)||!cart.length)throw Error('Cannot send empty order to Project 3.');
 const rows=[];
 for(const item of cart){
   const qty=Number(item.qty)||1;
   if(!Number.isFinite(qty)||qty<=0)throw Error('Invalid item quantity.');
   const total=cents(item.total),design=cents(item.designFee||0),
     poles=cents(item.polesCost||0),installation=cents(item.installationFee||0);
   const material=total-design-poles-installation;
   if(material<0)throw Error('Order line extras exceed item price.');
   const label=[item.name||'Item',item.dimensions,item.sku?'SKU: '+item.sku:'',item.designNotes?'Design: '+item.designNotes:'']
     .filter(Boolean).map(String).join(' | ');
   const type=String(item.fulfillmentType||'PRODUCTION').toUpperCase()==='STOCK'?'STOCK':'PRODUCTION';
   // Project 3 prices batches as qty/unitsPerProduct * unitPrice.
   // This preserves exact Rand/cents and the actual production quantity.
   // Deliberately omit the bot SKU to avoid Project 3 catalogue re-pricing.
   rows.push({sku:'',description:label,qty,unitsPerProduct:qty,
     unitPrice:material/100,designFee:design/100,fulfillmentType:type});
   if(poles)rows.push({sku:'',description:'Poles for '+(item.name||'item'),qty:1,unitPrice:poles/100,fulfillmentType:'PRODUCTION'});
   if(installation)rows.push({sku:'',description:'Installation for '+(item.name||'item'),qty:1,unitPrice:installation/100,fulfillmentType:'PRODUCTION'});
 }
 return rows;
}
async function request(apiPath,method='GET',body){
 if(!isConfigured())throw Error('Project 3 connection is not configured.');
 const options={method,headers:{Authorization:'Bearer '+TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(20000)};
 if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
 const response=await fetch(BASE+apiPath,options);
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error('Project 3 '+response.status+': '+String(data.error||'Integration request failed.').slice(0,260));
 return data;
}
async function health(){return request('/health');}
async function createQuote(order,notes=''){
 const items=cartToItems(order.cart),total=cents(order.grandTotal)/100;
 const computed=Math.round(items.reduce((sum,x)=>sum+(x.qty/(x.unitsPerProduct||1))*x.unitPrice+Number(x.designFee||0),0)*100)/100;
 if(Math.abs(computed-total)>=0.009)throw Error('Order total and line items differ. Payment link withheld.');
 return request('/quote','POST',{
   externalOrderId:order.id,
   customer:{name:order.customerName||order.customerPhone||'WhatsApp customer',
     phone:order.customerPhone||'',whatsapp:order.customerPhone||'',email:order.customerEmail||''},
   items,total,notes
 });
}
async function markPaid(order,amount,paymentReference){
 if(!order?.project3QuoteNumber)throw Error('Project 3 quote missing. No invoice posted.');
 if(!String(paymentReference||'').trim())throw Error('PayFast transaction reference missing.');
 return request('/order/'+encodeURIComponent(order.id)+'/paid','POST',{
   quoteNumber:String(order.project3QuoteNumber),amount,paymentReference:String(paymentReference).trim()
 });
}
module.exports={isConfigured,health,cartToItems,createQuote,markPaid};
