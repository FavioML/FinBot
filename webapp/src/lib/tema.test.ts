import { describe, it, expect, afterEach } from 'vitest';
import vm from 'node:vm';
import { SCRIPT_TEMA, TEMA_KEY, TEMA_EVENTO, THEME_COLOR, guardarPreferencia, leerPreferencia } from './tema';

// Ejecuta el script inline REAL (el mismo string que va en <head>) contra un DOM falso. Lo que
// importa no es la función, es lo que el navegador corre antes del primer pintado.

type Escuchas = Record<string, Array<(e?: unknown) => void>>;

function montar({ guardado, sistemaOscuro, storageRoto = false, mqForma = 'moderna' }: { guardado?: string; sistemaOscuro: boolean; storageRoto?: boolean; mqForma?: 'moderna' | 'vieja' | 'ninguna' }) {
  const attrs: Record<string, string> = {};
  const style: Record<string, string> = {};
  const metas = [{ content: 'x', setAttribute(_: string, v: string) { this.content = v; } }, { content: 'y', setAttribute(_: string, v: string) { this.content = v; } }];
  const win: Escuchas = {};
  const doc: Escuchas = {};
  const mqEscuchas: Array<() => void> = [];
  const mq: Record<string, unknown> = { matches: sistemaOscuro };
  // Safari < 14 sólo tiene addListener.
  if (mqForma === 'moderna') mq.addEventListener = (_: string, f: () => void) => mqEscuchas.push(f);
  if (mqForma === 'vieja') mq.addListener = (f: () => void) => mqEscuchas.push(f);
  const store = new Map<string, string>(guardado ? [[TEMA_KEY, guardado]] : []);
  const localStorage = {
    getItem: (k: string) => { if (storageRoto) throw new Error('SecurityError'); return store.get(k) ?? null; },
  };
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, style },
    querySelectorAll: () => metas,
    addEventListener: (t: string, f: () => void) => { (doc[t] ||= []).push(f); },
  };
  const window: Record<string, unknown> = {
    matchMedia: mqForma === 'ninguna' ? undefined : () => mq,
    localStorage,
    addEventListener: (t: string, f: (e?: unknown) => void) => { (win[t] ||= []).push(f); },
  };
  vm.runInNewContext(SCRIPT_TEMA, { window, document });
  return {
    tema: () => attrs['data-theme'],
    esquema: () => style.colorScheme,
    metas,
    store,
    window,
    cambiarSistema(oscuro: boolean) { mq.matches = oscuro; mqEscuchas.forEach((f) => f()); },
    disparar(t: string, e?: unknown) { (win[t] || []).forEach((f) => f(e)); },
    domListo() { (doc.DOMContentLoaded || []).forEach((f) => f()); },
  };
}

describe('script de tema (inline, antes del primer pintado)', () => {
  it('sin preferencia guardada sigue al sistema', () => {
    expect(montar({ sistemaOscuro: true }).tema()).toBe('dark');
    expect(montar({ sistemaOscuro: false }).tema()).toBe('light');
  });

  it('una preferencia explícita le gana al sistema', () => {
    expect(montar({ guardado: 'light', sistemaOscuro: true }).tema()).toBe('light');
    expect(montar({ guardado: 'dark', sistemaOscuro: false }).tema()).toBe('dark');
  });

  it('un valor basura cuenta como "sistema"', () => {
    expect(montar({ guardado: 'neon', sistemaOscuro: true }).tema()).toBe('dark');
  });

  it('con "sistema" sigue el cambio en vivo; con una elección explícita, no', () => {
    const sis = montar({ sistemaOscuro: false });
    sis.cambiarSistema(true);
    expect(sis.tema()).toBe('dark');
    const fijo = montar({ guardado: 'light', sistemaOscuro: false });
    fijo.cambiarSistema(true);
    expect(fijo.tema()).toBe('light');
  });

  it('el storage que lanza (navegador embebido) no rompe: cae a sistema', () => {
    expect(montar({ storageRoto: true, sistemaOscuro: true }).tema()).toBe('dark');
  });

  it('ajusta color-scheme y pisa los dos theme-color con el tema resuelto', () => {
    const m = montar({ guardado: 'light', sistemaOscuro: true });
    expect(m.esquema()).toBe('light');
    expect(m.metas.map((x) => x.content)).toEqual([THEME_COLOR.light, THEME_COLOR.light]);
  });

  it('reaplica con el evento propio, con storage de su clave y al terminar de parsear', () => {
    const m = montar({ sistemaOscuro: false });
    m.store.set(TEMA_KEY, 'dark');
    m.disparar(TEMA_EVENTO);
    expect(m.tema()).toBe('dark');
    m.store.set(TEMA_KEY, 'light');
    m.disparar('storage', { key: 'otra' });
    expect(m.tema()).toBe('dark');
    m.disparar('storage', { key: TEMA_KEY });
    expect(m.tema()).toBe('light');
    m.metas.forEach((x) => (x.content = 'viejo'));
    m.domListo();
    expect(m.metas[0].content).toBe(THEME_COLOR.light);
  });

  it('con "sistema", los theme-color van al tema resuelto (no a la preferencia)', () => {
    const m = montar({ sistemaOscuro: true });
    expect(m.metas.map((x) => x.content)).toEqual([THEME_COLOR.dark, THEME_COLOR.dark]);
  });

  it('sigue al sistema con la API vieja (addListener) y no se cae sin matchMedia', () => {
    const viejo = montar({ sistemaOscuro: false, mqForma: 'vieja' });
    viejo.cambiarSistema(true);
    expect(viejo.tema()).toBe('dark');
    expect(montar({ sistemaOscuro: false, mqForma: 'ninguna' }).tema()).toBe('light');
  });

  it('una elección en memoria (sin storage) le gana al storage y al sistema', () => {
    const m = montar({ storageRoto: true, sistemaOscuro: true });
    m.window.__netoTema = 'light';
    m.disparar(TEMA_EVENTO);
    expect(m.tema()).toBe('light');
    m.cambiarSistema(true);
    expect(m.tema()).toBe('light');
  });

  it('THEME_COLOR coincide con --background de globals.css en los dos temas', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    const bloque = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    expect(bloque('[data-theme=light] {')).toContain(`--background: ${THEME_COLOR.light};`);
    expect(bloque('[data-theme=dark] {')).toContain(`--background: ${THEME_COLOR.dark};`);
  });
});

// guardarPreferencia/leerPreferencia corren en el navegador; acá con window/document falsos.
describe('guardar y leer la preferencia', () => {
  const original = { window: (globalThis as Record<string, unknown>).window, document: (globalThis as Record<string, unknown>).document };
  afterEach(() => {
    (globalThis as Record<string, unknown>).window = original.window;
    (globalThis as Record<string, unknown>).document = original.document;
  });

  function entorno({ storageRoto = false, inicial }: { storageRoto?: boolean; inicial?: string } = {}) {
    const store = new Map<string, string>(inicial ? [[TEMA_KEY, inicial]] : []);
    const eventos: string[] = [];
    const roto = () => { throw new Error('SecurityError'); };
    const win: Record<string, unknown> = {
      localStorage: storageRoto
        ? { getItem: roto, setItem: roto, removeItem: roto }
        : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      dispatchEvent: (e: Event) => { eventos.push(e.type); return true; },
    };
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = { documentElement: { getAttribute: () => 'dark' } };
    return { store, eventos, win };
  }

  it('guarda, avisa con el evento y "sistema" borra la clave', () => {
    const e = entorno();
    guardarPreferencia('light');
    expect(e.store.get(TEMA_KEY)).toBe('light');
    expect(leerPreferencia()).toBe('light');
    guardarPreferencia('system');
    expect(e.store.has(TEMA_KEY)).toBe(false);
    expect(leerPreferencia()).toBe('system');
    expect(e.eventos).toEqual([TEMA_EVENTO, TEMA_EVENTO]);
  });

  it('un valor basura guardado se lee como "sistema"', () => {
    entorno({ inicial: 'neon' });
    expect(leerPreferencia()).toBe('system');
  });

  it('sin storage la elección queda en memoria, se lee y SIGUE avisando', () => {
    const e = entorno({ storageRoto: true });
    guardarPreferencia('light');
    expect(e.win.__netoTema).toBe('light');
    expect(leerPreferencia()).toBe('light');
    expect(e.eventos).toEqual([TEMA_EVENTO]);
    guardarPreferencia('system');
    expect(e.win.__netoTema).toBeUndefined();
    expect(leerPreferencia()).toBe('system');
  });
});
