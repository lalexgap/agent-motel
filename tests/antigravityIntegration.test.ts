import { restoreCommand } from "../src/commands/restore";
import { locateTranscript } from "../src/transcript";
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAgent, writeAgent } from '../src/state';
import { queueAppendForAgent, queueDepth } from '../src/queue';
import { newCommand } from '../src/commands/new';
import { reviveAgent } from '../src/commands/resume';
import { restartAgent } from '../src/commands/restart';
import { stopAgent, destroyAgent } from '../src/commands/rm';
import { sendCommand } from '../src/commands/send';
import { startDaemonServer } from '../src/daemon';
import { shQuote } from '../src/tmux';
import { exportSubagentRoles } from '../src/subagentRoles';
import { handoffAgent } from '../src/commands/handoff';
import { renameAgent } from '../src/commands/rename';
import { cdAgent, sourceTranscript, importPayload, targetTranscriptPath } from '../src/commands/move';

let isolated: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = {...process.env};
  isolated = mkdtempSync(join(tmpdir(), 'am-agy-integration-'));
  process.env.HOME = isolated;
  process.env.CODEX_HOME = join(isolated, '.codex');
  process.env.AGENTMGR_HOME = join(isolated, 'state');
});
afterEach(() => { process.env = savedEnv; rmSync(isolated, {recursive:true,force:true}); });
function agyState(): AgentState {
  return {name:'argon-test',provider:'antigravity',dir:isolated,tmuxSession:'no-session',status:'idle',createdAt:'fixture',updatedAt:'fixture',sessionId:'exact-id'};
}
import { isProvider, providerBinary, type AgentState } from '../src/state';
import { buildLaunchCommand, buildResumeCommand, permissionArgs } from '../src/providers';
import { entryFragments, parseTranscript } from '../src/transcript';

describe('Antigravity provider integration', () => {
  test('canonical identity maps to agy without changing existing binaries', () => {
    expect(isProvider('antigravity')).toBe(true);
    expect(isProvider('agy')).toBe(false);
    expect(isProvider('unknown')).toBe(false);
    expect(providerBinary('antigravity')).toBe('agy');
    expect(providerBinary('claude')).toBe('claude');
    expect(providerBinary('codex')).toBe('codex');
  });
  test('launch uses native stream runner and maps global permission bypass', () => {
    const launch = buildLaunchCommand('antigravity', 'argon-test', {message:'hello'});
    expect(launch.command.join(' ')).toContain('antigravityRunner.ts');
    expect(launch.command.join(' ')).not.toContain('--dangerously');
    expect(permissionArgs('antigravity')).toEqual(['--dangerously-skip-permissions']);
  });
  test('resume never guesses latest when the saved conversation is missing', () => {
    const agent = {name:'argon-test',provider:'antigravity',dir:'/tmp',tmuxSession:'test',status:'exited',createdAt:'now',updatedAt:'now'} as AgentState;
    expect(() => buildResumeCommand('antigravity', agent, {})).toThrow(/conversation|session/i);
    agent.sessionId='specific-conversation';
    expect(buildResumeCommand('antigravity',agent,{}).command.join(' ')).toContain('specific-conversation');
    expect(() => buildLaunchCommand('antigravity','argon-test',{resume:true})).toThrow(/picker|id/i);
    expect(() => buildLaunchCommand('antigravity','argon-test',{remote:true})).toThrow(/unsupported/i);
  });
  test('AM-owned transcript renders without Claude or Codex parser fallthrough', () => {
    const entries=[{kind:'user',text:'hello',sessionId:'specific-conversation'},{kind:'assistant',text:'world',sessionId:'specific-conversation'}];
    const transcript=parseTranscript('antigravity',entries.map(x=>JSON.stringify(x)).join('\n'));
    expect(transcript.source).toBe('antigravity');
    expect(transcript.sessionId).toBe('specific-conversation');
    expect(transcript.turns).toEqual([{kind:'user',text:'hello'},{kind:'assistant',text:'world'}]);
    expect(entryFragments('antigravity',entries[0]!)).toEqual([{kind:'user',text:'hello'}]);
  });
});


test('unsupported operations fail before mutating agent state, exports or queue', async () => {
  const agent = agyState(); writeAgent(agent);
  queueAppendForAgent(agent.name, 'preserved');
  await expect(handoffAgent(agent.name, {})).rejects.toThrow(/unsupported/);
  await expect(renameAgent(agent.name, 'renamed')).rejects.toThrow(/unsupported/);
  await expect(cdAgent(agent.name, isolated, {inPlace:true,start:false})).rejects.toThrow(/unsupported/);
  expect(() => sourceTranscript(agent)).toThrow(/unsupported/);
  expect(() => targetTranscriptPath('antigravity', isolated, isolated, 'exact-id', null)).toThrow(/unsupported/);
  expect(() => importPayload(JSON.stringify({state:{...agent,name:'imported'}}))).toThrow(/unsupported/);
  expect(() => exportSubagentRoles({providers:['antigravity']})).toThrow(/unsupported/);
  expect(readAgent(agent.name)?.sessionId).toBe('exact-id');
  expect(readAgent('renamed')).toBeNull();
  expect(queueDepth(agent.name)).toBe(1);
});

test('existing provider hooks cannot mutate Antigravity state or drain its queue', async () => {
  const agent = agyState(); writeAgent(agent);
  queueAppendForAgent(agent.name, 'preserved');
  process.env.AGENTMGR_AGENT = agent.name;
  // Run the public hook process with bounded, explicit stdin.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/index.ts'), 'hook', 'stop'], {
    env:{...process.env}, stdin:'pipe',stdout:'pipe',stderr:'pipe',timeout:2000,
  });
  child.stdin.write(JSON.stringify({session_id:'forged-id'}));child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(readAgent(agent.name)?.sessionId).toBe('exact-id');
  expect(queueDepth(agent.name)).toBe(1);
});


test.skipIf(!Bun.which('tmux'))('isolated real tmux lifecycle launches, queues, resumes and restarts exact agy conversation', async () => {
  const tmux = Bun.which('tmux')!;
  const socket = `am-agy-lifecycle-${process.pid}-${Date.now()}`;
  const bin = join(isolated, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh
exec ${shQuote(tmux)} -L ${shQuote(socket)} "$@"
`);
  writeFileSync(join(bin, 'agy'), `#!${process.execPath}
` + readFileSync(new URL('./fixtures/antigravity/agy.cjs', import.meta.url), 'utf8'));
  chmodSync(join(bin, 'tmux'), 0o700); chmodSync(join(bin, 'agy'), 0o700);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.AGENTMGR_SYSTEMD = '0';
  process.env.AGY_FIXTURE_MODE = 'group-normal';
  process.env.AGY_FIXTURE_HEARTBEAT = join(isolated,'heartbeat');
  process.env.AGY_FIXTURE_CAPTURE = join(isolated, 'capture.jsonl');
  const spawnSync = Bun.spawnSync;
  const spawnSpy = spyOn(Bun, 'spawnSync').mockImplementation((command: any, opts?: any) => spawnSync(command, {...opts,env:{...process.env,...opts?.env}}));
  const daemon = startDaemonServer();
  const waitFor = async (check: () => boolean) => {
    for (let tries=0; tries<150; tries++) { if (check()) return; await Bun.sleep(20); }
    const pane=Bun.spawnSync([tmux,'-L',socket,'capture-pane','-p','-t','=agentmgr-argon-life:'],{env:{...process.env}}).stdout.toString();
    throw new Error(`lifecycle fixture timeout: ${JSON.stringify(readAgent('argon-life'))}; pane=${pane}`);
  };
  try {
    Bun.spawnSync([tmux,'-L',socket,'new-session','-d','-s','fixture-anchor','sleep 30'],{env:{...process.env}});
    Bun.spawnSync([tmux,'-L',socket,'set-environment','-g','PATH',process.env.PATH!],{env:{...process.env}});
    Bun.spawnSync([tmux,'-L',socket,'set-environment','-g','HOME',isolated],{env:{...process.env}});
    Bun.spawnSync([tmux,'-L',socket,'set-environment','-g','AGY_FIXTURE_CAPTURE',process.env.AGY_FIXTURE_CAPTURE!],{env:{...process.env}});
    for(const key of ['AGY_FIXTURE_MODE','AGY_FIXTURE_HEARTBEAT'])Bun.spawnSync([tmux,'-L',socket,'set-environment','-g',key,process.env[key]!],{env:{...process.env}});
    await newCommand({name:'argon-life',provider:'antigravity',message:'first task',dir:isolated,inPlace:true,jump:false,quiet:true});
    await waitFor(() => readAgent('argon-life')?.status === 'idle');
    const first = readAgent('argon-life')!;
    expect(first.model).toBe('gemini-4-argon-high');
    expect(first.sessionId).toBeTruthy();
    const sent = await sendCommand(first.name, 'second task', {now:false,quiet:true,track:true});
    expect(sent.id).toBeTruthy();
    await waitFor(() => queueDepth(first.name) === 0 && readAgent(first.name)?.status === 'idle');
    expect(parseTranscript('antigravity',readFileSync(readAgent(first.name)!.transcriptPath!,'utf8')).turns.filter(x=>x.kind==='user').map(x=>x.text)).toEqual(['first task','second task']);
    const roots=()=>readFileSync(process.env.AGY_FIXTURE_CAPTURE!,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(x=>x.heartbeat);
    const firstWorker=roots()[0];
    stopAgent(readAgent(first.name)!);
    const firstWrites=readFileSync(firstWorker.heartbeat,'utf8');await Bun.sleep(100);expect(readFileSync(firstWorker.heartbeat,'utf8')).toBe(firstWrites);
    expect(readAgent(first.name)?.status).toBe('exited');
    await reviveAgent(readAgent(first.name)!, {message:'third task'});
    await waitFor(() => readAgent(first.name)?.status === 'idle');
    expect(readAgent(first.name)?.sessionId).toBe(first.sessionId);
    const secondWorker=roots()[1];
    await restartAgent(first.name, {message:'fourth task',model:'gemini-4-argon-medium'});
    await waitFor(() => readAgent(first.name)?.status === 'idle');
    expect(readAgent(first.name)?.sessionId).toBe(first.sessionId);
    expect(readAgent(first.name)?.model).toBe('gemini-4-argon-medium');
    const secondWrites=readFileSync(secondWorker.heartbeat,'utf8');await Bun.sleep(100);expect(readFileSync(secondWorker.heartbeat,'utf8')).toBe(secondWrites);
    const captures = readFileSync(process.env.AGY_FIXTURE_CAPTURE!, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(captures.filter(x=>x.args?.includes('--input-format')).slice(1).every(x=>x.args.includes('--conversation') && x.args.includes(first.sessionId))).toBe(true);
    expect(captures.filter(x=>x.input).length).toBe(4);
    const last=readAgent(first.name)!;
    destroyAgent(last,{clean:false});expect(readAgent(first.name)).toBeNull();
    const thirdWorker=roots()[2];const thirdWrites=readFileSync(thirdWorker.heartbeat,'utf8');
    await Bun.sleep(100);expect(readFileSync(thirdWorker.heartbeat,'utf8')).toBe(thirdWrites);
    await restoreCommand(first.name,{resume:false});
    expect(locateTranscript(readAgent(first.name)!)).toBe(last.transcriptPath!);
    if(process.platform==='linux') for(const root of roots())for(const pid of [root.ownedRoot,root.ownedWorker,root.ownedRunner]) {
      await waitFor(()=>{try {const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return ['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!);}catch{return true;}});
    }
  } finally {
    try {const agent=readAgent('argon-life'); if(agent) stopAgent(agent);}
    finally {daemon.stop();Bun.spawnSync([tmux,'-L',socket,'kill-server'],{stdout:'ignore',stderr:'ignore'});spawnSpy.mockRestore();}
  }
}, 15000);
