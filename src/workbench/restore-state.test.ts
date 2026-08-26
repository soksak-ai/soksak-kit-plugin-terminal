import { describe, expect, it } from "vitest";
import { parseRestoreState } from "./restore-state";

describe("workbench restore state", () => {
  it("accepts the versioned shape and refuses anything else", () => {
    const state = {
      version: 1,
      tree: { t: "s", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [{ t: "l", v: "tab-a.1" }, { t: "l", v: "tab-a.3" }] },
      focused: "tab-a.3", maximized: null, broadcast: true, next: 4,
      panes: [
        { key: "tab-a.1", engineId: "vt100", title: "one", cwd: "/a" },
        { key: "tab-a.3", engineId: "vt220" },
      ],
    };
    expect(parseRestoreState(JSON.parse(JSON.stringify(state)))).toEqual({
      ...state,
      panes: [state.panes[0], { key: "tab-a.3", engineId: "vt220", title: null, cwd: null }],
    });
    expect(parseRestoreState(null)).toBeNull();
    expect(parseRestoreState({ ...state, version: 2 })).toBeNull();
    expect(parseRestoreState({ ...state, tree: { t: "l", v: "" } })).toBeNull();
    expect(parseRestoreState({ ...state, focused: 1 })).toBeNull();
    expect(parseRestoreState({ ...state, maximized: 3 })).toBeNull();
    expect(parseRestoreState({ ...state, next: 0 })).toBeNull();
    expect(parseRestoreState({ ...state, panes: [{ key: "x" }] })).toBeNull();
    expect(parseRestoreState({ ...state, panes: [{ key: "x", engineId: "e", title: 4 }] })).toBeNull();
    expect(parseRestoreState({ ...state, broadcast: undefined })).toMatchObject({ broadcast: false });
  });
});
