import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAgent, readAgent } from '../src/state';
import { queueAppendForAgent, queueAppendOnce, queueDepth, queueHead } from '../src/queue';
import { queueTrackedMessage } from '../src/messages';
import { sendCommand } from '../src/commands/send';
import { deliverNext } from '../src/deliver';
import { newMsgId } from '../src/msgid';
import { startApiServer } from '../src/server';

let home: string;
let saved: NodeJS.ProcessEnv;
let spawnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved={...process.env};home=mkdtempSync(join(tmpdir(),'am-agy-queue-'));
  process.env.HOME=home;process.env.AGENTMGR_HOME=join(home,'state');
  process.env.PATH=home+':'+process.env.PATH;
  writeFileSync(join(home,'tmux'),'#!/bin/sh\nexit 0\n');chmodSync(join(home,'tmux'),0o700);
  const spawn=Bun.spawnSync;
  spawnSpy=spyOn(Bun,'spawnSync').mockImplementation((cmd:any,opts?:any)=>spawn(cmd,{...opts,env:{...process.env,...opts?.env}}));
  writeAgent({name:'api',provider:'antigravity',status:'working',dir:home,tmuxSession:'fixture',createdAt:'fixture',updatedAt:'fixture'});
});
afterEach(()=>{spawnSpy.mockRestore();process.env=saved;rmSync(home,{recursive:true,force:true});});
const oversized='x'.repeat(70*1024);

test('oversized attributed sends fail before enqueue, then a valid send succeeds',async()=>{
  await expect(sendCommand('api',oversized,{now:false,quiet:true,track:true})).rejects.toThrow(/64 KiB/);
  expect(queueDepth('api')).toBe(0);
  await sendCommand('api','valid',{now:false,quiet:true});
  expect(queueDepth('api')).toBe(1);expect(queueHead('api')?.message).toBe('valid');
});
test('the limit includes attributed envelope bytes and Unicode byte lengths',async()=>{
  await expect(sendCommand('api','x'.repeat(64*1024),{now:false,quiet:true,from:'peer'})).rejects.toThrow(/64 KiB/);
  expect(()=>queueAppendForAgent('api','😀'.repeat(17000))).toThrow(/64 KiB/);
  expect(queueDepth('api')).toBe(0);
});
test('queue producers and tracked receipts enforce the same provider limit',()=>{
  expect(()=>queueAppendForAgent('api',oversized)).toThrow(/64 KiB/);
  expect(()=>queueAppendOnce('api',oversized,newMsgId())).toThrow(/64 KiB/);
  expect(()=>queueTrackedMessage('api',oversized)).toThrow(/64 KiB/);
  expect(queueDepth('api')).toBe(0);
  const agent=readAgent('api')!;agent.provider='codex';writeAgent(agent);
  expect(()=>queueAppendForAgent('api',oversized)).not.toThrow();
});
test('API refuses an oversized send rather than returning a successful queued receipt',async()=>{
  const server=startApiServer({port:0,hostname:'127.0.0.1',token:'fixture-token'});
  try {
    const response=await fetch(server.url+'/api/agents/api/messages',{method:'POST',headers:{Authorization:'Bearer fixture-token','content-type':'application/json'},body:JSON.stringify({text:oversized})});
    expect(response.ok).toBe(false);expect(await response.text()).toMatch(/64 KiB/);expect(queueDepth('api')).toBe(0);
  } finally {server.stop();}
});
test('an already-invalid queue head becomes explicit attention with a recovery instruction',async()=>{
  const id=newMsgId()+'.json';const queue=join(home,'state','queue','api');mkdirSync(queue,{recursive:true});
  writeFileSync(join(queue,id),JSON.stringify({message:oversized,queuedAt:new Date().toISOString()}));
  const result=await deliverNext('api');
  expect(result).toEqual({status:'queued',reason:'invalid'});
  expect(readAgent('api')?.status).toBe('needs-attention');
  expect(readAgent('api')?.statusReason).toMatch(/64 KiB.*queue --clear/);
  expect(queueDepth('api')).toBe(1);
});
