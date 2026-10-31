import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { antigravityCommand, antigravityRequest, ANTIGRAVITY_DEFAULT_MODEL, antigravityTranscriptPath, antigravitySocketPath, antigravityDeliveryPath, stopAntigravity } from "../src/antigravity";
import { readMessage, queueTrackedMessage } from "../src/messages";
import { locateTranscript, parseTranscript } from "../src/transcript";
import { trashState, readTrashedState } from "../src/trash";
import { removeAgent } from "../src/state";
import { queueDepth, queueAppendLocked } from "../src/queue";
import { acquireDeliverLock, releaseDeliverLock } from "../src/deliver";
import { readAgent, writeAgent, type AgentState } from "../src/state";

let home: string;
let saved: NodeJS.ProcessEnv;
const processes: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  saved = {...process.env};
  home = mkdtempSync(join(tmpdir(), 'am-agy-'));
  process.env.HOME = home;
  process.env.AGENTMGR_HOME = join(home, 'state');
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home,'bin','agy'), '#!'+process.execPath+'\n'+readFileSync(new URL('./fixtures/antigravity/agy.cjs',import.meta.url),'utf8'));
  chmodSync(join(home,'bin','agy'),0o700);
  process.env.PATH = join(home,'bin');
  process.env.AGY_FIXTURE_CAPTURE = join(home,'capture.jsonl');
  process.env.AGY_FIXTURE_HEARTBEAT = join(home,'heartbeat');
  process.env.ANTIGRAVITY_STARTUP_TIMEOUT_MS = '700';
  process.env.ANTIGRAVITY_ACK_TIMEOUT_MS = '400';
  process.env.ANTIGRAVITY_REQUEST_TIMEOUT_MS = '900';
});
afterEach(async () => {
  for (const p of processes.splice(0)) { p.kill('SIGTERM'); await p.exited; }
  for(const record of capture()) if(record.ownedWorker) {try{process.kill(record.ownedWorker,'SIGKILL');}catch{}}
  process.env = saved;
  rmSync(home,{recursive:true,force:true});
});
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean, ms=2500) {
  const deadline=Date.now()+ms;
  while(!fn()) { if(Date.now()>deadline) throw new Error('fixture wait timed out: '+JSON.stringify(readAgent('api'))); await delay(10); }
}
function state(extra:Partial<AgentState>={}):AgentState {
  return {name:'api',provider:'antigravity' as AgentState['provider'],status:'starting',dir:home,tmuxSession:'fixture',createdAt:'fixture-created',updatedAt:'fixture-created',...extra};
}
async function launch(mode='normal',opts:Parameters<typeof antigravityCommand>[1]={}) {
  process.env.AGY_FIXTURE_MODE=mode;
  writeAgent(state());
  const p=Bun.spawn(antigravityCommand('api',opts).command,{env:{...process.env},cwd:home,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  processes.push(p);
  await until(()=>!!readAgent('api')?.antigravityRunId || readAgent('api')?.status==='exited');
  return p;
}
async function idle() {await until(()=>readAgent('api')?.status==='idle');}
function capture():any[] {try{return readFileSync(join(home,'capture.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}}
function transcript():any[] {try{return readFileSync(antigravityTranscriptPath('api'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}

test('command uses the absolute runner, pins a model, rejects unsupported selectors and remote',()=>{
  const plan=antigravityCommand('api',{});
  expect(plan.command[0]).toBe(process.execPath);
  expect(plan.command[1]).toMatch(/^\/.*\/antigravityRunner.ts$/);
  expect(JSON.parse(plan.command[3]!)).toEqual({model:ANTIGRAVITY_DEFAULT_MODEL});
  expect(ANTIGRAVITY_DEFAULT_MODEL).toBe('gemini-4-argon-high');
  for(const opts of [{resume:true},{remote:true},{resume:'exact',continue:true},{model:''}]) expect(()=>antigravityCommand('api',opts)).toThrow();
  expect(()=>antigravityCommand('../bad',{})).toThrow();
});

test('real process receives native flags and stdin; queue ack is single-flight across turns',async()=>{
  await launch('delayed-ack',{message:'initial task',effort:'high'});
  await idle();
  const args=capture()[0].args;
  expect(args).toEqual(['--input-format','stream-json','--output-format','stream-json','--model',ANTIGRAVITY_DEFAULT_MODEL,'--print-timeout','5m','--effort','high']);
  expect(args).not.toContain('-p');
  expect(args.some((a:string)=>a.includes('skip-permissions'))).toBe(false);
  const input=capture().find(x=>x.input).input;
  expect(input.event).toBe('user');
  expect(input.message.content).toContain('initial task');
  expect(input.message.content).toContain('approval relay');
  let settled=false;
  const first=antigravityRequest(readAgent('api')!,'deliver',{id:'one.json',message:'first queued'}).then(x=>{settled=true;return x;});
  await delay(40);
  expect(settled).toBe(false);
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'two.json',message:'second queued'})).outcome).toBe('pending');
  expect((await first).outcome).toBe('delivered');
  expect(readAgent('api')?.status).toBe('working');
  await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'two.json',message:'second queued'})).outcome).toBe('delivered');
  await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'one.json',message:'first queued'})).outcome).toBe('delivered');
  expect(capture().filter(x=>x.input).length).toBe(3);
  expect(transcript().filter(x=>x.kind==='user').map(x=>x.text).slice(1)).toEqual(['first queued','second queued']);
  expect(transcript().filter(x=>x.kind==='assistant').length).toBe(3);
  expect(statSync(antigravityTranscriptPath('api')).mode & 0o777).toBe(0o600);
});

test('resume pins exact conversation ID and stores only AM-owned transcript path',async()=>{
  await launch('normal',{resume:'exact-id',model:'custom-model',message:'resume task'});await idle();
  expect(capture()[0].args.slice(-2)).toEqual(['--conversation','exact-id']);
  expect(readAgent('api')?.sessionId).toBe('exact-id');
  expect(readAgent('api')?.transcriptPath).toBe(antigravityTranscriptPath('api'));
});

for(const mode of ['auth','crash','silent','malformed','oversized','wrong-model','missing-model','wrong-session','duplicate-init','foreign-step','missing-session','partial','unknown-storm']) {
  test('bounded failure: '+mode,async()=>{
    const p=await launch(mode,{message:'task',resume:mode==='wrong-session'?'expected':undefined});
    await until(()=>readAgent('api')?.status==='exited');
    await p.exited;
    expect(readAgent('api')?.statusReason).toBeTruthy();
    const output=await new Response(p.stderr).text();
    expect(output).not.toContain('super-secret-token');
    expect(output).not.toContain('token=hidden');
    if(mode==='wrong-model'||mode==='missing-model') expect(readAgent('api')?.statusReason).toMatch(/model/i);
    if(mode==='auth') expect(readAgent('api')?.statusReason).toMatch(/auth/i);
  });
}

test('unknown event is ignored without executing event text',async()=>{
  await launch('unknown',{message:'task'});await idle();
  expect(transcript().length).toBe(2);
});

test('crash after stdin write preserves unknown outcome across restart, never resends automatically',async()=>{
  const p=await launch('normal');await idle();
  // The fixture mode is fixed per process: restart a crash fixture without an initial prompt.
  p.kill();await p.exited;
  await launch('crash');await idle();
  const result=await antigravityRequest(readAgent('api')!,'deliver',{id:'uncertain.json',message:'only once'});
  expect(result.outcome).toBe('unknown');
  await until(()=>readAgent('api')?.status==='exited');
  await launch('normal');await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'uncertain.json',message:'only once'})).outcome).toBe('unknown');
  expect(capture().filter(x=>x.input?.message.content.includes('only once')).length).toBe(1);
});

test('missing user_input ack is unknown and stops the runner',async()=>{
  await launch('no-ack');await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'no-ack.json',message:'uncertain'})).outcome).toBe('unknown');
  await until(()=>readAgent('api')?.status==='exited');
});

test('operator draft blocks external input and survives until newline',async()=>{
  const p=await launch();await idle();
  p.stdin!.write('unfinished operator');await delay(40);
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'draft.json',message:'queued'})).outcome).toBe('pending');
  expect(capture().filter(x=>x.input).length).toBe(0);
  p.stdin!.write(' text\n');
  await until(()=>transcript().some(x=>x.text==='unfinished operator text'));await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'draft.json',message:'queued'})).outcome).toBe('delivered');
});

test('interrupt signals the child and holds queues even if the child survives',async()=>{
  const p=await launch('survive-interrupt');await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'work.json',message:'long work'})).outcome).toBe('delivered');
  expect((await antigravityRequest(readAgent('api')!,'interrupt')).outcome).toBe('interrupted');
  await until(()=>capture().some(x=>x.signal==='SIGINT'));
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'held.json',message:'hold'})).outcome).toBe('pending');
  expect(readAgent('api')?.status).toBe('needs-attention');
  p.kill();
});

test('interrupt that exits the child finalizes state',async()=>{
  const p=await launch('hang-turn');await idle();
  await antigravityRequest(readAgent('api')!,'deliver',{id:'work.json',message:'long work'});
  await antigravityRequest(readAgent('api')!,'interrupt');
  await until(()=>readAgent('api')?.status==='exited');await p.exited;
});

for(const mode of ['waiting','permission']) test(mode+' requires attention without an approval relay',async()=>{
  await launch(mode,{message:'task'});
  await until(()=>readAgent('api')?.status==='needs-attention');
  expect(readAgent('api')?.statusReason).toMatch(/approval|waiting|permission/i);
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'held.json',message:'hold'})).outcome).toBe('pending');
});

test('stale incarnation/nonce cannot send and old runner cannot mutate replacement',async()=>{
  await launch();await idle();
  const old=readAgent('api')!;
  expect((await antigravityRequest({...old,antigravityRunId:'0'.repeat(32)},'deliver',{id:'wrong.json',message:'never'})).outcome).toBe('unavailable');
  writeAgent(state({createdAt:'replacement',status:'starting'}));
  expect((await antigravityRequest(old,'deliver',{id:'wrong.json',message:'never'})).outcome).toBe('unavailable');
  await delay(180);
  expect(readAgent('api')?.createdAt).toBe('replacement');
  expect(readAgent('api')?.status).toBe('starting');
  expect(capture().filter(x=>x.input).length).toBe(0);
});

test('helper safely reports absent runner',async()=>{
  expect((await antigravityRequest(state(),'deliver',{id:'x',message:'hi'})).outcome).toBe('unavailable');
});


test('instant result cannot race tracked delivery, prompt association, or transcript receipt',async()=>{
  await launch('instant');await idle();
  const id=queueTrackedMessage('api','tracked message');
  expect(acquireDeliverLock('api')).toBe(true);
  try {
    expect((await antigravityRequest(readAgent('api')!,'deliver',{id:id+'.json',message:'tracked message'})).outcome).toBe('delivered');
  } finally { releaseDeliverLock('api'); }
  await idle();
  expect(queueDepth('api')).toBe(0);
  const receipt=readMessage('api',id)!;
  expect(receipt.state).toBe('done');
  expect(receipt.transcriptComplete).toBe(true);
  expect(transcript()[receipt.transcriptIndex!].text).toBe('tracked message');
  expect(transcript()[receipt.transcriptIndex!+1].kind).toBe('assistant');
});

test('control socket authenticates nonce/incarnation and accepts no arbitrary actions',async()=>{
  await launch();await idle();
  const agent=readAgent('api')!;
  const path=antigravitySocketPath(agent.antigravityRunId!);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(process.env.AGENTMGR_HOME!,'antigravity')).mode & 0o777).toBe(0o700);
  const request=(body:unknown):Promise<any>=>new Promise((resolve,reject)=>{
    const socket=connect(path,()=>socket.write(JSON.stringify(body)+'\n'));
    let buffer='';socket.on('data',chunk=>{buffer+=chunk; if(buffer.includes('\n')) {resolve(JSON.parse(buffer));socket.destroy();}});socket.on('error',reject);
  });
  expect((await request({runId:'0'.repeat(32),createdAt:agent.createdAt,action:'interrupt'})).outcome).toBe('unavailable');
  expect((await request({runId:agent.antigravityRunId,createdAt:agent.createdAt,action:'exec',pid:1,args:['danger']})).outcome).toBe('unavailable');
  expect(capture().some(x=>x.signal)).toBe(false);
});

test('unreadable operator input holds the queue',async()=>{
  const p=await launch();await idle();
  p.stdin!.end();await delay(40);
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'closed.json',message:'hold'})).outcome).toBe('pending');
});

for(const corrupt of ['{broken','null','{}']) test('corrupt in-flight evidence never authorizes a duplicate: '+corrupt,async()=>{
  await launch();await idle();
  writeFileSync(antigravityDeliveryPath('api','corrupt.json'),corrupt,{mode:0o600});
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:'corrupt.json',message:'must not submit'})).outcome).toBe('unknown');
  expect(capture().filter(x=>x.input).length).toBe(0);
});

test('missing executable exits with an actionable reason',async()=>{
  rmSync(join(home,'bin','agy'));
  const p=await launch();
  await until(()=>readAgent('api')?.status==='exited');await p.exited;
  expect(readAgent('api')?.statusReason).toMatch(/start agy|PATH|install/);
});

test('assistant response is visible in the operator terminal',async()=>{
  const p=await launch('normal',{message:'task'});await idle();p.kill();await p.exited;
  expect(await new Response(p.stdout).text()).toContain('hello 1');
});

for(const mode of ['flat','checkpoint']) test(mode+' output maintains bounded protocol compatibility',async()=>{
  await launch(mode,{message:'task'});await idle();
  expect(transcript().map(x=>x.kind)).toEqual(['user','assistant']);
});


test('operator input preserves split UTF-8 characters',async()=>{
  const p=await launch();await idle();
  const text=Buffer.from('operator 🛰️ text\n');
  const split=Buffer.from('operator ').length+1;
  p.stdin!.write(text.subarray(0,split));await delay(20);
  p.stdin!.write(text.subarray(split));
  await until(()=>transcript().some(x=>x.kind==='user'));await idle();
  expect(transcript()[0].text).toBe('operator 🛰️ text');
});


test('acknowledged delivery marker repairs a receipt and queue without submitting again',async()=>{
  const p=await launch('instant');await idle();
  const id=queueTrackedMessage('api','repair receipt');
  await antigravityRequest(readAgent('api')!,'deliver',{id:id+'.json',message:'repair receipt'});await idle();
  p.kill();await p.exited;
  const receiptFile=join(process.env.AGENTMGR_HOME!,'queue','api','.messages',id+'.json');
  const record=JSON.parse(readFileSync(receiptFile,'utf8'));
  // Model a crash between durable provider acknowledgement and receipt/pop.
  writeFileSync(receiptFile,JSON.stringify({...record,state:'queued',deliveredAt:null,doneAt:null,startedAt:undefined,handedAt:undefined}));
  queueAppendLocked('api','repair receipt',undefined,id+'.json');
  await launch('instant');await idle();
  expect((await antigravityRequest(readAgent('api')!,'deliver',{id:id+'.json',message:'repair receipt'})).outcome).toBe('delivered');
  expect(queueDepth('api')).toBe(0);
  expect(readMessage('api',id)?.state).toBe('done');
  expect(capture().filter(x=>x.input).length).toBe(1);
});

test('dangling transcript symlink fails closed without creating its target',async()=>{
  const transcript=antigravityTranscriptPath('api','fixture-created','fixture-session');
  mkdirSync(join(transcript,'..'),{recursive:true});
  const target=join(home,'must-not-create');symlinkSync(target,transcript);
  const p=await launch('normal',{message:'task'});
  await until(()=>readAgent('api')?.status==='exited');await p.exited;
  expect(existsSync(target)).toBe(false);
});

test('terminal output strips untrusted ANSI, OSC, and control bytes',async()=>{
  const p=await launch('terminal-controls',{message:'task'});await idle();p.kill();await p.exited;
  const output=await new Response(p.stdout).text();
  expect(output).toContain('visible');
  expect(output).not.toContain('\x1b');expect(output).not.toContain('\x07');
  expect(output).not.toContain('malicious-title');
});


for(const mode of ['wrong-model','missing-model','wrong-session']) for(const role of [false,true]) test('F2 rejected init receives zero user frames: '+mode+' role='+role,async()=>{
  const p=await launch(mode,{...(role?{role:'engineer',roleInstructions:'private role task'}:{message:'private initial task'}),...(mode==='wrong-session'?{resume:'expected'}:{})});
  await until(()=>readAgent('api')?.status==='exited');await p.exited;
  expect(capture().filter(x=>x.input)).toEqual([]);
});

test('F2 delayed init holds the initial task until exact validation',async()=>{
  await launch('delayed-init',{message:'held task'});
  await delay(80);expect(capture().filter(x=>x.input)).toEqual([]);
  await idle();expect(capture().filter(x=>x.input).length).toBe(1);
});

for(const mode of ['group-crash','group-silent','group-normal']) test('SEC1 owned grandchild stops before exited is reported: '+mode,async()=>{
  const p=await launch(mode,mode==='group-crash'?{message:'crash'}:{});
  await until(()=>capture().some(x=>x.heartbeat && existsSync(x.heartbeat)));
  const heartbeat=capture().find(x=>x.heartbeat).heartbeat;
  if(mode==='group-normal')p.kill('SIGTERM');
  await until(()=>readAgent('api')?.status==='exited',4000);await p.exited;
  const before=readFileSync(heartbeat,'utf8');await delay(100);
  expect(readFileSync(heartbeat,'utf8')).toBe(before);
});

test('SEC2/F1 replacement startup failure cannot read old task output and restore retains old namespace',async()=>{
  const p=await launch('normal',{message:'old task'});await idle();
  const old=readAgent('api')!;trashState(old);p.kill();await p.exited;removeAgent('api');
  const other=join(home,'other-project');mkdirSync(other);
  writeAgent(state({createdAt:'new-incarnation',dir:other}));
  expect(()=>locateTranscript(readAgent('api')!)).toThrow();
  process.env.AGY_FIXTURE_MODE='auth';
  const replacement=Bun.spawn(antigravityCommand('api',{}).command,{env:{...process.env},cwd:other,stdin:'pipe',stdout:'pipe',stderr:'pipe'});processes.push(replacement);
  await until(()=>readAgent('api')?.status==='exited');await replacement.exited;
  expect(()=>locateTranscript(readAgent('api')!)).toThrow();
  removeAgent('api');writeAgent(readTrashedState('api')!);
  expect(locateTranscript(readAgent('api')!)).toBe(old.transcriptPath!);
  expect(parseTranscript('antigravity',readFileSync(locateTranscript(readAgent('api')!),'utf8')).turns.some(t=>t.kind==='assistant')).toBe(true);
});


test('SEC1 synchronous stop waits for owned-group cleanup, persists evidence, and fails closed when evidence is missing',async()=>{
  const p=await launch('group-normal');await idle();
  await until(()=>capture().some(x=>x.heartbeat && existsSync(x.heartbeat)));
  const heartbeat=capture().find(x=>x.heartbeat).heartbeat;
  stopAntigravity(readAgent('api')!);
  const stopped=readAgent('api')!;
  expect(stopped.status).toBe('exited');expect(stopped.antigravityCleanupRunId).toBe(stopped.antigravityRunId);
  const before=readFileSync(heartbeat,'utf8');await delay(100);expect(readFileSync(heartbeat,'utf8')).toBe(before);
  await p.exited;
  expect(()=>stopAntigravity(stopped)).not.toThrow();
  writeAgent({...stopped,antigravityCleanupRunId:undefined});
  expect(()=>stopAntigravity(readAgent('api')!)).toThrow(/unverified|refused/);
});

test('SEC2/F1 readers reject a forged path or foreign conversation record',async()=>{
  await launch('normal',{message:'task'});await idle();
  const current=readAgent('api')!;
  expect(()=>locateTranscript({...current,sessionId:'foreign-session'})).toThrow();
  expect(()=>locateTranscript({...current,createdAt:'replacement-incarnation'})).toThrow();
  const text=readFileSync(current.transcriptPath!,'utf8');
  writeFileSync(current.transcriptPath!,text+JSON.stringify({kind:'assistant',text:'foreign result',sessionId:'foreign',createdAt:current.createdAt})+'\n');
  expect(()=>locateTranscript(current)).toThrow(/provenance/);
});
