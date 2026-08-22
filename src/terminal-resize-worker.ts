export type TerminalResizeWorker = {
  request(): void;
  settled(): Promise<void>;
};

export function createTerminalResizeWorker(
  resize: () => Promise<void>,
  failed: (error: unknown) => void,
): TerminalResizeWorker {
  let requested = false;
  let running: Promise<void> | null = null;

  const run = async () => {
    while (requested) {
      requested = false;
      try {
        await resize();
      } catch (error) {
        failed(error);
      }
    }
  };

  return {
    request() {
      requested = true;
      if (!running) running = run().finally(() => { running = null; });
    },
    async settled() {
      while (running) await running;
    },
  };
}
