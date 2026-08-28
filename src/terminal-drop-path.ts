const control = /[\0\r\n]/;

export function quoteTerminalDropPath(path: string, loginShell: string): string {
  if (!path || control.test(path)) throw new Error("drop path contains a control character");
  const shell = loginShell.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  if (["sh", "bash", "dash", "ksh", "zsh"].includes(shell)) {
    return `'${path.replaceAll("'", `'\\''`)}'`;
  }
  if (shell === "fish") return `'${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (["pwsh", "pwsh.exe", "powershell", "powershell.exe"].includes(shell)) {
    return `'${path.replaceAll("'", "''")}'`;
  }
  if (shell === "cmd" || shell === "cmd.exe") {
    if (path.includes('"')) throw new Error("drop path contains a cmd quote");
    return `"${path}"`;
  }
  throw new Error(`unsupported drop shell: ${loginShell}`);
}
