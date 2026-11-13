export function ownsDecisionCardMutation(
  generation: number,
  currentGeneration: number,
  request: number,
  currentRequest: number,
  target: string,
  selected: string | null,
  active: string | null,
): boolean {
  return generation === currentGeneration && request === currentRequest && selected === target && active === target;
}
