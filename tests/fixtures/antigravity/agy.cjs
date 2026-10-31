const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.AGY_FIXTURE_MODE || 'normal';
const args = process.argv.slice(2);
const capture = (x) => fs.appendFileSync(process.env.AGY_FIXTURE_CAPTURE, JSON.stringify(x) + '\n');
const emit = (x) => { if(mode==='flat') x=x.step_update ? {...x.step_update,event:x.event} : x.result ? {...x.result,event:x.event} : x; process.stdout.write(JSON.stringify(x) + '\n'); };
capture({args});
if(args[0]==='models') { console.log('gemini-4-argon-high Gemini 4 Argon High\ngemini-4-argon-medium Gemini 4 Argon Medium');process.exit(0); }
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'fixture-session';
const model = args[args.indexOf('--model') + 1];
let turn = 0;
if(mode.startsWith('group-')) {
  const workerCode = `const fs=require('node:fs'); for(const s of ['SIGTERM','SIGHUP','SIGINT'])process.on(s,()=>{}); setInterval(()=>fs.appendFileSync(process.env.AGY_FIXTURE_HEARTBEAT,'x'),10);`;
  const heartbeat=process.env.AGY_FIXTURE_HEARTBEAT+'.'+process.pid;
  const worker=require('node:child_process').spawn(process.execPath,['-e',workerCode],{env:{...process.env,AGY_FIXTURE_HEARTBEAT:heartbeat},stdio:'ignore'});
  capture({ownedRoot:process.pid,ownedWorker:worker.pid,ownedRunner:process.ppid,heartbeat});
  process.on('SIGTERM',()=>process.exit(0));process.on('SIGHUP',()=>process.exit(0));
}

process.on('SIGINT', () => { capture({signal: 'SIGINT'}); if (mode === 'survive-interrupt') return; process.exit(130); });
if (mode === 'auth') { process.stderr.write('authentication required Bearer super-secret-token https://login/?token=hidden\n'); process.exit(1); }
if (mode === 'silent' || mode === 'group-silent') { setInterval(() => {}, 1000); return; }
if (mode === 'malformed') { process.stdout.write('{not json}\n'); return; }
if (mode === 'oversized') { process.stdout.write('x'.repeat(300000)); return; }
const init = {model: mode === 'wrong-model' ? 'fallback-model' : model, cwd: process.cwd(), permission_mode: 'request-review', tools: []};
if (mode === 'missing-model') delete init.model;
setTimeout(()=>emit({event:'init', conversation_id: mode === 'wrong-session' ? 'foreign' : mode === 'missing-session' ? '' : conversation, init}), mode==='delayed-init' ? 200 : ['wrong-model','missing-model','wrong-session','missing-session'].includes(mode) ? 100 : 0);
if (mode === 'partial') { process.stdout.write('{'); process.exit(0); }
if (mode === 'unknown-storm') for(let i=0;i<70;i++) emit({event:'future_event'});
if (mode === 'unknown') emit({event:'future_event', command:'touch /tmp/never-execute-antigravity'});
if (mode === 'duplicate-init') emit({event:'init', conversation_id:conversation, init});
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const msg = JSON.parse(line);
  capture({input:msg});
  turn++;
  if (mode === 'crash' || mode === 'group-crash') process.exit(23);
  if (mode === 'no-ack') return;
  const id = mode === 'foreign-step' ? 'foreign' : conversation;
  setTimeout(() => {
    if(mode==='checkpoint') {emit({event:'step_update',step_update:{conversation_id:id,state:'DONE',step_type:'checkpoint'}});emit({event:'step_update',step_update:{conversation_id:id,state:'ACTIVE',step_type:'future_step'}});}
    emit({event:'step_update', step_update:{conversation_id:id,state:'DONE',step_type:'user_input'}});
    if(mode==='progress-error' || mode==='progress-metadata') {
      emit({event:'step_update',step_update:{conversation_id:id,step_index:3,state:'ACTIVE',step_type:'tool',tool_name:'run_command'}});
      if(mode==='progress-metadata')emit({event:'step_update',step_update:{conversation_id:id,step_index:3,state:'FUTURE_STATE'}});
      else {process.stderr.write('Print mode: soft-denying tool confirmation \"RunCommand\" at step 3\n');emit({event:'step_update',step_update:{conversation_id:id,step_index:3,state:'ERROR',step_type:'tool',tool_name:'run_command'}});}
    }
    if(mode==='progress-stream' || mode==='progress-crash') {
      emit({event:'step_update',step_update:{conversation_id:id,step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'partial response'}});
      emit({event:'step_update',step_update:{conversation_id:id,step_index:2,state:'ACTIVE',step_type:'tool',tool_name:'search_web',tool_info:{parameters:{secret:'never-persist-me'},output:'Bearer never-persist-me'}}});
      if(mode==='progress-crash'){setTimeout(()=>process.exit(23),150);return;}
      setTimeout(()=>{emit({event:'step_update',step_update:{conversation_id:id,step_index:2,state:'DONE',step_type:'tool',tool_name:'search_web'}});emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'canonical final response'}});},700);return;
    }
    if (mode === 'hang-turn' || mode === 'survive-interrupt') return;
    setTimeout(() => {
      if (mode === 'permission') process.stderr.write('tool run_command soft-denied: requires approval\n');
      emit({event:'step_update',step_update:{conversation_id:conversation,state:'ACTIVE',step_type:'agent_response',text_delta:'hello'}});
      emit({event:'result', result:{conversation_id:conversation,status:mode === 'waiting' ? 'WAITING' : 'SUCCESS',response:mode === 'terminal-controls' ? '\x1b]0;malicious-title\x07\x1b[31mvisible\x1b[0m\x00' : 'hello '+turn,num_turns:turn}});
    }, mode === 'instant' ? 0 : 80);
  }, mode === 'delayed-ack' ? 180 : 5);
});
