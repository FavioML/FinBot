// Los colores semánticos llegan a JS como `var(--positive)`, no como hex. Pegarles un alfa con
// `${color}1F` (lo que se hacía con hex) produce `var(--positive)1F`, que el navegador descarta
// sin avisar. Este es el reemplazo: funciona con un var(), un hex o cualquier color CSS.
export function conAlfa(color: string, porcentaje: number): string {
  return `color-mix(in srgb, ${color} ${porcentaje}%, transparent)`;
}

const CON_INK = ['primary', 'positive', 'negative', 'destructive', 'warning', 'accent-pro', 'info'];

/**
 * El color de TEXTO que va sobre un tinte de `color`: `var(--warning)` → `var(--warning-ink)`.
 * En claro, el color base sobre su propio tinte no llega a 4.5:1 (ver `--*-ink` en globals.css).
 * Cualquier otro color se devuelve igual.
 */
export function tinta(color: string): string {
  const m = color.match(/^var\(--([a-z-]+)\)$/);
  return m && CON_INK.includes(m[1]) ? `var(--${m[1] === 'destructive' ? 'negative' : m[1]}-ink)` : color;
}
