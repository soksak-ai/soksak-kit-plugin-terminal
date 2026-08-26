export type SplitDir = "row" | "col";
export type SplitTree<L> =
  | { type: "leaf"; value: L }
  | { type: "split"; id: string; dir: SplitDir; sizes: number[]; children: SplitTree<L>[] };
export type SplitNode<L> = Extract<SplitTree<L>, { type: "split" }>;
export type SerializedSplitTree =
  | { t: "l"; v: string }
  | { t: "s"; id: string; dir: SplitDir; sizes: number[]; children: SerializedSplitTree[] };

export function equalSizes(count: number): number[] {
  return count <= 0 ? [] : Array.from({ length: count }, () => 1 / count);
}

export function splitLeaf<L>(leaf: SplitTree<L>, fresh: L, dir: SplitDir, before: boolean, id: string): SplitNode<L> {
  const added: SplitTree<L> = { type: "leaf", value: fresh };
  return { type: "split", id, dir, sizes: equalSizes(2), children: before ? [added, leaf] : [leaf, added] };
}

export function leavesOf<L>(tree: SplitTree<L>): L[] {
  return tree.type === "leaf" ? [tree.value] : tree.children.flatMap((child) => leavesOf(child));
}

export function mapLeaves<L, M>(tree: SplitTree<L>, map: (value: L) => M): SplitTree<M> {
  return tree.type === "leaf"
    ? { type: "leaf", value: map(tree.value) }
    : { ...tree, children: tree.children.map((child) => mapLeaves(child, map)) };
}

export function findSplitTree<L>(tree: SplitTree<L>, id: string): SplitNode<L> | null {
  if (tree.type === "leaf") return null;
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findSplitTree(child, id);
    if (found) return found;
  }
  return null;
}

export function resizeSplitTree<L>(tree: SplitTree<L>, id: string, sizes: number[]): SplitTree<L> {
  if (tree.type === "leaf") return tree;
  if (tree.id === id) {
    if (sizes.length !== tree.children.length) {
      throw new Error(`split ${id} has ${tree.children.length} children, not ${sizes.length}`);
    }
    return { ...tree, sizes: [...sizes] };
  }
  return { ...tree, children: tree.children.map((child) => resizeSplitTree(child, id, sizes)) };
}

// null when nothing remains; a split left with one child collapses into that child.
export function removeLeaf<L>(tree: SplitTree<L>, matches: (value: L) => boolean): SplitTree<L> | null {
  if (tree.type === "leaf") return matches(tree.value) ? null : tree;
  const kept: SplitTree<L>[] = [];
  const sizes: number[] = [];
  tree.children.forEach((child, index) => {
    const next = removeLeaf(child, matches);
    if (!next) return;
    kept.push(next);
    sizes.push(tree.sizes[index] ?? 0);
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { ...tree, children: kept, sizes: total > 0 ? sizes.map((size) => size / total) : equalSizes(kept.length) };
}

function insertInto<L>(
  node: SplitTree<L>, matches: (value: L) => boolean, dir: SplitDir, before: boolean, fresh: L, newSplitId: string,
): SplitTree<L> | null {
  if (node.type === "leaf") return matches(node.value) ? splitLeaf(node, fresh, dir, before, newSplitId) : null;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === "leaf" && matches(child.value) && node.dir === dir) {
      // Same direction: the new pane becomes a sibling and takes half of the target's share.
      const share = (node.sizes[index] ?? 0) / 2;
      const sizes = [...node.sizes];
      sizes[index] = share;
      const at = before ? index : index + 1;
      sizes.splice(at, 0, share);
      const children = [...node.children];
      children.splice(at, 0, { type: "leaf", value: fresh });
      return { ...node, sizes, children };
    }
    const replaced = insertInto(child, matches, dir, before, fresh, newSplitId);
    if (replaced) {
      const children = [...node.children];
      children[index] = replaced;
      return { ...node, children };
    }
  }
  return null;
}

// The tree is returned unchanged when no leaf matches.
export function insertBeside<L>(
  tree: SplitTree<L>, matches: (value: L) => boolean, dir: SplitDir, before: boolean, fresh: L, newSplitId: string,
): SplitTree<L> {
  return insertInto(tree, matches, dir, before, fresh, newSplitId) ?? tree;
}

export function serializeSplitTree(tree: SplitTree<string>): SerializedSplitTree {
  return tree.type === "leaf"
    ? { t: "l", v: tree.value }
    : { t: "s", id: tree.id, dir: tree.dir, sizes: [...tree.sizes], children: tree.children.map(serializeSplitTree) };
}

export function deserializeSplitTree(value: unknown): SplitTree<string> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.t === "l") return typeof record.v === "string" && record.v !== "" ? { type: "leaf", value: record.v } : null;
  if (record.t !== "s") return null;
  if (typeof record.id !== "string" || (record.dir !== "row" && record.dir !== "col")) return null;
  if (!Array.isArray(record.children) || !Array.isArray(record.sizes) || record.children.length < 2) return null;
  if (record.sizes.length !== record.children.length) return null;
  if (!record.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) return null;
  const children: SplitTree<string>[] = [];
  for (const child of record.children) {
    const parsed = deserializeSplitTree(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return { type: "split", id: record.id, dir: record.dir, sizes: [...(record.sizes as number[])], children };
}
