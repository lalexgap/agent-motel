# Linux service ownership

`am-tmux.service` owns the default tmux server in the foreground (`tmux -D`). `am-daemon.service` owns the foreground daemon (`am __daemon`). The HTTP frontends want these services but do not own their processes. Frontend or daemon restarts must not restart tmux. There are intentionally no `PartOf=`, `BindsTo=`, or stop-propagating dependencies.

Installing `am-tmux.service` in the standard user unit directory enables managed startup for normal CLI commands on Linux. The supplied units also set `AGENTMGR_SYSTEMD=1`. In this mode startup goes through `systemctl --user start`, concurrent callers share the same unit, and tmux clients use `-N` so they cannot create an unsupervised replacement server. Startup verifies that the socket belongs to the service main PID. The foreground daemon holds an OS file lock for its lifetime and refuses to replace a live daemon's socket.

Without the unit or explicit opt-in, CLI startup remains unchanged on Linux and macOS. `AGENTMGR_SYSTEMD=0` explicitly disables managed startup. Custom `AGENTMGR_HOME` installations do not auto-detect these default units: provide matching customized units and explicit opt-in instead. Do not point a custom home at the stock daemon unit, which uses the default home. Units must use a PATH/login profile that resolves `am` to the intended checkout. Adjust `/usr/bin/tmux` where needed.

## Existing fleet: schedule migration

An existing tmux server cannot be adopted by starting a new foreground tmux service. Do not install/start these units or restart a frontend while live sessions still belong to the old frontend cgroup. Do not use a `kill-server` command as a migration shortcut.

1. Record all agent/session IDs, queues, current tasks, and tmux server PID/cgroup; preserve transcripts and worktrees. Check for non-Agent-Motel sessions on the same default socket too. Arrange an approved maintenance window to drain or explicitly stop every affected session, including concierge and the hub. Stop incoming frontend traffic and automatic concierge startup during the window.
2. Stop the old frontends and old daemon only after sessions are safely drained. Disable any stale daemon supervisor before stopping an unmanaged daemon, so it cannot race a replacement. Confirm the old tmux server and all old daemon processes are gone. A server configured with `exit-empty=off` needs an explicitly approved shutdown even when empty. Do not delete a socket owned by a live process.
3. Install the units from the intended checkout (include `am-web.service` only when using that frontend):

   ```sh
   mkdir -p ~/.config/systemd/user
   cp docs/am-{tmux,daemon,serve}.service ~/.config/systemd/user/
   # Optional: cp docs/am-web.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now am-tmux.service am-daemon.service am-serve.service
   # Optional: systemctl --user enable --now am-web.service
   ```

   Enable lingering if these services should survive logout (`loginctl enable-linger <user>`).
4. Confirm `systemctl --user show am-tmux.service -p MainPID -p ControlGroup` agrees with `tmux -N display-message -p '#{pid}'` and `/proc/<pid>/cgroup`. The tmux server must belong to `am-tmux.service`, never a frontend. Likewise compare `am daemon status` with the daemon unit MainPID. Verify only one daemon owns the socket, then resume approved agents from their saved IDs.

## Later deployments

Pull the intended code, restart only the affected HTTP frontends, and restart `am-daemon.service` if daemon code changed. `am daemon start/stop` uses the unit in managed mode. Never include `am-tmux.service` in an ordinary deploy restart. Verify the tmux server PID and session list stay unchanged. Default control-group cleanup stays enabled on frontends; process ownership provides the isolation.

A tmux crash still loses sessions; restarting its unit does not restore them. This change prevents unrelated frontend/daemon lifecycle operations from causing that failure. Configuring `exit-empty` back to `on` in tmux configuration can make an empty server exit; keep it off in managed installations.

## Verification

Run `bun test tests/services.test.ts tests/daemon.test.ts`. An opt-in integration test (`AM_TEST_SYSTEMD=1 bun test tests/serviceLifecycle.integration.test.ts`) uses uniquely named transient user services, a private tmux socket, a temporary Agent Motel home, and a sleeping test pane. It restarts/kills only those disposable services and verifies pane/server survival across frontend and daemon restarts. It does not touch installed Agent Motel units or real agents.

References: [tmux foreground mode](https://github.com/tmux/tmux/blob/master/tmux.1), [systemd service process ownership](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
