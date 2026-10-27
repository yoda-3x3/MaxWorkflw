// Visual themes, the same set as wdash's moods. Stored per device and applied to <html data-theme>
// before first paint by the boot script in app/layout.tsx. No attribute = Classic (the original look).

export const THEME_KEY = "workflwpro:theme";

export const THEMES = [
  { id: "classic", label: "Classic", about: "The original dark blue-grey" },
  { id: "hacker", label: "Hacker", about: "Green terminal, scanlines" },
  { id: "defcon", label: "DEFCON", about: "Red alert" },
  { id: "cyberpunk", label: "Cyberpunk", about: "Neon pink and cyan" },
  { id: "amber", label: "Amber", about: "Old-school amber CRT" },
  { id: "midnight", label: "Midnight", about: "Calm dark blue" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

const IDS = new Set<string>(THEMES.map((t) => t.id));

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && IDS.has(v);
}

/** Runs inline in <head> so the right colors are there on the first frame. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t&&t!=="classic"&&${JSON.stringify([...IDS])}.indexOf(t)>=0)document.documentElement.dataset.theme=t}catch(e){}`;

export function applyTheme(t: Theme): void {
  if (t === "classic") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked: the theme still applies for this visit */
  }
}

export function currentTheme(): Theme {
  const t = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return isTheme(t) ? t : "classic";
}
