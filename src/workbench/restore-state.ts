import { deserializeSplitTree, type SerializedSplitTree } from "./split-tree";

export interface WorkbenchRestorePane { key: string; engineId: string; title: string | null; cwd: string | null }
export interface WorkbenchRestoreState {
  version: 1;
  tree: SerializedSplitTree;
  focused: string;
  maximized: string | null;
  broadcast: boolean;
  next: number;
  panes: WorkbenchRestorePane[];
}

export function parseRestoreState(value: unknown): WorkbenchRestoreState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!deserializeSplitTree(record.tree)) return null;
  if (typeof record.focused !== "string") return null;
  const maximized = record.maximized ?? null;
  if (maximized !== null && typeof maximized !== "string") return null;
  const broadcast = typeof record.broadcast === "boolean" ? record.broadcast : false;
  if (typeof record.next !== "number" || !Number.isInteger(record.next) || record.next < 1) return null;
  if (!Array.isArray(record.panes)) return null;
  const panes: WorkbenchRestorePane[] = [];
  for (const entry of record.panes) {
    if (!entry || typeof entry !== "object") return null;
    const pane = entry as Record<string, unknown>;
    if (typeof pane.key !== "string" || typeof pane.engineId !== "string") return null;
    const title = pane.title ?? null;
    const cwd = pane.cwd ?? null;
    if ((title !== null && typeof title !== "string") || (cwd !== null && typeof cwd !== "string")) return null;
    panes.push({ key: pane.key, engineId: pane.engineId, title, cwd });
  }
  return {
    version: 1, tree: record.tree as SerializedSplitTree, focused: record.focused,
    maximized, broadcast, next: record.next, panes,
  };
}
