import { describe, expect, it } from "vitest";
import {
  deserializeSplitTree, equalSizes, findSplitTree, insertBeside, leavesOf, mapLeaves, removeLeaf,
  resizeSplitTree, serializeSplitTree, splitLeaf, type SplitTree,
} from "./split-tree";

const leaf = (value: string): SplitTree<string> => ({ type: "leaf", value });

describe("split tree", () => {
  it("splits a leaf, inserts siblings in the same direction, and nests across directions", () => {
    let tree: SplitTree<string> = leaf("a");
    tree = insertBeside(tree, (value) => value === "a", "row", false, "b", "s1");
    expect(tree).toEqual(splitLeaf(leaf("a"), "b", "row", false, "s1"));
    tree = insertBeside(tree, (value) => value === "b", "row", false, "c", "s2");
    expect(tree).toEqual({ type: "split", id: "s1", dir: "row", sizes: [0.5, 0.25, 0.25], children: [leaf("a"), leaf("b"), leaf("c")] });
    expect(findSplitTree(tree, "s2")).toBeNull();
    tree = insertBeside(tree, (value) => value === "a", "col", true, "d", "s3");
    expect(leavesOf(tree)).toEqual(["d", "a", "b", "c"]);
    expect(findSplitTree(tree, "s3")).toMatchObject({ dir: "col", sizes: equalSizes(2) });
    expect(insertBeside(tree, (value) => value === "zz", "row", false, "e", "s4")).toBe(tree);
    expect(mapLeaves(tree, (value) => value.toUpperCase())).toMatchObject({ children: [{ children: [leaf("D"), leaf("A")] }, leaf("B"), leaf("C")] });
  });

  it("removes leaves, collapsing a single remaining child and renormalizing sizes", () => {
    const tree: SplitTree<string> = { type: "split", id: "s1", dir: "row", sizes: [0.5, 0.25, 0.25], children: [leaf("a"), leaf("b"), leaf("c")] };
    expect(removeLeaf(tree, (value) => value === "a")).toEqual({ type: "split", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [leaf("b"), leaf("c")] });
    const two = removeLeaf(removeLeaf(tree, (value) => value === "a")!, (value) => value === "c");
    expect(two).toEqual(leaf("b"));
    expect(removeLeaf(leaf("b"), (value) => value === "b")).toBeNull();
    expect(resizeSplitTree(tree, "s1", [0.2, 0.3, 0.5])).toMatchObject({ sizes: [0.2, 0.3, 0.5] });
    expect(() => resizeSplitTree(tree, "s1", [1])).toThrow("3 children");
  });

  it("serializes and deserializes, refusing malformed input", () => {
    const tree: SplitTree<string> = { type: "split", id: "s1", dir: "col", sizes: [0.5, 0.5], children: [leaf("a"), { type: "split", id: "s2", dir: "row", sizes: [0.3, 0.7], children: [leaf("b"), leaf("c")] }] };
    const wire = serializeSplitTree(tree);
    expect(wire).toEqual({ t: "s", id: "s1", dir: "col", sizes: [0.5, 0.5], children: [{ t: "l", v: "a" }, { t: "s", id: "s2", dir: "row", sizes: [0.3, 0.7], children: [{ t: "l", v: "b" }, { t: "l", v: "c" }] }] });
    expect(deserializeSplitTree(JSON.parse(JSON.stringify(wire)))).toEqual(tree);
    expect(deserializeSplitTree({ t: "l", v: "" })).toBeNull();
    expect(deserializeSplitTree({ t: "s", id: "x", dir: "row", sizes: [1], children: [{ t: "l", v: "a" }] })).toBeNull();
    expect(deserializeSplitTree({ t: "s", id: "x", dir: "diag", sizes: [0.5, 0.5], children: [{ t: "l", v: "a" }, { t: "l", v: "b" }] })).toBeNull();
    expect(deserializeSplitTree({ t: "s", id: "x", dir: "row", sizes: [0.5, -1], children: [{ t: "l", v: "a" }, { t: "l", v: "b" }] })).toBeNull();
    expect(deserializeSplitTree(null)).toBeNull();
  });
});
