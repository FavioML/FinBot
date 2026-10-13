// Tema claro/oscuro sin JS en el bundle (12-oct-2026, paleta B).
//
// Por qué no `next-themes`: es un provider de cliente y tendría que ir en `app/layout.tsx`, que es
// superficie de bundle de `/login` (ver el comentario de ese archivo). Lo que hace falta cabe en un
// script inline: aplicar el tema ANTES del primer pintado (el dashboard es un shell estático
// prerenderizado, así que no hay servidor que sepa el tema), seguir al sistema en vivo y enterarse
// de las otras pestañas.
//
// El tema se escribe en `data-theme` de <html>, no en `class`: el `className` de <html> lo maneja
// React (la variable de la fuente) y no conviene competir con él.
//
// UNA sola implementación: `iniciarTema` se serializa con `toString()` dentro del script inline, y
// el resto de la app no reaplica nada por su cuenta, sólo escribe la preferencia y dispara el
// evento `neto-tema`, que escucha ese mismo script. Dos copias de "cómo se resuelve el tema"
// terminarían diciendo cosas distintas.

export const TEMA_KEY = 'neto_tema';
export const TEMA_EVENTO = 'neto-tema';
/**
 * Dónde queda la elección cuando localStorage no existe o lanza (navegador embebido, modo
 * privado, cuota llena). El script la lee ANTES que el storage: sin esto, el siguiente evento
 * (otro componente que monta, un cambio del sistema) releía 'system' y deshacía la elección.
 */
export const TEMA_MEMORIA = '__netoTema';

declare global {
  interface Window {
    __netoTema?: TemaResuelto;
  }
}

export type PreferenciaTema = 'light' | 'dark' | 'system';
export type TemaResuelto = 'light' | 'dark';

/** Color de la barra del navegador / barra de estado por tema. Mismo valor que `--background`. */
export const THEME_COLOR: Record<TemaResuelto, string> = { light: '#EDF5F0', dark: '#07120E' };

/**
 * Corre dentro del script inline de `<head>`. Tiene que ser autocontenida (se serializa) y
 * escrita en JS que un navegador embebido actual entienda (ES2015: const/let, sin optional chaining).
 */
function iniciarTema(key: string, colores: Record<string, string>, evento: string, memoria: string) {
  const d = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function leer() {
    const m = (window as unknown as Record<string, unknown>)[memoria];
    if (m === 'light' || m === 'dark') return m;
    try {
      const v = window.localStorage.getItem(key);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }
  function aplicar() {
    const p = leer();
    const t = p === 'system' ? (mq && mq.matches ? 'dark' : 'light') : p;
    d.setAttribute('data-theme', t);
    d.style.colorScheme = t;
    // Los <meta name="theme-color"> traen `media` por esquema del SISTEMA. Si el usuario eligió
    // lo contrario, la barra del navegador quedaría del otro color: se pisan los dos.
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    for (let i = 0; i < metas.length; i++) metas[i].setAttribute('content', colores[t]);
  }
  aplicar();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', aplicar);
    else if (mq.addListener) mq.addListener(aplicar);
  }
  window.addEventListener('storage', function (e) {
    if (e.key === key) aplicar();
  });
  window.addEventListener(evento, aplicar);
  // El script corre en <head> y los <meta> de viewport pueden venir después en el documento.
  document.addEventListener('DOMContentLoaded', aplicar);
}

export const SCRIPT_TEMA = `(${iniciarTema.toString()})(${JSON.stringify(TEMA_KEY)},${JSON.stringify(THEME_COLOR)},${JSON.stringify(TEMA_EVENTO)},${JSON.stringify(TEMA_MEMORIA)})`;

export function leerPreferencia(): PreferenciaTema {
  const m = window[TEMA_MEMORIA];
  if (m === 'light' || m === 'dark') return m;
  try {
    const v = window.localStorage.getItem(TEMA_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function leerTemaResuelto(): TemaResuelto {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Guarda la preferencia y deja que el script inline la aplique. `system` borra la clave. */
export function guardarPreferencia(p: PreferenciaTema) {
  try {
    if (p === 'system') window.localStorage.removeItem(TEMA_KEY);
    else window.localStorage.setItem(TEMA_KEY, p);
    delete window[TEMA_MEMORIA];
  } catch {
    // Sin storage la elección vive en memoria hasta recargar; el script la lee primero.
    if (p === 'system') delete window[TEMA_MEMORIA];
    else window[TEMA_MEMORIA] = p;
  }
  window.dispatchEvent(new Event(TEMA_EVENTO));
}
