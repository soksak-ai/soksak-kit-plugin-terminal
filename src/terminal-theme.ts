import {
  emptyTerminalThemeOverrides,
  resolveTerminalTheme,
  TERMINAL_ANSI_PALETTE,
  TERMINAL_THEME_CONTRACT,
  TERMINAL_THEME_EVENT,
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
  const mode = root.dataset.themeMode;
  if (mode !== "light" && mode !== "dark") {
    throw new Error("terminal host theme mode must be light or dark");
  }
  const baseTheme = readTerminalTheme(root);
  const terminalOverrides = emptyTerminalThemeOverrides();
  return {
    themeMode: mode,
    baseTheme,
    terminalOverrides,
    effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
  };
}

export function publishTerminalThemeStatus(
  root: HTMLElement,
  screen: HTMLElement | null,
  pane: string,
  status: TerminalThemeStatus,
): TerminalThemeStatus {
  if (status.themeMode !== "light" && status.themeMode !== "dark") {
    throw new Error("terminal themeMode must be light or dark");
  }
  const effectiveTheme = resolveTerminalTheme(status.baseTheme, status.terminalOverrides);
  if (JSON.stringify(effectiveTheme) !== JSON.stringify(status.effectiveTheme)) {
    throw new Error("terminal effectiveTheme does not match baseTheme and terminalOverrides");
  }
  const value: TerminalThemeStatus = {
    themeMode: status.themeMode,
    baseTheme: { ...status.baseTheme, ansi: [...status.baseTheme.ansi] },
    terminalOverrides: { ...status.terminalOverrides, ansi: [...status.terminalOverrides.ansi] },
    effectiveTheme: { ...effectiveTheme, ansi: [...effectiveTheme.ansi] },
  };
  const targets = screen ? [root, screen] : [root];
  for (const target of targets) {
    target.dataset.themeMode = value.themeMode;
    target.dataset.baseTheme = JSON.stringify(value.baseTheme);
    target.dataset.terminalOverrides = JSON.stringify(value.terminalOverrides);
    target.dataset.effectiveTheme = JSON.stringify(value.effectiveTheme);
  }
  if (screen) {
    screen.style.color = value.effectiveTheme.foreground;
    screen.style.backgroundColor = value.effectiveTheme.background;
    screen.style.setProperty(TERMINAL_THEME_CONTRACT.properties.cursor, value.effectiveTheme.cursor);
    screen.style.setProperty(TERMINAL_THEME_CONTRACT.properties.cursorAccent, value.effectiveTheme.cursorAccent);
    screen.style.setProperty(
      TERMINAL_THEME_CONTRACT.properties.selectionBackground,
      value.effectiveTheme.selectionBackground,
    );
    value.effectiveTheme.ansi.forEach((color, index) => {
      screen.style.setProperty(`${TERMINAL_THEME_CONTRACT.properties.ansiPrefix}${index}`, color);
    });
  }
  root.dispatchEvent(new CustomEvent(TERMINAL_THEME_EVENT, {
    bubbles: true,
    detail: { ...value, pane },
  }));
  return value;
}

export function observeTerminalTheme(root: HTMLElement, onChange: () => void): () => void {
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-theme-epoch")) onChange();
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme-epoch"] });
  return () => observer.disconnect();
}
