import { describe, expect, it } from "vitest";
import { matchKey, type KeyChord } from "./keymap";

const chord = (code: string, mods: Partial<KeyChord> = {}): KeyChord =>
  ({ code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods });

describe("workbench keymap", () => {
  it("maps every chord on event.code and nothing else", () => {
    expect(matchKey(chord("KeyD", { metaKey: true }), 24)).toEqual({ type: "split", direction: "right" });
    expect(matchKey(chord("KeyD", { metaKey: true, shiftKey: true }), 24)).toEqual({ type: "split", direction: "down" });
    expect(matchKey(chord("ArrowLeft", { metaKey: true, altKey: true }), 24)).toEqual({ type: "focus.direction", dir: "left" });
    expect(matchKey(chord("ArrowDown", { metaKey: true, altKey: true }), 24)).toEqual({ type: "focus.direction", dir: "down" });
    expect(matchKey(chord("BracketLeft", { metaKey: true }), 24)).toEqual({ type: "focus.cycle", delta: -1 });
    expect(matchKey(chord("BracketRight", { metaKey: true }), 24)).toEqual({ type: "focus.cycle", delta: 1 });
    expect(matchKey(chord("ArrowRight", { metaKey: true, ctrlKey: true }), 24)).toEqual({ type: "resize", dir: "right" });
    expect(matchKey(chord("Enter", { metaKey: true, shiftKey: true }), 24)).toEqual({ type: "maximize.toggle" });
    expect(matchKey(chord("PageUp", { shiftKey: true }), 24)).toEqual({ type: "scroll", lines: 23 });
    expect(matchKey(chord("PageDown", { shiftKey: true }), 24)).toEqual({ type: "scroll", lines: -23 });
    expect(matchKey(chord("PageUp", { shiftKey: true }), 1)).toEqual({ type: "scroll", lines: 1 });
    expect(matchKey(chord("Home", { shiftKey: true }), 24)).toEqual({ type: "scroll.edge", edge: "top" });
    expect(matchKey(chord("End", { shiftKey: true }), 24)).toEqual({ type: "scroll.edge", edge: "bottom" });
    expect(matchKey(chord("KeyD"), 24)).toBeNull();
    expect(matchKey(chord("KeyD", { metaKey: true, ctrlKey: true }), 24)).toBeNull();
    expect(matchKey(chord("PageUp"), 24)).toBeNull();
    expect(matchKey(chord("PageUp", { shiftKey: true, metaKey: true }), 24)).toBeNull();
    expect(matchKey(chord("KeyW", { metaKey: true }), 24)).toBeNull();
  });
});
