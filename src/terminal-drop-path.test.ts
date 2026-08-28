import { describe, expect, it } from "vitest";
import { quoteTerminalDropPath } from "./terminal-drop-path";

describe("terminal file drop path quoting", () => {
  it("quotes each declared login-shell family without a fallback", () => {
    expect(quoteTerminalDropPath("/tmp/it's here", "/bin/zsh")).toBe("'/tmp/it'\\''s here'");
    expect(quoteTerminalDropPath("/tmp/a'b\\c", "/opt/homebrew/bin/fish")).toBe("'/tmp/a\\'b\\\\c'");
    expect(quoteTerminalDropPath("C:\\it's here.txt", "pwsh.exe")).toBe("'C:\\it''s here.txt'");
    expect(quoteTerminalDropPath("C:\\A B\\file.txt", "cmd.exe")).toBe('"C:\\A B\\file.txt"');
  });

  it("refuses unsupported shells and control characters", () => {
    expect(() => quoteTerminalDropPath("/tmp/a\nnext", "/bin/zsh")).toThrow(/control character/);
    expect(() => quoteTerminalDropPath("C:\\a\"b", "cmd.exe")).toThrow(/cmd quote/);
    expect(() => quoteTerminalDropPath("/tmp/a", "/bin/unknown-shell")).toThrow(/unsupported drop shell/);
  });
});
