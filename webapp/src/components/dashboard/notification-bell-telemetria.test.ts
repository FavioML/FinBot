import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La telemetría de la campana, fijada por texto porque acá no hay jsdom ni testing-library
 * (`webapp/CLAUDE.md`: los tests son de módulos de servidor). No prueba que el evento LLEGUE a
 * PostHog — eso se verifica una vez, a mano, contra prod. Prueba las dos cosas que se pueden
 * romper después sin que nadie mire.
 *
 * **1. Que los dos extremos del embudo sigan existiendo.** Hasta el 20-ago-2026 abrir la campana
 * no emitía nada, así que un aviso sin clic podía ser "nunca la abrió" o "la abrió y no le
 * importó": dos problemas con arreglos OPUESTOS —canal vs. ruido— que el dato no separaba.
 * Medido antes de instrumentar: 668 notificaciones a 55 usuarios en 30 días y **4 usuarios**
 * hicieron clic en alguna; entre los 18 activos de verdad, 3 de 17.
 *
 * **2. Que no se filtre PII, que es lo que de verdad justifica un guard.** `titulo` y `mensaje`
 * de una notificación llevan nombres, montos y categorías ("Alerta de presupuesto: gastaste
 * S/420 en Comida"). Mandar eso a PostHog es exportar el detalle financiero de un usuario a un
 * tercero. Agregar `titulo:` al payload es una línea, se ve razonable en un diff, y no rompería
 * nada más.
 *
 * **3. Que `total` y `tipos` NO vuelvan a salir de la lista capada.** El panel lista con
 * `.limit(20)` y hasta el 2026-08-27 estos dos campos se derivaban de ahí, mientras
 * `unreadCount` contaba exacto: hay aperturas reales en PostHog con `total: 20, no_leidas: 22`.
 * El sesgo satura arriba, o sea justo en el usuario con volumen, que es el único sobre el que
 * la pregunta "¿es ruido?" tiene sentido. Medido en producción: 8 de 77 usuarios pasan el cap
 * y **6 de esos 8 pierden además al menos un TIPO**. El caso positivo de más abajo no alcanzaba
 * para verlo: `total: notifications.length` también satisface `\btotal\b`.
 */

const SRC = readFileSync(join(process.cwd(), 'src/components/dashboard/notification-bell.tsx'), 'utf8');

/** Los pares `clave: valor` de un payload, sin comentarios, para poder mirar el VALOR. */
function campos(payload: string): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const linea of payload.split('\n')) {
    const limpia = linea.replace(/\/\/.*$/, '').trim();
    const m = limpia.match(/^(\w+):\s*(.+?),?$/);
    if (m) salida[m[1]] = m[2];
  }
  return salida;
}

/** Los argumentos de cada `track(...)`, para mirar el PAYLOAD y no el archivo entero. */
const LLAMADAS = [...SRC.matchAll(/track\(\s*EVENTS\.([A-Z_]+)\s*,([\s\S]*?)\n\s*\}\);/g)]
  .map((m) => ({ evento: m[1], payload: m[2] }));

/** Campos de `Notificacion` que llevan datos del usuario. Ninguno puede ir a un evento. */
const PII = ['titulo', 'mensaje', 'datos', 'monto', 'link'];

describe('telemetría de la campana', () => {
  it('emite los dos extremos del embudo (antivacuidad)', () => {
    // Sin este conteo, romper la regex dejaría los tests de PII pasando sobre cero payloads.
    expect(LLAMADAS.map((l) => l.evento).sort()).toEqual(['NOTIFICATIONS_OPENED', 'NOTIFICATION_CLICKED']);
  });

  it('la apertura se emite al ABRIR y no al cerrar', () => {
    // El bug fácil: `track` en el toggle a secas, que duplica el evento al cerrar el panel y
    // deja la tasa de apertura al doble.
    expect(SRC).toMatch(/if\s*\(!abriendo\)\s*return;/);
    expect(SRC).toMatch(/onClick=\{handleToggle\}/);
  });

  it.each(PII)('ningún payload manda `%s`', (campo) => {
    for (const { evento, payload } of LLAMADAS) {
      expect(payload, `${evento} manda ${campo}: es dato financiero del usuario`)
        .not.toMatch(new RegExp(`\\b${campo}\\b`));
    }
  });

  it('el control positivo: los payloads SÍ llevan lo que sirve para decidir', () => {
    // Sin esto, un `track()` con payload vacío pasaría los cinco negativos de arriba.
    const abrir = LLAMADAS.find((l) => l.evento === 'NOTIFICATIONS_OPENED')!.payload;
    expect(abrir).toMatch(/\btotal\b/);
    expect(abrir).toMatch(/\bno_leidas\b/);
    expect(abrir).toMatch(/\btipos\b/);
    const clic = LLAMADAS.find((l) => l.evento === 'NOTIFICATION_CLICKED')!.payload;
    expect(clic).toMatch(/\btipo\b/);
    expect(clic).toMatch(/\bestaba_no_leida\b/);
  });

  it.each(['NOTIFICATIONS_OPENED', 'NOTIFICATION_CLICKED'])('%s no esparce un objeto entero', (evento) => {
    // La evasion que ABRE este arreglo: desde que `tipos` viene del servidor, un `...data` es
    // un cambio corto y de aspecto inocente. `campos()` no lo captura como clave, asi que los
    // cinco negativos de PII y el conteo de claves seguirian en verde mientras el evento manda
    // `notifications` completo — con `titulo` y `mensaje` adentro.
    const { payload } = LLAMADAS.find((l) => l.evento === evento)!;
    expect(payload, `${evento} esparce un objeto: lo que lleve adentro viaja sin ser mirado`)
      .not.toMatch(/\.\.\./);
  });

  it('el parser de campos ve algo (antivacuidad del bloque de abajo)', () => {
    // Si la regex de `campos()` dejara de matchear, los tres casos siguientes pasarían sobre
    // un objeto vacío: `undefined` no contiene `notifications`.
    const abrir = campos(LLAMADAS.find((l) => l.evento === 'NOTIFICATIONS_OPENED')!.payload);
    expect(Object.keys(abrir).sort()).toEqual(['listados', 'no_leidas', 'tipos', 'total']);
  });

  it.each(['total', 'tipos'])('`%s` no se deriva de la lista capada', (campo) => {
    const abrir = campos(LLAMADAS.find((l) => l.evento === 'NOTIFICATIONS_OPENED')!.payload);
    // `notifications` es lo que devuelve la API con `.limit(20)`. Derivar de ahí el campo que
    // mide el ruido lo hace saturar en 20 justo en el usuario con volumen. Esto también mata
    // el "arreglo defensivo" `data?.total ?? notifications.length`, que reintroduce el sesgo
    // exactamente en el caso donde importa: cuando el resumen no está.
    expect(abrir[campo], `${campo} sale de la lista capada`).not.toMatch(/\bnotifications\b/);
  });

  it('`listados` SÍ es el largo de la lista, que es lo que lo hace útil', () => {
    // El contra-campo: con los dos juntos el corte se ve desde el dato. Si alguien vuelve a
    // capar `total`, `total === listados` en un usuario con volumen lo delata.
    const abrir = campos(LLAMADAS.find((l) => l.evento === 'NOTIFICATIONS_OPENED')!.payload);
    expect(abrir.listados).toMatch(/notifications\.length/);
  });
});
