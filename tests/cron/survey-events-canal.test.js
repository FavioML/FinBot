import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El acoplamiento que una revisión adversarial encontró el 27-ago-2026, y que ningún test veía.
 *
 * `checkRecordatorioDiario` escribe una fila en `survey_events` por cada aviso que manda, y esa
 * fila NO es un audit trail: es el DEDUP. La leen dos sitios, con dos ventanas distintas:
 *
 *   · el anti-fatiga de 3 días del propio cron (`recentEvents`);
 *   · `recibioMensajeRecienteProactivo` (7 días), que gatea los OCHO triggers de
 *     `services/survey-triggers.js`.
 *
 * Los dos filtraban `channel = 'whatsapp'`, y eso era correcto **solo porque el cron cortaba
 * antes a quien no tenía número**. Al sacar ese corte (item 14, para que el aviso llegara por
 * la campana), quedaron dos formas de romperlo y las dos son silenciosas:
 *
 *   1. Seguir escribiendo `channel: 'whatsapp'` sobre un aviso que salió solo in-app. La
 *      columna miente, y los ocho triggers se apagan siete días para alguien a quien nunca se
 *      le mandó un WhatsApp.
 *   2. Escribir el canal real y NO ampliar los lectores. Peor: el dedup no encuentra su propia
 *      marca, así que el recordatorio de inactividad sale **todos los días** al usuario sin
 *      número. Un cron de las 8pm y una fila que nunca matchea.
 *
 * Este archivo fija que escritores y lectores hablen del mismo conjunto. Es estático a
 * propósito: el fallo no es de lógica, son dos literales que dejan de coincidir en archivos
 * distintos, y eso no lo ve ningún test de comportamiento de un solo módulo.
 */

const RAIZ = process.cwd();

/**
 * Sin comentarios. No es cosmético: la primera versión de este archivo se puso ROJA por su
 * propia documentación — el docblock que escribí en `checks.js` para explicar el cambio cita
 * `.eq('channel', 'whatsapp')` como ejemplo de lo que ya no se hace, y el barrido lo contaba
 * como código. Es `guard-que-se-mide-contra-su-documentacion`, y en este repo ya van cuatro.
 */
const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const leer = (rel) => sinComentarios(readFileSync(join(RAIZ, rel), 'utf8'));
const CHECKS = leer('cron/checks.js');
const TRIGGERS = leer('services/survey-triggers.js');

/** El cuerpo de una función de nivel superior, hasta la siguiente. */
function cuerpoDe(src, nombre) {
  const i = src.search(new RegExp(String.raw`^(?:async\s+)?function\s+${nombre}\s*\(`, 'm'));
  if (i < 0) return null;
  const resto = src.slice(i + 1);
  const j = resto.search(/^(?:async\s+)?function\s+\w+\s*\(/m);
  return j < 0 ? resto : resto.slice(0, j);
}

const LECTORES = [
  ['cron/checks.js', CHECKS, 'checkRecordatorioDiario'],
  ['services/survey-triggers.js', TRIGGERS, 'recibioMensajeRecienteProactivo'],
];

describe('survey_events: escritores y lectores hablan del mismo conjunto de canales', () => {
  it('las dos copias de CANALES_EMPUJE dicen lo mismo', () => {
    // Están duplicadas a propósito (dos módulos sin dependencia entre ellos), así que lo que
    // falta es alguien que las compare. Si una cambia y la otra no, el dedup se parte.
    for (const [nombre, src] of [['cron/checks.js', CHECKS], ['services/survey-triggers.js', TRIGGERS]]) {
      expect(src, nombre + ' perdió CANALES_EMPUJE').toMatch(
        /const CANALES_EMPUJE = \[\s*'whatsapp',\s*'in_app'\s*\]/,
      );
    }
  });

  it.each(LECTORES)('%s → %s filtra por el conjunto, no por whatsapp a secas', (_rel, src, fn) => {
    const cuerpo = cuerpoDe(src, fn);
    expect(cuerpo, fn + ' no se encontró: el troceo dejó de mirar').toBeTruthy();
    // El `.eq('channel','whatsapp')` es exactamente el bug: deja fuera las filas `in_app`.
    expect(cuerpo, fn + ' volvió a filtrar solo whatsapp').not.toMatch(
      /\.eq\(\s*['"]channel['"]\s*,\s*['"]whatsapp['"]\s*\)/,
    );
    expect(cuerpo, fn + ' no filtra por CANALES_EMPUJE').toMatch(
      /\.in\(\s*['"]channel['"]\s*,\s*CANALES_EMPUJE\s*\)/,
    );
  });

  it('marcarRespuestaProactiva SÍ sigue filtrando solo whatsapp, y está bien', () => {
    // El control negativo de la regla de arriba: no toda lectura de `channel` es un dedup.
    // Ésta la llama el webhook cuando alguien CONTESTA por WhatsApp, así que solo puede marcar
    // un evento de WhatsApp — una notificación in-app no tiene camino de respuesta. Sin este
    // caso, "ampliar todos los filtros" se leería como el arreglo correcto.
    const cuerpo = cuerpoDe(TRIGGERS, 'marcarRespuestaProactiva');
    expect(cuerpo).toBeTruthy();
    expect(cuerpo).toMatch(/\.eq\(\s*['"]channel['"]\s*,\s*['"]whatsapp['"]\s*\)/);
  });

  it('los dos inserts del cron escriben el canal REAL, no la etiqueta fija', () => {
    const inserts = [...CHECKS.matchAll(/from\('survey_events'\)\.insert\(\{([\s\S]{0,400}?)\}\)/g)]
      .map((m) => m[1]);
    expect(inserts.length, 'el barrido no encontró los inserts: este archivo dejó de mirar').toBe(2);
    for (const cuerpo of inserts) {
      expect(cuerpo, 'un insert volvió a fijar el canal').not.toMatch(/channel:\s*['"]whatsapp['"]/);
      expect(cuerpo).toMatch(/channel:\s*usuario\.whatsapp\s*\?\s*'whatsapp'\s*:\s*'in_app'/);
    }
  });

  it("'webapp' NO entra en el conjunto: nps_inapp no es un empuje", () => {
    // La encuesta in-app se muestra cuando la persona ya está adentro de la app. Meterla acá
    // le gastaría la ventana de fatiga de los ocho triggers a alguien a quien no se empujó
    // nada. Es la razón por la que el conjunto se enumera en vez de ser "todo menos nada".
    expect(CHECKS).toMatch(/const CANALES_EMPUJE = \[[^\]]*\]/);
    const literal = CHECKS.match(/const CANALES_EMPUJE = \[([^\]]*)\]/)[1];
    expect(literal).not.toContain('webapp');
  });
});
