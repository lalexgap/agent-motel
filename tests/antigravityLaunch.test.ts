import { newCommand } from "../src/commands/new";
import { restartAgent } from "../src/commands/restart";
import { restoreCommand } from "../src/commands/restore";
import { trashState } from "../src/trash";
import { queueAppendForAgent, queueDepth, queuePeek } from '../src/queue';
import { removeAgent } from "../src/state";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityCommand, reserveAntigravityLaunch, stopAntigravity, antigravityRequest } from '../src/antigravity';
import { readAgent, writeAgent, type AgentState } from '../src/state';
import { reviveAgent } from '../src/commands/resume';
import { stopAgent, destroyAgent } from '../src/commands/rm';
import * as tmux from '../src/tmux';
import * as daemon from '../src/daemon';

let home:string;
let env:NodeJS.ProcessEnv;
let spies:ReturnType<typeof spyOn>[];
const children:ReturnType<typeof Bun.spawn>[]=[];
const wait=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await Bun.sleep(10);}throw new Error('launch fixture timed out');};
const state=(extra:Partial<AgentState>={}):AgentState=>({name:'launch-race',provider:'antigravity',status:'exited',dir:home,tmuxSession:'fixture-no-pane',createdAt:'fixture-incarnation',updatedAt:'fixture-incarnation',model:'gemini-4-argon-high',sessionId:'fixture-session',...extra});
const capture=():any[]=>{try{return readFileSync(join(home,'capture'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
beforeEach(()=>{
 env={...process.env};home=mkdtempSync(join(tmpdir(),'am-agy-launch-'));mkdirSync(join(home,'bin'));
 writeFileSync(join(home,'bin','agy'),'#!'+process.execPath+'\n'+readFileSync(new URL('./fixtures/antigravity/agy.cjs',import.meta.url),'utf8'));chmodSync(join(home,'bin','agy'),0o700);
 Object.assign(process.env,{HOME:home,AGENTMGR_HOME:join(home,'state'),PATH:join(home,'bin'),AGY_FIXTURE_MODE:'normal',AGY_FIXTURE_CAPTURE:join(home,'capture'),AGY_FIXTURE_HEARTBEAT:join(home,'heartbeat')});
 spies=[spyOn(tmux,'hasSession').mockReturnValue(false),spyOn(tmux,'newSession').mockImplementation(()=>{}),spyOn(daemon,'ensureDaemon').mockResolvedValue(true)];
});
afterEach(async()=>{
 for(const child of children.splice(0)){child.kill('SIGTERM');await child.exited;}
 // Only groups actually created by this credential-free fixture are touched.
 for(const record of capture())if(record.ownedRoot){try{process.kill(-record.ownedRoot,'SIGKILL');}catch{}}
 for(const spy of spies)spy.mockRestore();process.env=env;rmSync(home,{recursive:true,force:true});
});
async function fixture(){
 process.env.AGY_FIXTURE_MODE='group-normal';
 const plan=antigravityCommand('launch-race',{});
 if(!acquireLifecycleLock('launch-race'))throw new Error('fixture lifecycle busy');
 try{reserveAntigravityLaunch(state({status:'starting'}),plan,true);}finally{releaseLifecycleLock('launch-race');}
 const child=Bun.spawn(plan.command,{env:{...process.env},stdin:'pipe',stdout:'pipe',stderr:'pipe'});children.push(child);
 await wait(()=>readAgent('launch-race')?.status==='idle' && capture().some(x=>x.heartbeat && existsSync(x.heartbeat)));return child;
}

test('SEC1/F4 SIGKILL owner death refuses resume and retains the exact unverified identity',async()=>{
 const child=await fixture();const before=readAgent('launch-race')!;const worker=capture().find(x=>x.heartbeat);
 child.kill('SIGKILL');await child.exited;
 const writes=readFileSync(worker.heartbeat,'utf8');await Bun.sleep(40);expect(readFileSync(worker.heartbeat,'utf8').length).toBeGreaterThan(writes.length);
 await expect(reviveAgent(before,{message:'must not replace'})).rejects.toThrow(/cleanup|unverified|refus/i);
 expect(readAgent(before.name)).toEqual(before);
 expect(tmux.newSession).not.toHaveBeenCalled();
});

for(const action of ['stop','remove'] as const)test('SEC1 relaunch migrates cleaned legacy runner to native TUI and supports '+action,async()=>{
 const old='a'.repeat(32);writeAgent(state({antigravityRunId:old,antigravityCleanupRunId:old}));
 await reviveAgent(readAgent('launch-race')!);
 const pending=readAgent('launch-race')!;
 expect(pending.antigravityRunId).toBeUndefined();
 expect(pending.antigravityCleanupRunId).toBeUndefined();
 if(action==='stop')stopAgent(pending);else destroyAgent(pending,{clean:false});
 const current=readAgent('launch-race');
 if(action==='stop'){expect(current?.status).toBe('exited');}
 else expect(current).toBeNull();
});


function start(command:string[]){const child=Bun.spawn(command,{env:{...process.env},stdin:'pipe',stdout:'pipe',stderr:'pipe'});children.push(child);return child;}
function initialPlan(){
 const plan=antigravityCommand('launch-race',{});
 if(!acquireLifecycleLock('launch-race'))throw new Error('fixture lifecycle busy');
 try{reserveAntigravityLaunch(state({status:'starting'}),plan,true);}finally{releaseLifecycleLock('launch-race');}return plan;
}
function nativeCommands(){return capture().filter(x=>x.args?.includes('--input-format'));}
function rawLaunch(command:string[]){return command.slice(command.indexOf(process.execPath));}
function waitSync(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;Bun.sleepSync(10);}throw new Error('synchronous fixture handshake timed out');}

test('SEC1 direct unreserved runner cannot claim state or launch a provider',async()=>{
 writeAgent(state());const before=readAgent('launch-race');
 const child=start(antigravityCommand('launch-race',{}).command);
 expect(await child.exited).not.toBe(0);expect(readAgent('launch-race')).toEqual(before);expect(nativeCommands()).toEqual([]);
});

test('SEC1 stale incarnation cannot claim a pending generation',async()=>{
 const plan=initialPlan();const binding=JSON.parse(plan.command[4]!);plan.command[4]=JSON.stringify({...binding,createdAt:'different-incarnation'});
 const before=readAgent('launch-race');expect(await start(plan.command).exited).not.toBe(0);
 expect(readAgent('launch-race')).toEqual(before);expect(nativeCommands()).toEqual([]);
});

test('SEC1 cancelled generation cannot start late or overwrite a newer reservation',async()=>{
 const first=initialPlan();stopAgent(readAgent('launch-race')!);
 const next=antigravityCommand('launch-race',{});
 expect(acquireLifecycleLock('launch-race')).toBe(true);
 try{reserveAntigravityLaunch(readAgent('launch-race')!,next);}finally{releaseLifecycleLock('launch-race');}
 const pending=readAgent('launch-race');expect(await start(first.command).exited).not.toBe(0);
 expect(readAgent('launch-race')).toEqual(pending);expect(nativeCommands()).toEqual([]);
 const child=start(next.command);await wait(()=>readAgent('launch-race')?.status==='idle');stopAntigravity(readAgent('launch-race')!);await child.exited;
});

test('SEC1 simultaneous duplicate runners can claim only once and loser cannot clean or unlink the winner',async()=>{
 const plan=initialPlan();const first=start(plan.command);const second=start(plan.command);
 await wait(()=>readAgent('launch-race')?.status==='idle');
 await wait(()=>first.exitCode!==null || second.exitCode!==null);
 const current=readAgent('launch-race')!;expect(current.antigravityRunPhase).toBe('claimed');expect(current.antigravityCleanupRunId).toBeUndefined();
 expect(nativeCommands().length).toBe(1);
 expect((await antigravityRequest(current,'deliver',{id:'winner.json',message:'only winner'})).outcome).toBe('delivered');
 stopAntigravity(readAgent('launch-race')!);await Promise.all([first.exited,second.exited]);
});

test('SEC1/F4 restore revival also refuses unverified owner death',async()=>{
 const child=await fixture();const before=readAgent('launch-race')!;child.kill('SIGKILL');await child.exited;
 trashState(before);removeAgent(before.name);
 await expect(restoreCommand(before.name)).rejects.toThrow(/cleanup|unverified|refus/i);
 expect(readAgent(before.name)?.antigravityRunId).toBe(before.antigravityRunId);expect(readAgent(before.name)?.antigravityCleanupRunId).toBeUndefined();expect(tmux.newSession).not.toHaveBeenCalled();
});

test('SEC1 resume lifecycle lock rejects concurrent process stop during reservation handoff',async()=>{
 const old='b'.repeat(32);writeAgent(state({antigravityRunId:old,antigravityCleanupRunId:old}));
 (tmux.newSession as any).mockImplementation(()=>{
   const pending=readAgent('launch-race')!;expect(pending.antigravityRunId).toBeUndefined();expect(pending.antigravityCleanupRunId).toBeUndefined();
   const competitor=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/index.ts'),'stop','launch-race'],{env:{...process.env},stdin:'ignore',stdout:'pipe',stderr:'pipe',timeout:2000});
   expect(competitor.exitCode).not.toBe(0);expect(competitor.stderr.toString()).toMatch(/stopped|restarted|retry|busy/);
   expect(readAgent('launch-race')).toEqual(pending);
 });
 await reviveAgent(readAgent('launch-race')!);stopAgent(readAgent('launch-race')!);
});

for(const operation of ['resume','restart'] as const)test('SEC1 failed '+operation+' marks agent exited cleanly',async()=>{
 const old='c'.repeat(32);writeAgent(state({antigravityRunId:old,antigravityCleanupRunId:old}));
 (tmux.newSession as any).mockImplementation(()=>{throw new Error('fixture tmux launch failure');});
 const action=operation==='resume'?reviveAgent(readAgent('launch-race')!):restartAgent('launch-race');
 await expect(action).rejects.toThrow(/fixture tmux/);
 const failed=readAgent('launch-race')!;expect(failed.antigravityRunId).toBeUndefined();expect(failed.status).toBe('exited');
});

test('SEC1 failed new launch removes unstarted state',async()=>{
 (tmux.newSession as any).mockImplementation(()=>{
   const pending=readAgent('launch-race')!;expect(pending.status).toBe('starting');
   throw new Error('fixture tmux launch failure');
 });
 await expect(newCommand({name:'launch-race',provider:'antigravity',dir:home,inPlace:true,jump:false,quiet:true})).rejects.toThrow(/fixture tmux/);
 expect(readAgent('launch-race')).toBeNull();
});

test('SEC1 restore holds one lifecycle lock through registration and revived launch',async()=>{
 const old='d'.repeat(32);trashState(state({antigravityRunId:old,antigravityCleanupRunId:old}));
 (tmux.newSession as any).mockImplementation(()=>{
   const pending=readAgent('launch-race')!;expect(pending.antigravityRunId).toBeUndefined();expect(pending.status).toBe('starting');
   expect(()=>stopAgent(pending)).toThrow(/retry|busy/);expect(()=>destroyAgent(pending,{clean:false})).toThrow(/retry|busy/);
 });
 await restoreCommand('launch-race');stopAgent(readAgent('launch-race')!);
});
