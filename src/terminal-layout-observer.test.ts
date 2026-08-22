import { describe, expect, it, vi } from "vitest";
import { observeTerminalLayout } from "./terminal-layout-observer";

describe("terminal layout observer", () => {
  it("uses host reflow when ResizeObserver does not fire", () => {
    let reflow: (() => void) | undefined;
    const resized = vi.fn();
    const disconnected = vi.fn();
    const disposed = vi.fn();
    const observer = observeTerminalLayout({
      element: {} as Element, resized,
      createResizeObserver: () => ({ observe() {}, disconnect: disconnected }),
      events: { on: (_event, callback) => { reflow = callback; return { dispose: disposed }; } },
    });
    reflow!();
    expect(resized).toHaveBeenCalledTimes(1);
    observer.dispose();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("may deliver post-commit reflow separately from ResizeObserver bursts", () => {
    let resize: (() => void) | undefined;
    let reflow: (() => void) | undefined;
    const resized = vi.fn();
    const reflowed = vi.fn();
    observeTerminalLayout({
      element: {} as Element, resized, reflowed,
      createResizeObserver: (callback) => { resize = () => callback([], {} as ResizeObserver); return { observe() {}, disconnect() {} }; },
      events: { on: (_event, callback) => { reflow = callback; return { dispose() {} }; } },
    });
    resize!();
    reflow!();
    expect(resized).toHaveBeenCalledOnce();
    expect(reflowed).toHaveBeenCalledOnce();
  });
});
