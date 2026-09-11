// Resolve esbuild and the source file portably.
//
// These two lines used to be:
//   require('/tmp/node_modules/esbuild')
//   fs.readFileSync('/sessions/<some-sandbox>/.../cashfree.ts')
// — an absolute path to a scratch directory in the machine that happened to
// write the test. It passed exactly once, on that machine. In CI, and on any
// other checkout, it threw MODULE_NOT_FOUND before reaching a single
// assertion, and because the CI step runs `set -e` the whole job went red on
// an error that had nothing to do with the code under test.
const path = require('path');
function loadEsbuild() {
  // vite depends on esbuild, so app/node_modules almost always has it.
  const candidates = [
    'esbuild',
    path.join(__dirname, '..', '..', '..', 'app', 'node_modules', 'esbuild'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'esbuild'),
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      // Requiring is not enough. esbuild ships a native binary, and a
      // node_modules copied between platforms (a mac checkout read from a
      // Linux container, the usual case) requires fine and then throws on
      // first use. Prove it actually works before returning it.
      mod.transformSync('const a = 1;', { loader: 'ts' });
      return mod;
    } catch (_) { /* try the next candidate */ }
  }
  console.log('SKIP ' + path.basename(__filename) + ' — no usable esbuild for this platform. Run `npm ci` in app/.');
  process.exit(0);
}
const es = loadEsbuild();
const fs=require('fs'), crypto=require('crypto'), assert=require('assert');
const src=fs.readFileSync(path.join(__dirname, 'cashfree.ts'),'utf8');
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
