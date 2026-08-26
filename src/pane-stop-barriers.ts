const PANE_STOP_BARRIERS = Symbol.for("soksak.terminal.pane-stop-barriers");

type BarrierMap = Map<string, Promise<void>>;
type BarrierRegistry = Map<string, BarrierMap>;

export function paneStopBarriers(pluginId: string, ownerDocument: Document): BarrierMap {
  const owner = ownerDocument.defaultView;
  if (!owner) throw new Error("terminal owner document has no window");
  const scope = owner as unknown as { [PANE_STOP_BARRIERS]?: BarrierRegistry };
  if (!scope[PANE_STOP_BARRIERS]) {
    Object.defineProperty(scope, PANE_STOP_BARRIERS, {
      value: new Map<string, BarrierMap>(), configurable: true,
    });
  }
  const registry = scope[PANE_STOP_BARRIERS]!;
  const existing = registry.get(pluginId);
  if (existing) return existing;
  const barriers: BarrierMap = new Map();
  registry.set(pluginId, barriers);
  return barriers;
}
