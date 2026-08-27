export interface BoundedOutputTail {
  readonly size: number;
  push(chunk: Uint8Array): void;
  snapshot(): Uint8Array;
  clear(): void;
}

export function createBoundedOutputTail(
  capacity: number,
  allocate: (size: number) => Uint8Array = (size) => new Uint8Array(size),
): BoundedOutputTail {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("tail capacity must be a positive integer");
  const storage = allocate(capacity);
  if (storage.length !== capacity) throw new Error("tail allocator returned the wrong capacity");
  let start = 0;
  let length = 0;

  return {
    get size() { return length; },
    push(chunk) {
      if (chunk.length === 0) return;
      if (chunk.length >= capacity) {
        storage.set(chunk.subarray(chunk.length - capacity));
        start = 0;
        length = capacity;
        return;
      }
      const overflow = Math.max(0, length + chunk.length - capacity);
      start = (start + overflow) % capacity;
      length -= overflow;
      const writeAt = (start + length) % capacity;
      const first = Math.min(chunk.length, capacity - writeAt);
      storage.set(chunk.subarray(0, first), writeAt);
      if (first < chunk.length) storage.set(chunk.subarray(first), 0);
      length += chunk.length;
    },
    snapshot() {
      const result = new Uint8Array(length);
      const first = Math.min(length, capacity - start);
      result.set(storage.subarray(start, start + first));
      if (first < length) result.set(storage.subarray(0, length - first), first);
      return result;
    },
    clear() {
      start = 0;
      length = 0;
    },
  };
}
