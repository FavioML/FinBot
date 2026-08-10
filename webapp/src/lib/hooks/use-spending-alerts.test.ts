import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decidirVistaAlertas, type AlertsData } from './use-spending-alerts';

/**
 * F3 (auditoría 10-ago-2026), las dos mitades.
 *
 * `/dashboard/alertas` descartaba `isError` y, con el fetch caído, caía en el estado vacío —que
 * dice **"Todo bien por ahora"** con un escudo verde—. En el Detector de Fugas eso no es una
 * pantalla fea: es decirle a alguien que revisamos y no hay nada, cuando no revisamos nada. Y
 * de paso leía el plan de esa misma respuesta, así que el mismo fallo degradaba a un Pro a Free
 * y le escondía proyecciones y límites que paga.
 *
 * No hay jsdom en esta suite (ver webapp/CLAUDE.md), así que el componente no se renderiza acá.
 * Los dos tests de abajo cubren lo que sí se puede cubrir, y son distintos a propósito:
 * el primero fija la DECISIÓN (función pura, misma idea que `decidirRedirectAuth`), el segundo
 * fija que la página no vuelva a sacar el plan de la respuesta de alertas — que es estático y
 * por lo tanto sí muere si alguien revierte esa línea.
 */

const PAGINA = join(import.meta.dirname, '..', '..', 'app', 'dashboard', 'alertas', 'page.tsx');

const conAlertas = (n: number): AlertsData => ({
  alerts: Array.from({ length: n }, (_, i) => ({
    id: String(i),
    type: 'spike' as const,
    category: null,
    amount: 100,
    comparison_amount: 50,
    message: 'x',
    action_taken: false,
    limit_set: null,
    created_at: '2026-08-10T00:00:00Z',
  })),
  isPro: true,
});

describe('decidirVistaAlertas', () => {
  it('la lectura caída sin cache NO se pinta como "todo bien"', () => {
    expect(decidirVistaAlertas({ isLoading: false, isError: true, data: undefined })).toBe('error');
  });

  it('cero alertas de verdad SÍ es "todo bien"', () => {
    // El contraste es el punto: sin este caso, "error" podría ganarle a la lista siempre y el
    // test de arriba pasaría igual con una función que devuelve 'error' para todo.
    expect(decidirVistaAlertas({ isLoading: false, isError: false, data: conAlertas(0) })).toBe('lista');
  });

  it('un refetch fallido con cache servida no tapa las alertas conocidas', () => {
    expect(decidirVistaAlertas({ isLoading: false, isError: true, data: conAlertas(3) })).toBe('lista');
  });

  it('la primera carga manda sobre todo lo demás', () => {
    expect(decidirVistaAlertas({ isLoading: true, isError: true, data: undefined })).toBe('cargando');
  });
});

describe('la página de alertas no deriva el plan de la respuesta de alertas', () => {
  it('no lee isPro para decidir el tier', () => {
    const src = readFileSync(PAGINA, 'utf8');
    // Anti-vacuidad: si el archivo se mueve o queda vacío, esto cae antes que la aserción real.
    expect(src.length, 'no se pudo leer alertas/page.tsx').toBeGreaterThan(1000);
    expect(src).toContain('useUser');

    // `isPro` puede aparecer en un comentario explicando por qué NO se usa; lo que no puede
    // aparecer es una LECTURA del campo, venga por acceso directo o por destructuring — la
    // segunda forma (`const { isPro } = data ?? {}`) evadía la primera versión de este grep,
    // y la señaló la revisión adversarial del diff.
    const lecturas = src.split('\n').filter((l) => {
      if (l.trim().startsWith('//')) return false;
      return /\bdata\??\.isPro\b/.test(l) || /\{[^}]*\bisPro\b[^}]*\}\s*=/.test(l);
    });
    expect(
      lecturas,
      'El plan volvió a salir de la respuesta de /api/alerts:\n' + lecturas.join('\n') +
      '\n\nUsá `useUser()`. Ese campo llega undefined cuando el fetch de alertas falla, y ' +
      'entonces `canAccess` trata al usuario como Free: un Pro pierde proyecciones y límites ' +
      'por un hipo de red (F3).',
    ).toEqual([]);
  });
});
