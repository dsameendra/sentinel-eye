// Run from the browser skill's persistent Node runtime with its documented tab/viewport APIs.
// No driver, CDP connection, app internals or real recorder writes are used here.
export const profiles = [
  {width:375,height:667,pwa:true}, {width:390,height:844,pwa:true},
  {width:844,height:390,pwa:true}, {width:768,height:1024,pwa:true},
  {width:1180,height:820,pwa:true}, {width:1440,height:900},
  {width:1280,height:720,tv:true}, {width:1920,height:1080,tv:true},
  {width:320,height:568,pwa:true}, {width:667,height:375,pwa:true},
  {width:932,height:430,pwa:true}, {width:820,height:1180,pwa:true},
  {width:1024,height:768,pwa:true}, {width:1366,height:1024,pwa:true},
  {width:1920,height:1080}, {width:2560,height:1080}, {width:800,height:450},
];
const routes = ['live','playback','events','settings','settings/connection','settings/channels',
  'settings/display','settings/overview','settings/enhancement','settings/status',
  'settings/security','settings/account','account'];
const headings = {'settings/connection':'Recorder connection','settings/channels':'Cameras & channels',
  'settings/display':'Display & layout','settings/overview':'Channel-zero overview',
  'settings/enhancement':'Enhancement','settings/status':'Status'};
async function navigate(tab,url) { if (await tab.url()===url) await tab.reload(); else await tab.goto(url); }
export function query(profile, theme) {
  const q = new URLSearchParams({theme,capture:'1'});
  if (profile.pwa) { q.set('pwa','1'); q.set('top',profile.width>profile.height ? '0':profile.width<=640?'59':'24'); q.set('bottom','86'); }
  if (profile.tv) { q.set('tv','1'); q.set('device','1'); }
  return q;
}
export async function runRoutes(tab, viewport, profile, origin='http://127.0.0.1:8083') {
  await viewport.set({width:profile.width,height:profile.height});
  const results=[];
  for (const theme of ['dark','light']) {
    const base = `${origin}/?${query(profile,theme)}`;
    for (const route of routes) {
      await navigate(tab,`${base}#/${route}`);
      await tab.playwright.locator('#view .appbar').waitFor({state:'visible',timeoutMs:10000});
      if (headings[route]) await tab.playwright.getByRole('heading',{name:headings[route],exact:true}).waitFor({state:'visible',timeoutMs:10000});
      // A DOM snapshot lets the just-requested hash route finish before measuring the rendered view.
      await tab.playwright.domSnapshot();
      const check=await tab.playwright.evaluate(()=>{
        const bar=document.querySelector('#view .appbar');
        const clipped=[];
        for (const el of bar.querySelectorAll('button,a,input,select')) {
          const box=el.getBoundingClientRect(), s=getComputedStyle(el);
          if (!box.width || !box.height || s.visibility==='hidden' || s.display==='none' || el.closest('[hidden],[inert]')) continue;
          if (box.left<-.5 || box.right>innerWidth+.5 || box.top<-.5 || box.bottom>innerHeight+.5) clipped.push(el.getAttribute('aria-label')||el.textContent.trim());
        }
        return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,
          hash:location.hash,barHeight:bar.getBoundingClientRect().height,
          overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),clipped,
          errors:[...document.querySelectorAll('#preview-error')].map(e=>e.textContent)};
      });
      results.push({profile,expectedTheme:theme,route,...check});
      const routeMatches=check.hash===`#/${route}` || route==='playback' && check.hash.startsWith('#/playback/');
      if (check.width!==profile.width || check.height!==profile.height || check.theme!==theme || !routeMatches || check.overflow>.5 || check.clipped.length || check.errors.length) throw new Error(JSON.stringify(results.at(-1)));
    }
  }
  return results;
}
export async function runEntries(tab,viewport,profile,origin='http://127.0.0.1:8083') {
  await viewport.set({width:profile.width,height:profile.height});
  const results=[];
  for (const theme of ['dark','light']) for (const route of ['login','pair']) {
    await navigate(tab,`${origin}/${route}?${query(profile,theme)}`);
    await tab.playwright.locator('.auth-card button').first().waitFor({state:'visible',timeoutMs:10000});
    const check=await tab.playwright.evaluate(()=>{
      const card=document.querySelector('.auth-card'),box=card.getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,
        cardTop:box.top,cardWidth:box.width,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
        errors:[...document.querySelectorAll('#preview-error')].map(e=>e.textContent),
        pairing:!!card.querySelector('.pair-code'),inputs:card.querySelectorAll('input').length,buttons:card.querySelectorAll('button').length};
    });
    results.push({profile,expectedTheme:theme,route,...check});
    if (check.width!==profile.width || check.height!==profile.height || check.theme!==theme || check.cardTop<0 || check.overflow>.5 || !(check.inputs||check.pairing) || !check.buttons || check.errors.length) throw new Error(JSON.stringify(results.at(-1)));
  }
  return results;
}
export async function runCameraTools(tab,viewport,profile,origin='http://127.0.0.1:8083') {
  await viewport.set({width:profile.width,height:profile.height});
  const results=[];
  for (const theme of ['dark','light']) {
    const q=query(profile,theme); q.set('signed','1');
    if (profile.tv) q.set('overview','1');
    await navigate(tab,`${origin}/?${q}#/live`);
    await tab.playwright.locator('.tile').first().waitFor({state:'visible',timeoutMs:10000});
    const point=await tab.playwright.evaluate(()=>{const r=document.querySelector('.tile').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await tab.cua.move(point);
    await tab.playwright.getByRole('button',{name:'More camera controls',exact:true}).first().click();
    const check=await tab.playwright.evaluate(()=>{
      const menu=document.querySelector('.popover-portal'),r=menu.getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,
        scoped:document.querySelector('#app').hasAttribute('inert'),
        items:[...menu.querySelectorAll('button')].map(b=>b.textContent.trim()),
        snapshotDisabled:menu.querySelector('[data-tool=snap]').disabled,
        errors:[...document.querySelectorAll('#preview-error')].map(e=>e.textContent)};
    });
    if (check.left<-.5 || check.right>profile.width+.5 || check.top<0 || check.bottom>profile.height+.5 || !check.scoped || !check.snapshotDisabled || !check.items.includes('Picture adjustments') || check.errors.length) throw new Error(JSON.stringify(check));
    await tab.cua.keypress({keys:['ESC']});
    results.push({profile,theme,...check});
  }
  return results;
}
