import { describe, expect, it, vi } from "vitest";
import { createBoundedOutputTail } from "./bounded-output-tail";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

describe("bounded output tail", () => {
  it("allocates one fixed buffer while retaining the newest bytes in order", () => {
    const allocate = vi.fn((size: number) => new Uint8Array(size));
    const tail = createBoundedOutputTail(5, allocate);

    tail.push(bytes("ab"));
    expect(text(tail.snapshot())).toBe("ab");
    tail.push(bytes("cde"));
    expect(text(tail.snapshot())).toBe("abcde");
    tail.push(bytes("fg"));
    expect(text(tail.snapshot())).toBe("cdefg");
    tail.push(bytes("0123456"));
    expect(text(tail.snapshot())).toBe("23456");
    tail.clear();
    expect(tail.snapshot()).toHaveLength(0);
    expect(allocate).toHaveBeenCalledOnce();
    expect(allocate).toHaveBeenCalledWith(5);
  });
});
