import type { Page } from '@playwright/test';

/** A provider page with its own fixture-only UI and policy, served without an external service. */
export async function installFrames(page: Page) {
  await page.route(/^https:\/\/(canvas|form)\.test\//, async route => {
    const url = new URL(route.request().url());
    const dark = url.searchParams.get('theme') === 'dark';
    const dir = url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr';
    const parent = url.searchParams.get('parent') || new URL(page.url()).origin;
    await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors ${parent}` }, body: `<!doctype html><html dir="${dir}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px;box-sizing:border-box;font:16px system-ui;background:${dark ? '#172033' : '#fff'};color:${dark ? '#fff' : '#172033'}"><h1>Example external page</h1><label>Example input<input aria-label="Example input" style="display:block;box-sizing:border-box;width:100%;padding:12px;font:inherit"></label><p id="echo" role="status">Waiting for input</p><button id="approve" style="min-height:44px;padding:12px">Allow leaving</button><button id="navigate" style="min-height:44px;padding:12px">Navigate frame</button><script>
let binding=null;const parentOrigin=${JSON.stringify(parent)};
for(const type of ['pointerdown','pointerup','click'])addEventListener(type,e=>{document.body.dataset[type]=e.target.id||e.target.tagName;},true);
function send(payload){if(binding)parent.postMessage({source:'bulwark-embedded-view',...binding,payload},parentOrigin);}
addEventListener('message',e=>{if(e.source!==parent||e.origin!==parentOrigin||e.data?.source!=='bulwark-embedded-host')return;if(e.data.type==='init'){binding={id:e.data.id,channel:e.data.channel};document.body.dataset.bound='true';}if(!binding||e.data.id!==binding.id||e.data.channel!==binding.channel)return;if(e.data.payload?.type==='echo')document.getElementById('echo').textContent='Echo: '+e.data.payload.value;if(e.data.payload?.type==='approved')document.body.dataset.approved='true';});
document.querySelector('input').addEventListener('input',e=>send({type:'input',value:e.target.value}));
document.getElementById('approve').onclick=()=>{document.body.dataset.approvalClicks=String(Number(document.body.dataset.approvalClicks||0)+1);send({type:'approve'});};
document.getElementById('navigate').onclick=()=>location.assign('/workspace/next?'+location.search.slice(1));
</script></body></html>` });
  });
}

function recordFrameViolations() {
    (window as unknown as { __frameViolations: string[] }).__frameViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'frame-src') (window as unknown as { __frameViolations: string[] }).__frameViolations.push(event.blockedURI);
    });
}
export async function observeCsp(page: Page) { await page.addInitScript(recordFrameViolations); }
export async function armCsp(page: Page) { await page.evaluate(recordFrameViolations); }
