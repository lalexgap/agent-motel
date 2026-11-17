import { cleanupBlocked, cleanupCanApply, cleanupForceable, parseCleanupPlan } from "./cleanup";
import { activationReleased, callOutcome, clearFailure, isPending, noteFailure, setPending } from "./actionRuntime";
import { call } from "./bridge";
import { refreshConnection } from "./data";
import { h } from "./dom";
import { parseAgentKey } from "./fleet";
import { focusCursor } from "./sidebar";
import { state } from "./state";
import { flashStatus } from "./statusbar";
import type { CleanupPlan } from "./types";

interface CleanupDialog {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  source: HTMLElement;
  loading: HTMLElement;
  preview: HTMLElement;
  remove: HTMLUListElement;
  keep: HTMLUListElement;
  git: HTMLElement;
  blockersSection: HTMLElement;
  blockers: HTMLUListElement;
  confirmed: HTMLInputElement;
  forceField: HTMLElement;
  force: HTMLInputElement;
  error: HTMLElement;
  close: HTMLButtonElement;
  cancel: HTMLButtonElement;
  submit: HTMLButtonElement;
  key: string | null;
  plan: CleanupPlan | null;
  busy: boolean;
  returnTo: HTMLElement | null;
}

let box: CleanupDialog | null = null;

function list(target: HTMLUListElement, values: string[], empty: string): void {
  target.replaceChildren(...(values.length ? values.map((value) => h("li", "", value)) : [h("li", "muted", empty)]));
}

function updateSubmit(): void {
  if (!box) return;
  box.submit.disabled = !box.plan || box.busy || !cleanupCanApply(box.plan, box.confirmed.checked, box.force.checked);
}

function build(): CleanupDialog {
  const dialog = h("dialog", "am-action-dialog am-cleanup-dialog") as HTMLDialogElement;
  dialog.setAttribute("aria-labelledby", "am-cleanup-title");
  const form = h("form") as HTMLFormElement;
  const header = h("div", "section-header");
  const title = h("h2", "", "Clean up agent");
  title.id = "am-cleanup-title";
  const close = h("button", "am-dialog-close", "×") as HTMLButtonElement;
  close.type = "button";
  close.setAttribute("aria-label", "Close cleanup preview");
  header.append(title, close);
  const source = h("p", "am-dialog-source");
  const warning = h("p", "cleanup-warning", "Cleanup permanently deletes the listed files. Resume can recreate the checkout, but deleted uncommitted changes and the private database are not restored.");
  const loading = h("p", "muted", "Preparing cleanup preview…");
  loading.setAttribute("role", "status");
  const preview = h("div", "cleanup-preview");
  preview.hidden = true;
  const remove = h("ul") as HTMLUListElement;
  const keep = h("ul") as HTMLUListElement;
  const git = h("p");
  const blockers = h("ul") as HTMLUListElement;
  const blockersSection = h("section");
  blockersSection.append(h("h3", "", "Blockers"), blockers);
  blockersSection.hidden = true;
  const confirmed = h("input") as HTMLInputElement;
  confirmed.type = "checkbox";
  const confirmedField = h("label", "cleanup-ack", " I reviewed this preview and understand these items will be permanently deleted.");
  confirmedField.prepend(confirmed);
  const force = h("input") as HTMLInputElement;
  force.type = "checkbox";
  const forceField = h("label", "cleanup-ack danger-ack", " Force cleanup despite the blockers above.");
  forceField.prepend(force);
  forceField.hidden = true;
  const section = (title: string, content: HTMLElement): HTMLElement => {
    const node = h("section"); node.append(h("h3", "", title), content); return node;
  };
  preview.append(section("Remove", remove), section("Keep", keep), section("Branch and pull requests", git), blockersSection, confirmedField, forceField);
  const error = h("p", "am-dialog-error");
  error.setAttribute("role", "alert");
  const actions = h("div", "am-dialog-actions");
  const cancel = h("button", "", "Cancel") as HTMLButtonElement;
  cancel.type = "button";
  const submit = h("button", "primary danger", "Clean up") as HTMLButtonElement;
  submit.type = "submit";
  submit.disabled = true;
  actions.append(cancel, submit);
  form.append(header, source, warning, loading, preview, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  const built: CleanupDialog = { dialog, form, source, loading, preview, remove, keep, git, blockersSection, blockers, confirmed, forceField, force, error, close, cancel, submit, key: null, plan: null, busy: false, returnTo: null };
  for (const input of [confirmed, force]) input.addEventListener("change", updateSubmit);
  for (const button of [close, cancel]) button.addEventListener("click", () => { if (!built.busy) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (built.busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    built.key = null; built.plan = null;
    const target = built.returnTo; built.returnTo = null;
    if (target?.isConnected && !(target as HTMLButtonElement).disabled && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else focusCursor(false);
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); void apply(); });
  return built;
}

function busy(value: boolean, label = "Clean up"): void {
  if (!box) return;
  box.busy = value;
  box.close.disabled = value;
  box.cancel.disabled = value;
  box.confirmed.disabled = value;
  box.force.disabled = value;
  box.submit.textContent = label;
  updateSubmit();
}

function render(plan: CleanupPlan): void {
  if (!box) return;
  list(box.remove, plan.remove, "Nothing");
  list(box.keep, plan.keep, "Nothing");
  box.git.textContent = `${plan.branch ? `Branch: ${plan.branch}.` : "No branch is attached."}${plan.prs.length ? ` Pull requests: ${plan.prs.join(", ")}.` : " No pull requests are attached."}`;
  list(box.blockers, plan.blockers.map((item) => `${item.reason}${item.forceable ? " (can be forced)" : " (cannot be forced)"}`), "None");
  box.blockersSection.hidden = !plan.blockers.length;
  box.forceField.hidden = !cleanupForceable(plan);
  box.loading.hidden = true;
  box.preview.hidden = false;
  if (cleanupBlocked(plan)) box.error.textContent = "Cleanup cannot continue until the non-forceable blockers are resolved.";
  updateSubmit();
}

export async function openCleanup(key: string, returnTo?: HTMLElement | null): Promise<void> {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  box ??= build();
  box.key = key;
  box.plan = null;
  box.returnTo = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  box.source.textContent = parsed.id;
  box.error.textContent = "";
  box.loading.hidden = false;
  box.preview.hidden = true;
  box.confirmed.checked = false;
  box.force.checked = false;
  busy(true, "Preparing…");
  box.dialog.showModal();
  setPending(key, true, "cleanup");
  try {
    const result = await call("agents.cleanupPreview", { connection: parsed.connection, agent: parsed.id });
    if (!box.dialog.open || box.key !== key) return;
    if (result.status < 200 || result.status >= 300) throw new Error((result.body as { error?: unknown } | null)?.error as string || `The server returned HTTP ${result.status}`);
    const plan = parseCleanupPlan(result.body, parsed.id);
    if (!plan) throw new Error("The server returned an invalid cleanup preview.");
    box.plan = plan;
    busy(false);
    render(plan);
  } catch (error) {
    if (box.dialog.open && box.key === key) {
      busy(false);
      box.loading.hidden = true;
      box.error.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    setPending(key, false);
  }
}

async function apply(): Promise<void> {
  if (!box?.key || !box.plan || !cleanupCanApply(box.plan, box.confirmed.checked, box.force.checked)) return;
  const key = box.key;
  const plan = box.plan;
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  setPending(key, true, "cleanup");
  clearFailure(key);
  busy(true, "Cleaning up…");
  box.error.textContent = "";
  try {
    if (!(await activationReleased("agents.cleanup"))) return;
    const outcome = await callOutcome("agents.cleanup", { connection: parsed.connection, agent: parsed.id, createdAt: plan.createdAt, token: plan.token, force: plan.blockers.length > 0 });
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "failed") {
      noteFailure(key, outcome);
      box.error.textContent = outcome.message + " Preview again before retrying if the agent or connection changed.";
      return;
    }
    box.dialog.close();
    await refreshConnection(parsed.connection);
    flashStatus(`${parsed.id} cleaned up`, 5000);
  } finally {
    setPending(key, false);
    if (box.dialog.open && box.key === key) busy(false);
  }
}
