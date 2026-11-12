"use strict";
// The browser reaches an agent's terminal over a same-origin WebSocket after a GET preflight.
// A host without network access (the macOS app) passes its own transport instead:
//   preflight(name) resolves to { ok, status, error } before each attempt; status 401 signs out.
//   connect(name) returns a socket-like object with send(string), close(), readyState (1 when
//   open) and the onopen, onmessage({ data }) and onclose({ code, reason }) handlers set here.
//   Output arrives in data as an ArrayBuffer, control messages as JSON strings.
window.createAgentTerminal = function ({ screen, status, onUnauthorized, preflight, connect: openSocket }) {
  let terminal, fit, observer, socket, retry, target = null, attempts = 0, generation = 0;
  const OPEN = 1;
  const terminalUrl = (name) => {
    const url = new URL("/api/agents/" + encodeURIComponent(name) + "/terminal", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };
  preflight ||= async (name) => {
    const response = await fetch(terminalUrl(name).pathname);
    const data = await response.json();
    return { ok: response.ok, status: response.status, error: data.error };
  };
  openSocket ||= (name) => {
    const ws = new WebSocket(terminalUrl(name));
    ws.binaryType = "arraybuffer";
    return ws;
  };
  function send(message) {
    if (socket?.readyState === OPEN)
      socket.send(JSON.stringify(message));
  }
  function input(data) {
    let chunk = "";
    for (const character of data) {
      chunk += character;
      if (chunk.length >= 2048) { send({ type: "input", data: chunk }); chunk = ""; }
    }
    if (chunk) send({ type: "input", data: chunk });
  }
  function resize() {
    if (!terminal || !screen.clientWidth || !screen.clientHeight) return;
    fit.fit();
    terminal.resize(Math.min(terminal.cols, 500), Math.min(terminal.rows, 200));
    send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
  }
  function close() {
    generation++;
    target = null;
    clearTimeout(retry);
    const old = socket;
    socket = null;
    old?.close();
    observer?.disconnect();
    observer = null;
    terminal?.dispose();
    terminal = fit = null;
    screen.replaceChildren();
  }
  async function connect() {
    if (!target) return;
    const current = ++generation;
    clearTimeout(retry);
    status.textContent = attempts ? "Reconnecting…" : "Connecting…";
    try {
      const response = await preflight(target);
      if (current !== generation || !target) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { status.textContent = response.error || "Terminal unavailable"; return; }
    } catch {
      if (current !== generation || !target) return;
      status.textContent = "Connection interrupted · retrying…";
      retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      return;
    }
    const ws = openSocket(target);
    let pendingOutput = 0;
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      attempts = 0;
      terminal.reset();
      status.textContent = "● Live terminal";
      resize();
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        const size = event.data.byteLength;
        pendingOutput += size;
        if (pendingOutput > 1024 * 1024) {
          socket = null;
          ws.close();
          status.textContent = "Output exceeded rendering capacity · Reconnect to resume";
          return;
        }
        try {
          terminal.write(new Uint8Array(event.data), () => { pendingOutput -= size; });
        } catch {
          socket = null;
          ws.close();
          status.textContent = "Terminal rendering failed · Reconnect to resume";
        }
      } else {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ready") resize();
          if (message.type === "error") status.textContent = message.message;
          if (message.type === "exit") status.textContent = "Terminal detached";
        } catch {
          status.textContent = "Unexpected terminal response";
        }
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws || !target) return;
      socket = null;
      if (event.code === 4001) {
        status.textContent = "Session expired — sign in again";
        onUnauthorized();
        return;
      }
      if (event.code === 1008) {
        status.textContent = event.reason || "Terminal disconnected · Reconnect to attach";
        return;
      }
      if (event.code === 1000) {
        status.textContent = "Terminal detached · Reconnect to attach";
        return;
      }
      status.textContent = "Disconnected · reconnecting…";
      retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
    };
  }
  return {
    open(name, agentStatus) {
      if (["exited", "dead"].includes(agentStatus)) {
        close();
        status.textContent = "Agent stopped · Resume to open its terminal";
        return;
      }
      if (target === name) return;
      close();
      target = name;
      attempts = 0;
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
        fontSize: 13,
        scrollback: 5000,
        theme: { background: "#181818", foreground: "#d4d4d4", cursor: "#d4d4d4" },
        allowProposedApi: false,
        linkHandler: { activate: (event, uri) => window.agentLinks.open(event, uri) },
      });
      fit = new FitAddon.FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => window.agentLinks.open(event, uri)));
      terminal.open(screen);
      terminal.onData(input);
      observer = new ResizeObserver(resize);
      observer.observe(screen);
      resize();
      connect();
    },
    close,
    input,
    focus: () => terminal?.focus(),
    reconnect() {
      if (!target) return;
      clearTimeout(retry);
      const old = socket;
      socket = null;
      old?.close();
      attempts = 0;
      connect();
    },
  };
};
