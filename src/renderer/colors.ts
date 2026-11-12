// Status palette — single source for the add-on's status colors so a tweak
// doesn't mean hunting hex/rgba literals across every screen. Use `tint()` for
// the translucent backgrounds/borders (it returns the same rgba() strings the
// screens used inline).

export const STATUS = {
  success: '#50c083', // green — pull / complete
  danger: '#d04d5c', // red — errors / production overwrite
  warning: '#fcc419', // amber — push / caution
  linked: '#51cf66', // green — linked / link success accent (link drawer)
} as const;

// Translate a #rrggbb status color into an rgba() tint for backgrounds/borders.
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
