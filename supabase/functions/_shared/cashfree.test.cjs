const es=require('/tmp/node_modules/esbuild'), fs=require('fs'), crypto=require('crypto'), assert=require('assert');
const src=fs.readFileSync('/sessions/serene-focused-planck/mnt/abrobot-crm-app/supabase/functions/_shared/cashfree.ts','utf8');
const js=es.transformSync(src,{loader:'ts',format:'cjs'}).code;
// stub Deno env with a known secret
const secret='cfsk_ma_prod_TESTKEY_1234567890abcdefghijklmn';
global.Deno={env:{get:(k)=>({CASHFREE_SECRET_KEY:secret,CASHFREE_APP_ID:'app123',CASHFREE_ENV:'production'})[k]}};
const m={exports:{}}; new Function('module','exports','Deno',js)(m,m.exports,global.Deno);
const {verifyWebhook}=m.exports;

const body=JSON.stringify({type:'PAYMENT_SUCCESS_WEBHOOK',data:{order:{order_id:'abcrm_test'}}});
const sign=(ts)=>crypto.createHmac('sha256',secret).update(ts+body).digest('base64');

(async()=>{
  let p=0,f=0; const t=async(n,fn)=>{try{await fn();console.log('  ✓',n);p++}catch(e){console.log('  ✗',n,'—',e.message);f++}};

  // exactly what Cashfree sends: 13-digit MILLISECONDS
  const msTs=String(Date.now());
  await t('accepts Cashfree millisecond timestamp',async()=>{
    const r=await verifyWebhook(body,sign(msTs),msTs);
    assert(r.ok===true,'rejected: '+(r.reason||''));
  });

  // seconds should still work (other providers / manual tests)
  const secTs=String(Math.floor(Date.now()/1000));
  await t('still accepts second timestamp',async()=>{
    const r=await verifyWebhook(body,sign(secTs),secTs);
    assert(r.ok===true,'rejected: '+(r.reason||''));
  });

  // stale millisecond timestamp must still be rejected
  const oldMs=String(Date.now()-60*60*1000);
  await t('rejects stale ms timestamp (1h old)',async()=>{
    const r=await verifyWebhook(body,sign(oldMs),oldMs);
    assert(r.ok===false&&/window/.test(r.reason),'got: '+JSON.stringify(r));
  });

  // wrong secret must still be rejected
  await t('rejects wrong signature',async()=>{
    const bad=crypto.createHmac('sha256','WRONG').update(msTs+body).digest('base64');
    const r=await verifyWebhook(body,bad,msTs);
    assert(r.ok===false&&/mismatch/i.test(r.reason),'got: '+JSON.stringify(r));
  });

  // tampered body must be rejected
  await t('rejects tampered body',async()=>{
    const r=await verifyWebhook(body.replace('abcrm_test','hacked'),sign(msTs),msTs);
    assert(r.ok===false,'tampered body accepted!');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  process.exit(f?1:0);
})();
