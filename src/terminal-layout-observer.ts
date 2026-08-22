export interface TerminalLayoutEvents {
  on(event: "layout.reflow", callback: () => void): { dispose(): void };
}

interface TerminalLayoutObserverOptions {
  element: Element;
  resized(): void;
  events?: TerminalLayoutEvents;
  createResizeObserver?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "disconnect">;
}

export function observeTerminalLayout(options: TerminalLayoutObserverOptions): { dispose(): void } {
  const create = options.createResizeObserver ?? ((callback) => new ResizeObserver(callback));
  const observer = create(() => options.resized());
  observer.observe(options.element);
  const reflow = options.events?.on("layout.reflow", options.resized);
  return {
    dispose() {
      observer.disconnect();
      reflow?.dispose();
    },
  };
}
