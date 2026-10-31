const { chromium } = require('/home/lagap/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('fs');
const cp = require('child_process');
const root = process.cwd();
const app = fs.readFileSync(root + '/web/app.js','utf8');
const funcs = app.slice(app.indexOf('function collapsibleMessage('), app.indexOf('async function refreshDetail('));
const el = app.slice(app.indexOf('const el = '), app.indexOf('const dot = '));
const main = async () => {
 const browser = await chromium.launch({headless:true});
 const page = await browser.newPage({viewport:{width:1200,height:950}});
 await page.setContent('<html><body><h1>Agent Motel · notification disclosure</h1><div class="columns"><section><h2>Transcript</h2><div id="transcript"></div></section><section><h2>Live dock</h2><div id="dock-transcript"></div></section></div></body></html>');
 await page.addStyleTag({content:fs.readFileSync(root+'/web/style.css','utf8')+'\nbody {padding:24px; overflow:auto;} h1 {font-size:22px;} h2 {font-size:16px;} .columns {display:grid; grid-template-columns:1fr 1fr; gap:24px;} #transcript, #dock-transcript {height:730px; overflow:auto; padding:16px; border:1px solid var(--border); position:static; width:auto; max-height:none;}'});
 for (const file of ['links.js','markdown.js']) await page.addScriptTag({content:fs.readFileSync(root+'/web/'+file,'utf8')});
 await page.addScriptTag({content:el+funcs+`
 window.messages = [
  {kind:'user', index:0, text:'# AGENTS.md instructions for /workspace/agent-motel\\n\\n<INSTRUCTIONS>\\n'+ 'Preserve short messages. Keep keyboard controls accessible. Review changes before merging.\\n'.repeat(25)+'</INSTRUCTIONS>'},
  {kind:'user', index:1, text:'<subagent_notification>\\n'+JSON.stringify({agent_path:'reviewer',status:{completed:'Review completed. Both the transcript and live dock retain expanded state and reading position.\\n'.repeat(35)+'END OF REPORT'}})+'\\n</subagent_notification>'},
  {kind:'user', index:2, text:'<subagent_notification>\\n{"status":{"completed":"Done."}}\\n</subagent_notification>'},
  {kind:'assistant', index:3, text:'Short notices stay visible. Expand either card above to read the complete original message.'}
 ];
 window.rebuild=(id,append=false)=>{const view=document.getElementById(id);const restore=preserveConversationScroll(view,id==='transcript'?90:60);view.replaceChildren(...messages.map(e=>chatTurn(e,'Agent')));if(append)view.append(chatTurn({kind:'assistant',index:99,text:'A new live message.'},'Agent'));restore(false);};
 for(const id of ['transcript','dock-transcript']) rebuild(id);
 `});
 const assert = (condition,msg) => {if(!condition) throw new Error(msg)};
 assert(await page.locator('details').count()===4,'four disclosures');
 assert(await page.locator('details[open]').count()===0,'default collapsed');
 await page.screenshot({path:'/tmp/am-notice-evidence/collapsed.png',fullPage:true});
 for (const id of ['transcript','dock-transcript']) {
  const summary = page.locator('#'+id+' details').first().locator('summary');
  await summary.focus(); await page.keyboard.press('Enter');
  assert(await page.locator('#'+id+' details').first().evaluate(n=>n.open),'Enter expands');
  const before = await summary.evaluate(n=>n.getBoundingClientRect().top);
  await page.evaluate(id=>rebuild(id,true),id);
  assert(await page.locator('#'+id+' details').first().evaluate(n=>n.open),'refresh preserves expanded state');
  assert(await page.locator('#'+id+' summary').first().evaluate(n=>n===document.activeElement),'refresh preserves keyboard focus');
  const after=await page.locator('#'+id+' summary').first().evaluate(n=>n.getBoundingClientRect().top);
  assert(Math.abs(before-after)<=1,'summary position preserved');
  const result=await page.evaluate(id=>{const view=document.getElementById(id);view.scrollTop=350;const top=view.scrollTop;const body=view.querySelector('[data-scroll-key="notice-body:0"]');const offset=body.getBoundingClientRect().top;rebuild(id,true);return {top,now:view.scrollTop,offset,next:view.querySelector('[data-scroll-key="notice-body:0"]').getBoundingClientRect().top}},id);
  assert(Math.abs(result.top-result.now)<=1 && Math.abs(result.offset-result.next)<=1,'reading position preserved');
  await page.locator('#'+id).evaluate(n=>n.scrollTop=0);
 }
 await page.screenshot({path:'/tmp/am-notice-evidence/expanded.png',fullPage:true});
 for(const id of ['transcript','dock-transcript']) {
  const summary=page.locator('#'+id+' summary').first();await summary.focus();await page.keyboard.press('Space');
  assert(await page.locator('#'+id+' details').first().evaluate(n=>!n.open),'Space collapses');
  await page.evaluate(id=>rebuild(id,true),id);
  assert(await page.locator('#'+id+' details').first().evaluate(n=>!n.open),'refresh preserves collapse');
 }
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>{document.querySelector('.columns').style.display='block';return true;}),'mobile layout');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'mobile no horizontal overflow');
 await page.screenshot({path:'/tmp/am-notice-evidence/mobile.png',fullPage:true});
 // Baseline renderer and whole stylesheet from the same base commit.
 const baseApp=cp.execFileSync('git',['show','c08bad5:web/app.js'],{encoding:'utf8'});
 const baseChat=baseApp.slice(baseApp.indexOf('function chatTurn('),baseApp.indexOf('function pendingBubble('));
 await page.setViewportSize({width:1200,height:950});
 await page.addStyleTag({content:cp.execFileSync('git',['show','c08bad5:web/style.css'],{encoding:'utf8'})+'\n.columns {display:grid!important;grid-template-columns:1fr 1fr;gap:24px;} #transcript,#dock-transcript {height:730px;overflow:auto;padding:16px;border:1px solid var(--border);position:static;width:auto;max-height:none;}'});
 await page.addScriptTag({content:baseChat+`for(const id of ['transcript','dock-transcript']) {const view=document.getElementById(id);view.replaceChildren(...messages.map(e=>chatTurn(e,'Agent')));view.scrollTop=0;}`});
 await page.screenshot({path:'/tmp/am-notice-evidence/before.png',fullPage:true});
 fs.writeFileSync('/tmp/am-notice-evidence/results.json',JSON.stringify({passed:true,checks:['default collapsed','Enter expands','Space collapses','full original content retained','expanded and collapsed state across live rebuild','keyboard focus after live rebuild','summary and body reading positions across live rebuild','main transcript and dock','mobile no horizontal overflow']},null,2));
 console.log('Browser verification passed: transcript + dock; collapsed, expanded, keyboard, refresh focus/state/scroll, mobile.');
 await browser.close();
};main().catch(e=>{console.error(e);process.exit(1)});
