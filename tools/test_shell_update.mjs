// Run the real worker against controlled fetch/cache APIs. No browser or production data required.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

const handlers = {}, cached = new Map(), puts = [], removed = [], timeouts = [];
let network = () => Promise.resolve({ ok:true, redirected:false, clone(){return this;} });
let claimed = false;
const cache = { match: async r => cached.get(r.url), put: (r,v) => { puts.push(r.url); cached.set(r.url,v); } };
const context = { URL, location:{origin:'https://sentinel.test'}, fetch:(...args)=>network(...args),
  setTimeout:fn=>timeouts.push(fn), caches:{ open:async()=>cache, keys:async()=>['sentinel-eye-shell-v10','sentinel-eye-shell-v11'], delete:async name=>removed.push(name) },
  self:{ addEventListener:(name,fn)=>handlers[name]=fn, skipWaiting(){}, clients:{claim:async()=>{claimed=true;}} } };
runInNewContext(readFileSync(new URL('../web/sw.js',import.meta.url),'utf8'),context);
let count=0;
const check=(name,ok)=>{assert.ok(ok,name);count++;};
let activation;handlers.activate({waitUntil:p=>activation=p});await activation;
check('activation removes the old shell and claims clients',removed.join()==='sentinel-eye-shell-v10'&&claimed);
function request(path,method='GET') {
  let response;
  handlers.fetch({request:{url:new URL(path,'https://sentinel.test').href,method},respondWith:p=>response=p});
  return response;
}
for (const path of ['/api/settings','/api/timeline/thumb/1','/api/export/test','/login','/pair?code=TEST','/js/login.js','/js/pair.js','https://other.test/app.css']) {
  check(`uncached: ${path}`,request(path)===undefined);
}
check('writes never intercepted',request('/api/settings','PUT')===undefined);
const fresh=await request('/css/app.css');
check('online assets come from the network and enter the shell cache',fresh.ok&&puts.includes('https://sentinel.test/css/app.css'));
network=()=>Promise.reject(new Error('offline'));
check('offline can launch the previously fetched asset',await request('/css/app.css')===fresh);
await assert.rejects(request('/js/unseen.js'));
check('missing offline assets surface the real failure',true);
network=()=>Promise.resolve({ok:true,redirected:true,clone(){return this;}});
const before=puts.length;await request('/');
check('sign-in redirects never replace the cached app',puts.length===before);
network=()=>new Promise(()=>{});
const slow=request('/css/app.css'); await nextTurn(); timeouts.forEach(fn=>fn());
check('slow-network fallback uses the already cached shell',await slow===fresh);

// All anonymous entry imports and the authenticated module graph must ship as ordinary static files.
const visited=new Set();
function visit(relative) {
  if(visited.has(relative))return;visited.add(relative);
  const url=new URL('../web/'+relative,import.meta.url);check(`ships ${relative}`,existsSync(url));
  const text=readFileSync(url,'utf8');
  if(relative.endsWith('.js'))for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    const child=new URL(match[1],url);visit(child.pathname.split('/web/')[1]);
  }
}
for(const entry of ['index.html','login.html','pair.html']) {
  const html=readFileSync(new URL('../web/'+entry,import.meta.url),'utf8');
  check(`${entry} loads adaptive styling`,html.includes('css/app.css') && readFileSync(new URL('../web/css/app.css',import.meta.url),'utf8').includes('Shared adaptive contract'));
  check(`${entry} carries the current diagnostic version`,html.includes('adaptive-v11'));
  for(const match of html.matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)"/g))visit(match[1]);
}
const manifest=JSON.parse(readFileSync(new URL('../web/manifest.json',import.meta.url),'utf8'));
for (const entry of ['main','login','pair']) {
  const moduleURL = new URL(`../web/js/${entry}.js`,import.meta.url).href;
  const linked = spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(moduleURL)})`],{encoding:'utf8'});
  // Linking resolves every named export before the first DOM-dependent module executes.
  check(`${entry} import graph links before needing the browser DOM`,linked.status===1 && /ReferenceError: document is not defined/.test(linked.stderr));
}
check('install identity, routes and orientation remain stable',manifest.id==='/'&&manifest.scope==='/'&&manifest.start_url==='/'&&manifest.orientation==='any');
check('Docker includes the entire static frontend',/COPY\s+web\/?\s/.test(readFileSync(new URL('../Dockerfile',import.meta.url),'utf8')));
console.log(`${count}/${count} shell and delivery checks passed`);
