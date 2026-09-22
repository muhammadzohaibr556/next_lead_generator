import '../scripts/env';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

async function smoke(){
 const port=process.env.SMOKE_PORT||'33001',base='http://127.0.0.1:'+port,password=randomBytes(24).toString('hex');
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',port],{env:{...process.env,APP_USERNAME:'smoke',APP_PASSWORD:password,ALLOWED_HOSTS:'127.0.0.1',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',chunk=>{output+=chunk;});server.stderr.on('data',chunk=>{output+=chunk;});
 const headers={Authorization:'Basic '+Buffer.from('smoke:'+password).toString('base64')};
 try{
  let ready=false;for(let attempt=0;attempt<80;attempt++){
   if(server.exitCode!==null)throw Error('Next.js failed to start: '+output);
   try{const response=await fetch(base+'/api/health');if(response.status===401){ready=true;break;}}catch{}
   await delay(100);
  }
  assert.ok(ready,'Production server did not become ready');
  const health=await fetch(base+'/api/health',{headers});assert.equal(health.status,200);assert.equal((await health.json()).status,'ok');assert.match(health.headers.get('cache-control')||'',/no-store/);
  const page=await fetch(base,{headers});assert.equal(page.status,200);const csp=page.headers.get('content-security-policy')||'',nonce=csp.match(/'nonce-([^']+)'/)?.[1];assert.ok(nonce);assert.ok(!csp.includes('unsafe-eval'));assert.ok((await page.text()).includes('nonce="'+nonce+'"'));
  const forbidden=await fetch(base+'/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'https://untrusted.example'},body:'{}'});assert.equal(forbidden.status,403);
  const oversized=await fetch(base+'/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(70000)})});assert.equal(oversized.status,413);
  assert.equal((await fetch(base+'/api/leads?center_lat=30',{headers})).status,422);
  for(const path of ['/api/leads','/api/leads/map','/api/stats','/api/sources','/api/coverage','/docs'])assert.equal((await fetch(base+path,{headers})).status,200,path);
  const exported=await fetch(base+'/api/leads/export',{headers});assert.equal(exported.status,200);assert.match(exported.headers.get('content-type')||'',/text\/csv/);
  console.log('PASS: production HTTP, authentication, nonce CSP, CSRF, request-size limits, API endpoints and CSV.');
 }finally{
  if(server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(resolve=>server.once('exit',()=>resolve()));}
 }
}
smoke().catch(error=>{console.error(error.message);process.exitCode=1;});
