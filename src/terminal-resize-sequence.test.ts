import { describe, expect, it } from "vitest";
import { resizeRequestIsCurrent } from "./terminal-resize-sequence";

describe("terminal resize sequence", () => {
  it("accepts only the newest live request", () => {
    expect(resizeRequestIsCurrent(2, 2, false)).toBe(true);
    expect(resizeRequestIsCurrent(1, 2, false)).toBe(false);
    expect(resizeRequestIsCurrent(2, 2, true)).toBe(false);
  });
});
