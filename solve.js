'use strict';
const fs=require('fs'), https=require('https'), {spawn}=require('child_process');
const L=(s)=>{const line=new Date().toISOString().slice(11,19)+' '+s; try{console.log(line);}catch(e){} try{fs.appendFileSync('step.log',line+'\n');}catch(e){}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function doh(host,type){return new Promise(res=>{ const req=https.get({host:'1.1.1.1',port:443,path:'/dns-query?name='+encodeURIComponent(host)+'&type='+type,headers:{accept:'application/dns-json'},servername:'cloudflare-dns.com'},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{const j=JSON.parse(b);const want=type==='AAAA'?28:1;const a=(j.Answer||[]).filter(x=>x.type===want);res(a[0]?a[0].data:null);}catch(e){res(null);}});}); req.setTimeout(4000,()=>{req.destroy();res(null);}); req.on('error',()=>res(null)); });}
async function clickAll(page){ let did='';
  for(const f of page.frames()){ if(/challenges\.cloudflare/.test(f.url())){ try{ const fe=await f.frameElement(); if(fe){ const b=await fe.boundingBox(); if(b&&b.width>4){ await page.mouse.click(b.x+35,b.y+b.height/2); did+='frame '; } } }catch(e){} } }
  try{ const r=await page.evaluate(()=>{ let hit=null; function w(root,d){ for(const el of root.querySelectorAll('*')){ if(el.shadowRoot&&d<4){ const h2=w(el.shadowRoot,d+1); if(h2) return h2; } if(el.tagName==='INPUT'||String(el.className).match&&/cb-lb|checkbox|mark|turnstile/.test(String(el.className))){ const b=el.getBoundingClientRect(); if(b.width>4&&b.height>4) return {x:b.x+b.width/2,y:b.y+b.height/2}; } } return null; } return w(document,0); }); if(r){ await page.mouse.click(r.x,r.y); did+='pierce '; } }catch(e){}
  return did; }
(async()=>{
  L('solve v6 env-target');
  const puppeteer=require('puppeteer-core');
  const SITE=process.env.TARGET_HOST||'velor.win';
  const exe=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/opt/google/chrome/chrome'].find(p=>fs.existsSync(p));
  const control=(await doh('challenges.cloudflare.com','A'))||'104.18.94.41';
  spawn(exe,['--user-data-dir=./chrome-solve-prof','--remote-debugging-port=9333','--no-first-run','--no-default-browser-check','--window-size=1280,900','--host-resolver-rules=MAP brunhild.challenges.cloudflare.com '+control,('https://'+SITE+'/')],{detached:true,stdio:'ignore'}).unref();
  await sleep(6000);
  let b=null;
  for(let k=0;k<20&&!b;k++){ try{ b=await puppeteer.connect({browserURL:'http://127.0.0.1:9333'}); }catch(e){ await sleep(1000); } }
  if(!b){ L('attach failed'); process.exit(1); }
  const p=(await b.pages()).find(x=>x.url().includes(SITE))||(await b.pages())[0];
  let title='';
  for(let i=0;i<200;i++){
    await sleep(1000);
    try{ title=await p.title(); }catch(e){}
    if(i%15===0)L('tick '+i+' \"'+title+'\"');
    if(i>=3 && i%4===0){ const d=await clickAll(p); if(d&&i<40)L('click '+i+' -> '+d); }
    if(i===45||i===100||i===155){ await p.reload({waitUntil:'domcontentloaded'}).catch(()=>{}); L('reload@'+i); }
    if(title&&!/Just a moment|Attention Required/i.test(title)){ L('CLEARED('+i+')'); break; }
  }
  const cf=(await p.cookies()).find(c=>c.name==='cf_clearance');
  const ua=await p.evaluate(()=>navigator.userAgent).catch(()=>'');
  if(cf){ fs.writeFileSync('cf_cookie.txt','cf_clearance='+cf.value); fs.writeFileSync('cf_ua.txt',ua); L('COOKIE SAVED'); }
  else { const sn=await p.content().catch(()=>''); const s=String(sn).replace(/\s+/g,' '); const err=(s.match(/error code: [0-9]+/)||['-'])[0]; L('NO COOKIE. title=\"'+title+'\" chl_opt='+/__cf_chl_opt/.test(s)+' '+err+' snip='+s.slice(0,120)); }
  try{b.disconnect();}catch(e){}
  L('done'); process.exit(0);
})();