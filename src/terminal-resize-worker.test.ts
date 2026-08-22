import { describe, expect, it } from "vitest";
import { createTerminalResizeWorker } from "./terminal-resize-worker";

describe("terminal resize worker", () => {
  it("serializes acknowledgements and coalesces a resize burst", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    let runs = 0;
    const worker = createTerminalResizeWorker(async () => {
      runs += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    }, () => undefined);

    worker.request();
    await viWaitFor(() => releases.length === 1);
    worker.request();
    worker.request();
    worker.request();
    expect(runs).toBe(1);
    releases.shift()!();
    await viWaitFor(() => releases.length === 1 && runs === 2);
    expect(maximum).toBe(1);
    releases.shift()!();
    await worker.settled();
    expect(runs).toBe(2);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
