import { equalSizes, findSplitTree, leavesOf, resizeSplitTree, type SplitDir, type SplitTree } from "./split-tree";

export interface LayoutRect { x: number; y: number; width: number; height: number }
export interface PaneLayout { key: string; rect: LayoutRect }
export type GutterSide = "right" | "bottom";
export type PaneDirection = "left" | "right" | "up" | "down";
export interface GutterLayout { owner: string; side: GutterSide; splitId: string; index: number; rect: LayoutRect }
// spanPx: the pixels shared by the children, gutters excluded.
export interface SplitBoxLayout { id: string; dir: SplitDir; rect: LayoutRect; spanPx: number }
export interface SplitLayoutPx { panes: PaneLayout[]; gutters: GutterLayout[]; splits: SplitBoxLayout[] }

export function computeSplitLayoutPx(tree: SplitTree<string>, rect: LayoutRect, gutterPx: number): SplitLayoutPx {
  const panes: PaneLayout[] = [];
  const gutters: GutterLayout[] = [];
  const splits: SplitBoxLayout[] = [];
  const walk = (node: SplitTree<string>, area: LayoutRect) => {
    if (node.type === "leaf") {
      panes.push({ key: node.value, rect: area });
      return;
    }
    const row = node.dir === "row";
    const count = node.children.length;
    const span = row ? area.width : area.height;
    const shared = Math.max(0, span - gutterPx * (count - 1));
    splits.push({ id: node.id, dir: node.dir, rect: area, spanPx: shared });
    const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
    let cursor = row ? area.x : area.y;
    let used = 0;
    node.children.forEach((child, index) => {
      const last = index === count - 1;
      // The last child takes the remainder so children plus gutters equal the span exactly.
      const size = last ? shared - used : Math.max(0, Math.round((shared * (node.sizes[index] ?? 0)) / total));
      used += size;
      walk(child, row
        ? { x: cursor, y: area.y, width: size, height: area.height }
        : { x: area.x, y: cursor, width: area.width, height: size });
      cursor += size;
      if (last) return;
      gutters.push({
        owner: leavesOf(child)[0], side: row ? "right" : "bottom", splitId: node.id, index,
        rect: row
          ? { x: cursor, y: area.y, width: gutterPx, height: area.height }
          : { x: area.x, y: cursor, width: area.width, height: gutterPx },
      });
      cursor += gutterPx;
    });
  };
  walk(tree, rect);
  return { panes, gutters, splits };
}

function pathTo(tree: SplitTree<string>, key: string): Array<{ node: Extract<SplitTree<string>, { type: "split" }>; index: number }> | null {
  if (tree.type === "leaf") return tree.value === key ? [] : null;
  for (let index = 0; index < tree.children.length; index += 1) {
    const below = pathTo(tree.children[index], key);
    if (below) return [{ node: tree, index }, ...below];
  }
  return null;
}

// The gutter touching one side of a pane: the nearest ancestor split in that axis where the pane's
// branch has a neighbor on that side.
export function resolveGutter(
  tree: SplitTree<string>, key: string, side: GutterSide | "left" | "top",
): { splitId: string; index: number } | null {
  const wanted: SplitDir = side === "right" || side === "left" ? "row" : "col";
  const after = side === "right" || side === "bottom";
  const path = pathTo(tree, key);
  if (!path) return null;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const { node, index } = path[depth];
    if (node.dir !== wanted) continue;
    if (after && index < node.children.length - 1) return { splitId: node.id, index };
    if (!after && index > 0) return { splitId: node.id, index: index - 1 };
  }
  return null;
}

export function applyGutterDelta(
  tree: SplitTree<string>, splitId: string, index: number, deltaPx: number, spanPx: number,
  minPx: number = Math.min(50, spanPx / 2),
): SplitTree<string> {
  const node = findSplitTree(tree, splitId);
  if (!node || index < 0 || index >= node.children.length - 1 || spanPx <= 0) return tree;
  const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
  const px = node.sizes.map((size) => (size / total) * spanPx);
  const pair = px[index] + px[index + 1];
  const floor = Math.min(minPx, pair / 2);
  const first = Math.max(floor, Math.min(pair - floor, px[index] + deltaPx));
  px[index] = first;
  px[index + 1] = pair - first;
  return resizeSplitTree(tree, splitId, px.map((value) => value / spanPx));
}

export function equalizeSplitTree(tree: SplitTree<string>): SplitTree<string> {
  return tree.type === "leaf"
    ? tree
    : { ...tree, sizes: equalSizes(tree.children.length), children: tree.children.map(equalizeSplitTree) };
}

// The pane across a gutter in one direction: facing edges within gutterPx, the largest
// perpendicular overlap wins, ties go to the smallest top (or left).
export function neighborOf(panes: PaneLayout[], from: string, dir: PaneDirection, gutterPx: number): string | null {
  const origin = panes.find((pane) => pane.key === from)?.rect;
  if (!origin) return null;
  const horizontal = dir === "left" || dir === "right";
  let best: string | null = null;
  let bestOverlap = 0;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const candidate of panes) {
    if (candidate.key === from) continue;
    const r = candidate.rect;
    const gap = dir === "right" ? r.x - (origin.x + origin.width)
      : dir === "left" ? origin.x - (r.x + r.width)
      : dir === "down" ? r.y - (origin.y + origin.height)
      : origin.y - (r.y + r.height);
    if (gap < 0 || gap > gutterPx) continue;
    const overlap = horizontal
      ? Math.min(origin.y + origin.height, r.y + r.height) - Math.max(origin.y, r.y)
      : Math.min(origin.x + origin.width, r.x + r.width) - Math.max(origin.x, r.x);
    if (overlap <= 0) continue;
    const order = horizontal ? r.y : r.x;
    if (overlap > bestOverlap || (overlap === bestOverlap && order < bestOrder)) {
      best = candidate.key;
      bestOverlap = overlap;
      bestOrder = order;
    }
  }
  return best;
}
