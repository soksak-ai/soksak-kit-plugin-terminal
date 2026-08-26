import { describe, expect, it } from "vitest";
import { applyGutterDelta, computeSplitLayoutPx, equalizeSplitTree, neighborOf, resolveGutter } from "./split-layout";
import type { SplitTree } from "./split-tree";

const leaf = (value: string): SplitTree<string> => ({ type: "leaf", value });
const tree: SplitTree<string> = {
  type: "split", id: "s1", dir: "row", sizes: [0.5, 0.5],
  children: [leaf("a"), { type: "split", id: "s2", dir: "col", sizes: [0.5, 0.5], children: [leaf("b"), leaf("c")] }],
};
const rect = { x: 0, y: 0, width: 800, height: 400 };

describe("split layout", () => {
  it("lays panes and gutters out in pixels so children plus gutters equal the span", () => {
    const layout = computeSplitLayoutPx(tree, rect, 4);
    expect(layout.panes).toEqual([
      { key: "a", rect: { x: 0, y: 0, width: 398, height: 400 } },
      { key: "b", rect: { x: 402, y: 0, width: 398, height: 198 } },
      { key: "c", rect: { x: 402, y: 202, width: 398, height: 198 } },
    ]);
    // Gutters are emitted in walk order: the seam after a child, then that child's own seams.
    expect(layout.gutters).toEqual([
      { owner: "a", side: "right", splitId: "s1", index: 0, rect: { x: 398, y: 0, width: 4, height: 400 } },
      { owner: "b", side: "bottom", splitId: "s2", index: 0, rect: { x: 402, y: 198, width: 398, height: 4 } },
    ]);
    expect(layout.splits).toEqual([
      { id: "s1", dir: "row", rect, spanPx: 796 },
      { id: "s2", dir: "col", rect: { x: 402, y: 0, width: 398, height: 400 }, spanPx: 396 },
    ]);
    const odd = computeSplitLayoutPx({ type: "split", id: "s", dir: "row", sizes: [1, 1, 1], children: [leaf("a"), leaf("b"), leaf("c")] }, { x: 0, y: 0, width: 101, height: 10 }, 3);
    expect(odd.panes.reduce((sum, pane) => sum + pane.rect.width, 0) + 2 * 3).toBe(101);
  });

  it("resolves the gutter at each side of a pane through nested splits", () => {
    expect(resolveGutter(tree, "a", "right")).toEqual({ splitId: "s1", index: 0 });
    expect(resolveGutter(tree, "a", "bottom")).toBeNull();
    expect(resolveGutter(tree, "b", "bottom")).toEqual({ splitId: "s2", index: 0 });
    expect(resolveGutter(tree, "c", "left")).toEqual({ splitId: "s1", index: 0 });
    expect(resolveGutter(tree, "c", "top")).toEqual({ splitId: "s2", index: 0 });
    expect(resolveGutter(tree, "c", "right")).toBeNull();
    expect(resolveGutter(tree, "zz", "right")).toBeNull();
  });

  it("moves a gutter by pixels within the minimum size and equalizes", () => {
    const moved = applyGutterDelta(tree, "s1", 0, 100, 796);
    expect(computeSplitLayoutPx(moved, rect, 4).panes.map((pane) => pane.rect.width)).toEqual([498, 298, 298]);
    const clamped = applyGutterDelta(tree, "s1", 0, -1000, 796);
    expect(computeSplitLayoutPx(clamped, rect, 4).panes[0].rect.width).toBe(50);
    const tiny = applyGutterDelta(tree, "s1", 0, 1000, 60);
    expect(computeSplitLayoutPx(tiny, { x: 0, y: 0, width: 64, height: 10 }, 4).panes[0].rect.width).toBe(30);
    expect(applyGutterDelta(tree, "missing", 0, 10, 796)).toBe(tree);
    expect(applyGutterDelta(tree, "s1", 1, 10, 796)).toBe(tree);
    expect(equalizeSplitTree(moved)).toEqual(tree);
  });

  it("finds the neighbor across a gutter by facing edge, overlap and order", () => {
    const panes = computeSplitLayoutPx(tree, rect, 4).panes;
    expect(neighborOf(panes, "a", "right", 4)).toBe("b");
    expect(neighborOf(panes, "b", "left", 4)).toBe("a");
    expect(neighborOf(panes, "c", "left", 4)).toBe("a");
    expect(neighborOf(panes, "b", "down", 4)).toBe("c");
    expect(neighborOf(panes, "c", "up", 4)).toBe("b");
    expect(neighborOf(panes, "a", "left", 4)).toBeNull();
    expect(neighborOf(panes, "a", "right", 2)).toBeNull();
    expect(neighborOf(panes, "zz", "right", 4)).toBeNull();
    const tall = computeSplitLayoutPx({
      type: "split", id: "s", dir: "row", sizes: [0.5, 0.5],
      children: [leaf("a"), { type: "split", id: "t", dir: "col", sizes: [0.6, 0.4], children: [leaf("b"), leaf("c")] }],
    }, rect, 4).panes;
    expect(neighborOf(tall, "a", "right", 4)).toBe("b");
  });
});
