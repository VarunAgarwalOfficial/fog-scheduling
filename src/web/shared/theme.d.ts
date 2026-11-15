// Types for the shared theme.js (kept byte-identical across the small projects).
export interface Palette {
  bg: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  compare: string;
  change: string;
  good: string;
  visit: string;
  /** The four meaning colours: open, against, measured, proved. */
  series: string[];
}
export function palette(): Palette;
export function onThemeChange(fn: () => void): void;
