// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createProviderFramePresenter } from "./provider-frame-presenter";

describe("provider frame presenter", () => {
  it("publishes operable nodes, accessible text, cursor state, and input", () => {
    const root = document.createElement("div"); document.body.append(root);
    const send = vi.fn(); const presenter = createProviderFramePresenter(root, send);
    presenter.render({ cols: 4, rows: 2, cursor: [1, 0], alt_active: true, lines: [
      [{ text: "A", fg: "default", bg: "default", attrs: 0, wide: false }],
      [{ text: "가", fg: "#ffffff", bg: "default", attrs: 1, wide: true }],
    ] });
    expect(presenter.read()).toBe("A\n가"); expect(presenter.screen.getAttribute("role")).toBe("log");
    expect(presenter.screen.dataset.cursorRow).toBe("1"); expect(presenter.focus()).toBe(true);
    expect(presenter.size()).toEqual({ cols: 4, rows: 2 });
    expect(presenter.screen.querySelector('[data-cursor="true"]')?.textContent).toBe("가");
    expect(root.querySelector('[data-node="terminal-restore-status"]')).not.toBeNull();
    presenter.input.value = "x"; presenter.input.dispatchEvent(new Event("input")); expect(send).toHaveBeenCalledWith("x");
  });

  it("waits for rendered text without sampling", async () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    const found = presenter.waitForText("ready", 100);
    presenter.render({ cols: 5, rows: 1, cursor: [0, 0], alt_active: false, lines: [[
      { text: "ready", fg: "default", bg: "default", attrs: 0, wide: false },
    ]] });
    await expect(found).resolves.toContain("ready");
  });
});
