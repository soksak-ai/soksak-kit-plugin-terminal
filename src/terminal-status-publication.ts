import type {
  TerminalPluginFailure, TerminalPluginPhase, TerminalPluginPublicStatus,
  TerminalRecoveryFidelity, TerminalRecoveryOutcome, TerminalRendererProfile,
} from "@soksak/soksak-contract-plugin-terminal";

export interface TerminalStatusControllerOptions {
  root: HTMLElement;
  pluginId: string;
  engineId: string;
  rendererId: string;
  rendererProfile: TerminalRendererProfile;
  publish: (status: TerminalPluginPublicStatus) => void;
  presentation: () => TerminalPluginPublicStatus["presentation"];
}

export interface TerminalStatusController {
  set(phase: TerminalPluginPhase, options?: {
    recoveryOutcome?: TerminalRecoveryOutcome;
    fidelity?: TerminalRecoveryFidelity;
    failure?: TerminalPluginFailure | null;
  }): TerminalPluginPublicStatus;
  current(): TerminalPluginPublicStatus;
  refresh(): TerminalPluginPublicStatus;
  wait(phases: readonly TerminalPluginPhase[], timeoutMs: number): Promise<TerminalPluginPublicStatus>;
  close(): TerminalPluginPublicStatus;
}

export function createTerminalStatusController(
  options: TerminalStatusControllerOptions,
): TerminalStatusController {
  let status: TerminalPluginPublicStatus = {
    phase: "initializing", pluginId: options.pluginId, engineId: options.engineId,
    rendererId: options.rendererId, rendererProfile: options.rendererProfile,
    recoveryOutcome: "fresh", fidelity: "unavailable", failure: null,
    hostPixels: { width: 0, height: 0 }, requested: null, pty: null, recovery: null,
    rendered: null, operation: "initializing", presentation: options.presentation(),
  };
  const listeners = new Set<(status: TerminalPluginPublicStatus) => void>();
  const publish = (): TerminalPluginPublicStatus => {
    status = { ...status, presentation: options.presentation() };
    options.root.dataset.terminalPhase = status.phase;
    options.root.dataset.terminalRecovery = status.recoveryOutcome;
    options.root.dataset.terminalFidelity = status.fidelity;
    if (status.failure) options.root.dataset.terminalFailure = status.failure.code;
    else delete options.root.dataset.terminalFailure;
    const copy = { ...status, failure: status.failure ? { ...status.failure } : null };
    options.root.dispatchEvent(new CustomEvent("soksak:terminal-status", {
      bubbles: true,
      detail: copy,
    }));
    options.publish(copy);
    for (const listener of listeners) listener(copy);
    return copy;
  };
  publish();
  return {
    set(phase, next = {}) {
      status = {
        ...status, phase,
        ...(next.recoveryOutcome ? { recoveryOutcome: next.recoveryOutcome } : {}),
        ...(next.fidelity ? { fidelity: next.fidelity } : {}),
        ...(next.failure !== undefined ? { failure: next.failure } : {}),
      };
      return publish();
    },
    current: () => ({
      ...status,
      presentation: options.presentation(),
      failure: status.failure ? { ...status.failure } : null,
    }),
    refresh: publish,
    wait(phases, timeoutMs) {
      const accepted = new Set(phases);
      if (accepted.has(status.phase)) return Promise.resolve(this.current());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(onStatus);
          reject(new Error(`terminal phase wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onStatus = (next: TerminalPluginPublicStatus) => {
          if (!accepted.has(next.phase)) return;
          clearTimeout(timer);
          listeners.delete(onStatus);
          resolve(next);
        };
        listeners.add(onStatus);
      });
    },
    close: () => {
      status = { ...status, phase: "closed" };
      return publish();
    },
  };
}
