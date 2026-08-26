import type { PaneDirection } from "./split-layout";

export type WorkbenchAction =
  | { type: "split"; direction: "right" | "down" }
  | { type: "focus.direction"; dir: PaneDirection }
  | { type: "focus.cycle"; delta: 1 | -1 }
  | { type: "resize"; dir: PaneDirection }
  | { type: "maximize.toggle" }
  | { type: "scroll"; lines: number }
  | { type: "scroll.edge"; edge: "top" | "bottom" };

export type KeyChord = Pick<KeyboardEvent, "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">;

const ARROWS: Record<string, PaneDirection> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

// Chords are matched on event.code so a modifier that composes a character does not hide the key.
export function matchKey(event: KeyChord, rows: number): WorkbenchAction | null {
  const { code, metaKey, shiftKey, altKey, ctrlKey } = event;
  const arrow = ARROWS[code];
  if (metaKey && !ctrlKey && !altKey && code === "KeyD") return { type: "split", direction: shiftKey ? "down" : "right" };
  if (metaKey && altKey && !ctrlKey && !shiftKey && arrow) return { type: "focus.direction", dir: arrow };
  if (metaKey && ctrlKey && !altKey && !shiftKey && arrow) return { type: "resize", dir: arrow };
  if (metaKey && !ctrlKey && !altKey && !shiftKey && code === "BracketLeft") return { type: "focus.cycle", delta: -1 };
  if (metaKey && !ctrlKey && !altKey && !shiftKey && code === "BracketRight") return { type: "focus.cycle", delta: 1 };
  if (metaKey && shiftKey && !ctrlKey && !altKey && code === "Enter") return { type: "maximize.toggle" };
  if (shiftKey && !metaKey && !ctrlKey && !altKey) {
    const page = Math.max(1, rows - 1);
    if (code === "PageUp") return { type: "scroll", lines: page };
    if (code === "PageDown") return { type: "scroll", lines: -page };
    if (code === "Home") return { type: "scroll.edge", edge: "top" };
    if (code === "End") return { type: "scroll.edge", edge: "bottom" };
  }
  return null;
}
