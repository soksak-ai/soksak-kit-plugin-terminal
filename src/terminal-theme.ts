import {
  emptyTerminalThemeOverrides,
  resolveTerminalTheme,
  TERMINAL_ANSI_PALETTE,
  TERMINAL_THEME_CONTRACT,
  type TerminalThemePalette,
  type TerminalThemeStatus,
} from "@soksak/soksak-contract-plugin-terminal";

type TerminalThemeRole = "foreground" | "background" | "cursor" | "cursorAccent" | "selectionBackground";

const cssVariable = (name: string): string => `var(${name})`;

export function bindTerminalThemeSurface(screen: HTMLElement): void {
  screen.style.color = cssVariable(TERMINAL_THEME_CONTRACT.tokens.foreground);
  screen.style.backgroundColor = cssVariable(TERMINAL_THEME_CONTRACT.tokens.background);
  screen.style.setProperty(
    TERMINAL_THEME_CONTRACT.properties.cursor,
    cssVariable(TERMINAL_THEME_CONTRACT.tokens.cursor),
  );
  screen.style.setProperty(
    TERMINAL_THEME_CONTRACT.properties.cursorAccent,
    cssVariable(TERMINAL_THEME_CONTRACT.tokens.cursorAccent),
  );
  screen.style.setProperty(
    TERMINAL_THEME_CONTRACT.properties.selectionBackground,
    cssVariable(TERMINAL_THEME_CONTRACT.tokens.selectionBackground),
  );
  TERMINAL_ANSI_PALETTE.forEach((color, index) => {
    screen.style.setProperty(`${TERMINAL_THEME_CONTRACT.properties.ansiPrefix}${index}`, color);
  });
}

export function readTerminalTheme(root: HTMLElement): TerminalThemePalette {
  const style = getComputedStyle(root);
  const read = (role: TerminalThemeRole): string => {
    const value = style.getPropertyValue(TERMINAL_THEME_CONTRACT.tokens[role]).trim();
    if (!value) throw new Error(`terminal theme token ${TERMINAL_THEME_CONTRACT.tokens[role]} is empty`);
    return value;
  };
  return {
    foreground: read("foreground"),
    background: read("background"),
    cursor: read("cursor"),
    cursorAccent: read("cursorAccent"),
    selectionBackground: read("selectionBackground"),
    ansi: [...TERMINAL_ANSI_PALETTE],
  };
}

export function readTerminalThemeStatus(root: HTMLElement): TerminalThemeStatus {
  const baseTheme = readTerminalTheme(root);
  const terminalOverrides = emptyTerminalThemeOverrides();
  return {
    themeMode: "light",
    baseTheme,
    terminalOverrides,
    effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
  };
}

export function publishTerminalThemeStatus(
  _root: HTMLElement,
  _screen: HTMLElement | null,
  _pane: string,
  status: TerminalThemeStatus,
): TerminalThemeStatus {
  return status;
}

export function observeTerminalTheme(root: HTMLElement, onChange: () => void): () => void {
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-theme-epoch")) onChange();
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme-epoch"] });
  return () => observer.disconnect();
}
