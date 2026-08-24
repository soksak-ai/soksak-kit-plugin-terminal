// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createProviderFramePresenter } from "./provider-frame-presenter";

describe("provider frame presenter", () => {
  it("publishes operable nodes, accessible text, cursor state, and input", () => {
    const root = document.createElement("div"); document.body.append(root);
    const send = vi.fn(); const presenter = createProviderFramePresenter(root, send);
    presenter.render({ cols: 4, rows: 2, cursor: [1, 0], cursor_visible: true, alt_active: true, lines: [
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

  it("transfers a real screen click to the terminal input owner", () => {
    const root = document.createElement("div"); document.body.append(root);
    const presenter = createProviderFramePresenter(root, vi.fn());
    presenter.render({ cols: 1, rows: 1, cursor: [0, 0], cursor_visible: true, alt_active: false, lines: [[]] });
    presenter.screen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(presenter.input);
    expect(presenter.input.dataset.focused).toBe("true");
    expect(presenter.screen.dataset.cursorActive).toBe("true");
    presenter.input.blur();
    const cursor = presenter.screen.querySelector<HTMLElement>('[data-cursor="true"]')!;
    expect(presenter.screen.dataset.cursorActive).toBe("false");
    expect(cursor.style.backgroundColor).toBe("var(--card)");
    expect(cursor.style.outline).toContain("var(--acc)");
  });

  it("uses the canonical palette for indexed colors and host tokens for defaults", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    presenter.render({ cols: 3, rows: 1, cursor: [0, 2], cursor_visible: true, alt_active: false, lines: [[
      { text: "D", fg: "default", bg: "default", attrs: 0, wide: false },
      { text: "R", fg: "palette:1", bg: "palette:0", attrs: 0, wide: false },
      { text: "W", fg: "palette:15", bg: "default", attrs: 0, wide: false },
    ]] });
    const spans = Array.from(presenter.screen.querySelectorAll("span"));
    expect(spans[0].style.color).toBe("var(--fg)");
    expect(spans[0].style.backgroundColor).toBe("var(--card)");
    expect(spans[1].style.color).toBe("rgb(204, 0, 0)");
    expect(spans[1].style.backgroundColor).toBe("rgb(46, 52, 54)");
    expect(spans[2].style.color).toBe("rgb(238, 238, 236)");
  });

  it("preserves row and run nodes when the next frame updates their content", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    const first = { cols: 2, rows: 1, cursor: [0, 1] as [number, number], cursor_visible: true, alt_active: false, lines: [[
      { text: "A", fg: "default", bg: "default", attrs: 0, wide: false },
      { text: "B", fg: "default", bg: "default", attrs: 0, wide: false },
    ]] };
    presenter.render(first);
    const row = presenter.screen.firstElementChild;
    const run = row?.firstElementChild;
    presenter.render({ ...first, lines: [[
      first.lines[0][0], { ...first.lines[0][1], text: "C" },
    ]] });
    expect(presenter.screen.firstElementChild).toBe(row);
    expect(presenter.screen.firstElementChild?.firstElementChild).toBe(run);
    expect(presenter.read()).toBe("AC");
  });

  it("waits for rendered text without sampling", async () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    const found = presenter.waitForText("ready", 100);
    presenter.render({ cols: 5, rows: 1, cursor: [0, 0], cursor_visible: true, alt_active: false, lines: [[
      { text: "ready", fg: "default", bg: "default", attrs: 0, wide: false },
    ]] });
    await expect(found).resolves.toContain("ready");
  });

  it("measures the requested grid independently of the last rendered frame", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "clientWidth", { value: 432 });
    Object.defineProperty(root, "clientHeight", { value: 384 });
    const presenter = createProviderFramePresenter(root, vi.fn());
    presenter.render({ cols: 91, rows: 29, cursor: [0, 0], cursor_visible: true, alt_active: false, lines: [] });
    expect(presenter.size()).toEqual({ cols: 91, rows: 29 });
    expect(presenter.measure()).toEqual({ cols: 54, rows: 24 });
  });
});
