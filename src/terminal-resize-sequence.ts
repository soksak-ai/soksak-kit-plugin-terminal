export function resizeRequestIsCurrent(requestSequence: number, currentSequence: number, stopped: boolean): boolean {
  return !stopped && requestSequence === currentSequence;
}
