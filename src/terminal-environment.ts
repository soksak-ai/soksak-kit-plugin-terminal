export interface TerminalCommandExecutor {
  execute?(name: string, params?: Record<string, unknown>): Promise<unknown>;
}

export async function terminalLoginShell(commands?: TerminalCommandExecutor): Promise<string> {
  const executed = await commands?.execute?.("app.environment", {});
  const data = executed && typeof executed === "object" && "data" in executed
    ? (executed as { data?: unknown }).data : executed;
  const shell = data && typeof data === "object"
    ? (data as { loginShell?: unknown }).loginShell : undefined;
  if (typeof shell !== "string" || shell === "") {
    throw new Error("app.environment returned no login shell");
  }
  return shell;
}
