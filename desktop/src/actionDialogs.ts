// The agent action dialogs, as in the browser UI: rename, move to host,
// handover and change model. Each is a page <dialog> built on first use; it
// keeps focus while open, returns it to the control that opened it, and shows
// failures inside itself. Move and model changes are then confirmed by the
// bridge's native sheet.
import {
  chosen,
  defaultHandoverTarget,
  dialogMessage,
  effortChoices,
  keyAfter,
  modelChoices,
  moveDir,
  moveHostOptions,
  nameProblem,
  NO_HOSTS,
  pickCatalog,
  SUFFIX,
  UNREACHABLE,
  type ActionOutcome,
  type Choice,
  type ProviderCatalog,
} from "./actions";
import { activationReleased, callOutcome, clearFailure, isPending, noteFailure, setPending } from "./actionRuntime";
import { ApiError, apiGet } from "./api";
import { selectAgent } from "./chat";
import { refreshConnection } from "./data";
import { h } from "./dom";
import { agentPath, parseAgentKey } from "./fleet";
import { AGENT_GONE, RUNNING_STATUSES } from "./policy";
import { focusCursor } from "./sidebar";
import { findRow, state } from "./state";
import { flashStatus } from "./statusbar";
import type { AgentDetail, HostsResponse, RunningStatus } from "./types";

type Failed = Extract<ActionOutcome, { kind: "failed" }>;

interface Shell {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  source: HTMLElement;
  error: HTMLElement;
  submit: HTMLButtonElement;
  submitLabel: string;
  busy: boolean;
  returnTo: HTMLElement | null;
}

const FOCUSABLE = "button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => !(node as HTMLButtonElement).disabled && !node.closest("[hidden]") && node.getClientRects().length > 0,
  );
}

function shell(id: string, title: string, submitLabel: string, fields: HTMLElement[], onSubmit: () => void): Shell {
  const dialog = h("dialog", "am-action-dialog");
  dialog.id = id;
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  const form = h("form");
  form.noValidate = true;
  const header = h("div", "section-header");
  const heading = h("h2", "", title);
  heading.id = `${id}-title`;
  const close = h("button", "am-dialog-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  header.append(heading, close);
  const source = h("p", "am-dialog-source");
  const error = h("p", "am-dialog-error");
  error.setAttribute("role", "alert");
  const actions = h("div", "am-dialog-actions");
  const cancel = h("button", "", "Cancel");
  cancel.type = "button";
  const submit = h("button", "primary", submitLabel);
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(header, source, ...fields, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  const box: Shell = { dialog, form, source, error, submit, submitLabel, busy: false, returnTo: null };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!box.busy && !submit.disabled) onSubmit();
  });
  for (const button of [close, cancel]) button.addEventListener("click", () => { if (!box.busy) dialog.close(); });
  // Esc closes, except while a request is in flight: its outcome lands here.
  dialog.addEventListener("cancel", (event) => { if (box.busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    const target = box.returnTo;
    box.returnTo = null;
    if (target?.isConnected && !(target as HTMLButtonElement).disabled && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else focusCursor(false);
  });
  dialog.addEventListener("keydown", (event) => {
    // The window's shortcuts (j/k, o, /, Esc to the list) don't apply inside a dialog.
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const nodes = focusables(dialog);
    if (!nodes.length) {
      event.preventDefault();
      return;
    }
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index < 0 || index === nodes.length - 1 ? 0 : index + 1);
    event.preventDefault();
    nodes[next]!.focus();
  });
  return box;
}

function open(box: Shell, returnTo: HTMLElement | null | undefined, source: string): void {
  box.returnTo = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  box.source.textContent = source;
  box.error.textContent = "";
  setBusy(box, false);
  if (!box.dialog.open) box.dialog.showModal();
}

// Busy: every control off, Esc ignored, the submit button saying what is happening.
function setBusy(box: Shell, busy: boolean, label?: string): void {
  box.busy = busy;
  for (const node of box.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, button")) {
    if (busy) {
      node.dataset.wasDisabled = String(node.disabled);
      node.disabled = true;
    } else if (node.dataset.wasDisabled !== undefined) {
      node.disabled = node.dataset.wasDisabled === "true";
      delete node.dataset.wasDisabled;
    }
  }
  box.submit.textContent = busy && label ? label : box.submitLabel;
}

function fail(box: Shell, key: string, outcome: Failed, suffix: string, focus?: HTMLElement): void {
  noteFailure(key, outcome);
  box.error.textContent = dialogMessage(outcome, suffix);
  if (box.dialog.open) (focus ?? focusables(box.dialog)[0])?.focus();
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = h("label", "", label);
  node.append(control);
  return node;
}

function nameInput(placeholder?: string): HTMLInputElement {
  const input = h("input");
  input.type = "text";
  input.maxLength = 64;
  input.pattern = "[A-Za-z0-9_-]+";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function fillSelect(select: HTMLSelectElement, choices: readonly Choice[], value: string): void {
  select.replaceChildren(...choices.map((choice) => {
    const option = h("option", "", choice.label);
    option.value = choice.value;
    return option;
  }));
  select.value = value;
}

// Opens the agent a successful rename, move or handover leads to, unless the
// user has gone elsewhere meanwhile; then refreshes.
async function landOn(connection: string, next: string | null, selectedBefore: string | null): Promise<boolean> {
  const follow = !!next && state.selected === selectedBefore;
  if (follow) selectAgent(next);
  await refreshConnection(connection);
  return follow;
}

let renameBox: Shell | null = null;
let renameInput: HTMLInputElement;
let renameKey: string | null = null;

export function openRename(key: string, returnTo?: HTMLElement | null): void {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  if (!renameBox) {
    renameInput = nameInput();
    renameInput.required = true;
    renameInput.addEventListener("input", () => { if (renameBox) renameBox.error.textContent = ""; });
    renameBox = shell("am-rename-dialog", "Rename agent", "Rename", [field("New name", renameInput)], () => void submitRename());
  }
  renameKey = key;
  open(renameBox, returnTo, parsed.id);
  renameInput.value = parsed.id.split(":").pop() ?? "";
  renameInput.focus();
  renameInput.select();
}

async function submitRename(): Promise<void> {
  const box = renameBox!, key = renameKey;
  const parsed = key && parseAgentKey(key);
  if (!key || !parsed || isPending(key)) return;
  const name = renameInput.value.trim();
  const problem = nameProblem(name);
  if (problem) {
    box.error.textContent = problem;
    renameInput.focus();
    return;
  }
  const selectedBefore = state.selected;
  setPending(key, true);
  setBusy(box, true, "Renaming…");
  box.error.textContent = "";
  try {
    const outcome = await callOutcome("agents.rename", { connection: parsed.connection, agent: parsed.id, name });
    if (outcome.kind !== "ok") {
      setBusy(box, false);
      return outcome.kind === "failed" ? fail(box, key, outcome, SUFFIX.manage, renameInput) : undefined;
    }
    clearFailure(key);
    setBusy(box, false);
    if (renameKey === key) box.dialog.close();
    await landOn(parsed.connection, keyAfter(parsed.connection, "rename", outcome.body), selectedBefore);
  } finally {
    setPending(key, false);
    if (box.busy) setBusy(box, false);
  }
}

let moveBox: Shell | null = null;
let moveHost: HTMLSelectElement;
let moveDirInput: HTMLInputElement;
let moveKey: string | null = null;

export function openMove(key: string, returnTo?: HTMLElement | null): void {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  if (!moveBox) {
    const note = h("p", "muted am-dialog-note", "Moves the conversation and queue, stops the source and resumes on the destination. Workspace files are not copied. Commit and push changes first.");
    moveHost = h("select");
    moveDirInput = h("input");
    moveDirInput.type = "text";
    moveDirInput.placeholder = "Default mapped directory";
    moveDirInput.autocomplete = "off";
    moveDirInput.spellcheck = false;
    moveDirInput.addEventListener("input", () => { if (moveBox) moveBox.error.textContent = ""; });
    moveBox = shell("am-move-dialog", "Move agent", "Move agent",
      [note, field("Destination host", moveHost), field("Destination directory (optional)", moveDirInput)], () => void submitMove());
  }
  const box = moveBox;
  moveKey = key;
  open(box, returnTo, parsed.id);
  moveDirInput.value = "";
  fillSelect(moveHost, [{ value: "", label: "Loading hosts…" }], "");
  moveHost.disabled = true;
  box.submit.disabled = true;
  moveHost.focus();
  void loadMoveHosts(key, parsed.connection, parsed.id.includes(":"));
}

async function loadMoveHosts(key: string, connection: string, remote: boolean): Promise<void> {
  const box = moveBox!;
  try {
    const hosts = await apiGet<HostsResponse>(connection, "/api/hosts");
    if (moveKey !== key || !box.dialog.open) return;
    const options = moveHostOptions(hosts, remote);
    fillSelect(moveHost, options, options[0]?.value ?? "");
    moveHost.disabled = !options.length;
    box.submit.disabled = !options.length;
    if (!options.length) box.error.textContent = NO_HOSTS;
    // The select was disabled while loading, so the dialog opened on its close button.
    else if (document.activeElement !== moveDirInput) moveHost.focus();
  } catch (error) {
    if (moveKey === key && box.dialog.open) box.error.textContent = `Hosts could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function submitMove(): Promise<void> {
  const box = moveBox!, key = moveKey;
  const parsed = key && parseAgentKey(key);
  if (!key || !parsed || isPending(key) || !moveHost.value) return;
  const dir = moveDir(moveDirInput.value);
  if ("error" in dir) {
    box.error.textContent = dir.error;
    moveDirInput.focus();
    return;
  }
  const host = moveHost.value;
  const selectedBefore = state.selected;
  setPending(key, true);
  setBusy(box, true, "Moving…");
  box.error.textContent = "";
  try {
    if (!(await activationReleased("agents.move"))) return;
    const outcome = await callOutcome("agents.move", { connection: parsed.connection, agent: parsed.id, host, ...dir });
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "failed") {
      setBusy(box, false);
      return fail(box, key, outcome, SUFFIX.manage, moveHost);
    }
    clearFailure(key);
    setBusy(box, false);
    if (moveKey === key) box.dialog.close();
    await landOn(parsed.connection, keyAfter(parsed.connection, "move", outcome.body), selectedBefore);
  } finally {
    setPending(key, false);
    if (box.busy) {
      setBusy(box, false);
      if (box.dialog.open) moveHost.focus();
    }
  }
}

let handoverBox: Shell | null = null;
let handoverProvider: HTMLSelectElement;
let handoverName: HTMLInputElement;
let handoverFull: HTMLInputElement;
let handoverKey: string | null = null;

export function openHandover(key: string, returnTo?: HTMLElement | null): void {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  const row = findRow(key);
  if (row?.provider === "antigravity") {
    flashStatus("Antigravity handoff is unsupported.", 4000, "error");
    return;
  }
  if (!handoverBox) {
    const note = h("p", "muted am-dialog-note", "Creates a new agent using this conversation. Starts from the source commit; uncommitted workspace files are not copied. The source agent keeps running.");
    handoverProvider = h("select");
    fillSelect(handoverProvider, [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }], "codex");
    handoverName = nameInput("Automatic name");
    handoverName.addEventListener("input", () => { if (handoverBox) handoverBox.error.textContent = ""; });
    handoverFull = h("input");
    handoverFull.type = "checkbox";
    const full = h("label", "related-filter");
    full.append(handoverFull, document.createTextNode(" Include full tool output"));
    handoverBox = shell("am-handover-dialog", "Hand over agent", "Create handover agent",
      [note, field("Provider", handoverProvider), field("New agent name", handoverName), full], () => void submitHandover());
  }
  handoverKey = key;
  open(handoverBox, returnTo, `From: ${parsed.id}`);
  handoverProvider.value = defaultHandoverTarget(row?.provider ?? (state.detail?.key === key ? state.detail.detail?.provider : undefined));
  handoverName.value = "";
  handoverFull.checked = false;
  handoverProvider.focus();
}

async function submitHandover(): Promise<void> {
  const box = handoverBox!, key = handoverKey;
  const parsed = key && parseAgentKey(key);
  if (!key || !parsed || isPending(key)) return;
  const newName = handoverName.value.trim();
  const problem = newName ? nameProblem(newName) : null;
  if (problem) {
    box.error.textContent = problem;
    handoverName.focus();
    return;
  }
  const to = handoverProvider.value === "claude" ? "claude" : "codex";
  const selectedBefore = state.selected;
  setPending(key, true);
  setBusy(box, true, "Creating agent…");
  box.error.textContent = "";
  try {
    const outcome = await callOutcome("agents.handoff", {
      connection: parsed.connection, agent: parsed.id, to, full: handoverFull.checked, ...(newName ? { newName } : {}),
    });
    if (outcome.kind !== "ok") {
      setBusy(box, false);
      return outcome.kind === "failed" ? fail(box, key, outcome, SUFFIX.handover, handoverProvider) : undefined;
    }
    setBusy(box, false);
    if (handoverKey === key) box.dialog.close();
    const next = keyAfter(parsed.connection, "handover", outcome.body);
    if (!(await landOn(parsed.connection, next, selectedBefore)) && next) flashStatus(`Handover created: ${parseAgentKey(next)?.id ?? next}`, 6000);
  } finally {
    setPending(key, false);
    if (box.busy) setBusy(box, false);
  }
}

interface ModelContext {
  key: string;
  connection: string;
  id: string;
  provider: string;
  model: string | null;
  effort: string | null;
  createdAt: string;
  catalog: ProviderCatalog | null;
}
let modelBox: Shell | null = null;
let modelSelect: HTMLSelectElement;
let effortSelect: HTMLSelectElement;
let modelContext: ModelContext | null = null;

function fillEfforts(context: ModelContext, wanted: string | null): void {
  const choices = effortChoices(context.catalog, modelSelect.value, wanted);
  fillSelect(effortSelect, choices, chosen(choices, wanted));
}

export function openModel(key: string, returnTo?: HTMLElement | null): void {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  const detail = state.detail?.key === key ? state.detail.detail : null;
  if (!detail?.provider) {
    flashStatus("Agent details are still loading. Try again shortly.", 4000, "error");
    return;
  }
  if (!modelBox) {
    const warning = h("p", "model-warning", "Restarting interrupts the current turn. The conversation and queued messages are retained.");
    modelSelect = h("select");
    effortSelect = h("select");
    const observed = h("p", "muted am-dialog-note", "The model shown in agent details comes from the last reply and can lag until the agent replies again.");
    modelSelect.addEventListener("change", () => {
      modelBox!.error.textContent = "";
      if (modelContext) fillEfforts(modelContext, effortSelect.value);
    });
    effortSelect.addEventListener("change", () => { modelBox!.error.textContent = ""; });
    modelBox = shell("am-model-dialog", "Change model", "Restart with model",
      [warning, field("Model", modelSelect), field("Reasoning effort", effortSelect), observed], () => void submitModel());
  }
  const box = modelBox;
  const context: ModelContext = {
    key, connection: parsed.connection, id: parsed.id, provider: detail.provider,
    model: detail.model ?? null, effort: detail.effort ?? null, createdAt: detail.createdAt, catalog: null,
  };
  modelContext = context;
  open(box, returnTo, `${parsed.id} · ${detail.provider}`);
  fillSelect(modelSelect, [{ value: "", label: "Loading models…" }], "");
  fillSelect(effortSelect, [{ value: "", label: "Loading efforts…" }], "");
  modelSelect.disabled = effortSelect.disabled = box.submit.disabled = true;
  box.dialog.querySelector<HTMLElement>(".am-dialog-actions button")?.focus();
  void loadCatalog(context);
}

async function loadCatalog(context: ModelContext): Promise<void> {
  const box = modelBox!;
  const host = context.id.includes(":") ? context.id.split(":", 1)[0]! : "";
  try {
    const catalogs = await apiGet<unknown>(context.connection, "/api/models" + (host ? "?host=" + encodeURIComponent(host) : ""));
    if (modelContext !== context || !box.dialog.open) return;
    context.catalog = pickCatalog(catalogs, context.provider);
    if (!context.catalog) throw new Error(`No ${context.provider} model catalog is available on ${host || "this server"}.`);
    const models = modelChoices(context.catalog, context.model);
    fillSelect(modelSelect, models, chosen(models, context.model));
    fillEfforts(context, context.effort);
    modelSelect.disabled = effortSelect.disabled = box.submit.disabled = false;
    modelSelect.focus();
  } catch (error) {
    if (modelContext === context && box.dialog.open) box.error.textContent = `Models could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function submitModel(): Promise<void> {
  const box = modelBox!, context = modelContext;
  if (!context?.catalog || isPending(context.key)) return;
  const { key, connection, id } = context;
  setPending(key, true);
  setBusy(box, true, "Restarting…");
  box.error.textContent = "";
  try {
    if (!(await activationReleased("agents.model"))) return;
    // am refuses a status that changed since the dialog opened (working → idle is
    // common): read it again now and send that, for the same agent only.
    let fresh: AgentDetail;
    try {
      fresh = await apiGet<AgentDetail>(connection, agentPath(id));
    } catch (error) {
      setBusy(box, false);
      const gone = error instanceof ApiError && error.status === 404;
      return fail(box, key, gone
        ? { kind: "failed", message: AGENT_GONE, gone: true, advised: true }
        : error instanceof ApiError
          ? { kind: "failed", message: error.message, tokenRejected: error.status === 401 }
          : { kind: "failed", message: UNREACHABLE, advised: true }, SUFFIX.model, modelSelect);
    }
    if (fresh.createdAt !== context.createdAt) {
      setBusy(box, false);
      return fail(box, key, { kind: "failed", message: "This agent was replaced since the dialog opened. Close the dialog and check the agent before retrying.", advised: true }, SUFFIX.model, modelSelect);
    }
    if (!(RUNNING_STATUSES as readonly string[]).includes(fresh.status)) {
      setBusy(box, false);
      return fail(box, key, { kind: "failed", message: "This agent has stopped since the dialog opened. Resume it before changing the model.", advised: true }, SUFFIX.model, modelSelect);
    }
    const outcome = await callOutcome("agents.model", {
      connection, agent: id, model: modelSelect.value || null, effort: effortSelect.value || null,
      createdAt: context.createdAt, status: fresh.status as RunningStatus,
    });
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "failed") {
      setBusy(box, false);
      return fail(box, key, outcome, SUFFIX.model, modelSelect);
    }
    clearFailure(key);
    setBusy(box, false);
    if (modelContext === context) box.dialog.close();
    await refreshConnection(connection);
  } finally {
    setPending(key, false);
    if (box.busy) {
      setBusy(box, false);
      if (box.dialog.open) modelSelect.focus();
    }
  }
}
