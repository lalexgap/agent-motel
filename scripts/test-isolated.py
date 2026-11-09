#!/usr/bin/env python3
"""Run tests with private HOME/state/tmux and no real provider invocations.

--base REF tests an immutable git archive; other arguments go to bun test.
--typecheck runs the locally installed TypeScript compiler in the same isolation.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

repo = Path(__file__).resolve().parents[1]
args = sys.argv[1:]
base = None
if args[:1] == ['--base']:
    base, args = args[1], args[2:]
typecheck = args[:1] == ['--typecheck']
if typecheck:
    args = args[1:]
with tempfile.TemporaryDirectory(prefix='am-isolated-') as directory:
    root = Path(directory)
    cwd = repo
    if base:
        cwd = root / 'repo'
        cwd.mkdir()
        archive = subprocess.check_output(['git', '-C', str(repo), 'archive', base])
        import io
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(cwd, filter='data')
        if (repo / 'node_modules').exists():
            (cwd / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    bindir = root / 'bin'
    bindir.mkdir()
    tmux = shutil.which('tmux')
    socket = 'am-isolated-' + str(os.getpid())
    stubs = {
        'claude': '#!/bin/sh\nexit 127\n',
        'codex': '#!/bin/sh\nexit 127\n',
        'agy': '#!/bin/sh\nexit 127\n',
    }
    if tmux:
        import shlex
        stubs['tmux'] = '#!/bin/sh\nexec ' + shlex.quote(tmux) + ' -L ' + socket + ' "$@"\n'
    for name, content in stubs.items():
        file = bindir / name
        file.write_text(content)
        file.chmod(0o755)
    env = {key: value for key, value in os.environ.items()
           if not any(part in key for part in ('TOKEN', 'API_KEY', 'CREDENTIAL'))}
    user = root / 'user'
    user.mkdir()
    env.update(HOME=str(user), CODEX_HOME=str(user / '.codex'),
               CLAUDE_CONFIG_DIR=str(user / '.claude'),
               XDG_CONFIG_HOME=str(user / '.config'),
               AGENTMGR_HOME=str(root / 'am'), AGENTMGR_SYSTEMD='0',
               ANTIGRAVITY_APP_DATA_DIR='', ANTIGRAVITY_GEMINI_DIR='',
               PATH=str(bindir) + ':' + env.get('PATH', ''),
               AM_TEST_SYSTEMD='0', AGENTMGR_AGENT='', AM_HOST='', TMUX='')
    try:
        command = (['bun', str(repo / 'node_modules/typescript/bin/tsc'), '--noEmit', *args]
                   if typecheck else ['bun', 'test', *args])
        result = subprocess.run(command, cwd=cwd, env=env)
    finally:
        if tmux:
            subprocess.run([tmux, '-L', socket, 'kill-server'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.exit(result.returncode)
