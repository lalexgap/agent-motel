import { call } from "./bridge";

interface DecisionTarget {
  connection: string;
  agent: string;
  decisionId: string;
}

type Dispatch = (target: DecisionTarget) => Promise<unknown>;

export class DecisionOpenCoordinator {
  private pending = new Map<string, Promise<void>>();

  constructor(private readonly dispatch: Dispatch = (target) => call("decisions.open", target)) {}

  open(target: DecisionTarget): Promise<void> {
    const key = JSON.stringify([target.connection, target.agent, target.decisionId]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    let request: Promise<void>;
    request = this.dispatch(target).then(() => undefined).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
}

export const decisionOpener = new DecisionOpenCoordinator();
