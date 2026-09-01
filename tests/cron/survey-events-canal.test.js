import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El acoplamiento que una revisión adversarial encontró el 27-ago-2026, y que ningún test veía.
 *
 * `checkUpsellPro` escribe una fila en `survey_events` por cada aviso que manda, y esa
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
 *      marca, así que el aviso vuelve a salir en cada corrida al usuario sin número. Un cron de
 *      las 8pm y una fila que nunca matchea. (El caso que lo destapó fue el recordatorio de
 *      inactividad, apagado el 01-sep-2026; el acoplamiento no era suyo y sigue vivo.)
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
  ['cron/checks.js', CHECKS, 'checkUpsellPro'],
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

  /**
   * **`LECTORES` es una lista escrita a mano, y el título de este archivo la sobrepasa.**
   * Encontrado el 01-sep-2026 por una revisión adversarial: hay un CUARTO lector de
   * `survey_events.channel` —el `/silenciar` de `handlers/intents/moderacion.js`— que filtra
   * `whatsapp` a secas y no estaba declarado ni como regla ni como excepción. Su comportamiento
   * es defendible (sólo alguien con WhatsApp puede escribir `/silenciar`, así que el evento que
   * marca es de WhatsApp por construcción), pero ése es exactamente el argumento que sí se
   * escribió para `marcarRespuestaProactiva` — y el que faltaba acá.
   *
   * Este caso no juzga el filtro: cuenta. Afirma que no aparezca un lector NUEVO sin que
   * alguien decida a cuál de los dos grupos pertenece, que es lo que "escritores y lectores
   * hablan del mismo conjunto" prometía y sólo comprobaba sobre los que alguien recordó.
   */
  it('no hay lectores de survey_events.channel sin declarar', () => {
    // Se cuenta por ARCHIVO y no por función a propósito: atribuir la lectura a su función
    // pide un troceo, y el primer intento se lo adjudicó a un `const analytics = require(...)`
    // —o sea que el guard habría acusado a un import—. El conteo fijado alcanza para lo único
    // que este caso tiene que hacer: que un lector NUEVO no pase sin que alguien lo clasifique.
    const DECLARADOS = new Map([
      ['cron/checks.js', { n: 1, quien: 'checkUpsellPro: DEDUP, filtra por CANALES_EMPUJE' }],
      ['services/survey-triggers.js', { n: 2, quien: 'recibioMensajeRecienteProactivo (DEDUP, CANALES_EMPUJE) y marcarRespuestaProactiva (whatsapp a propósito: la campana no tiene camino de respuesta)' }],
      ['handlers/intents/moderacion.js', { n: 1, quien: '/silenciar: whatsapp a propósito, sólo quien tiene número puede escribir el comando' }],
    ]);
    let total = 0;
    for (const [rel, esperado] of DECLARADOS) {
      const src = leer(rel);
      const lecturas = [...src.matchAll(/['"]channel['"]/g)].filter((m) => {
        const ventana = src.slice(Math.max(0, m.index - 600), m.index);
        if (!/from\(\s*['"]survey_events['"]\s*\)/.test(ventana)) return false;
        return !/\.insert\(/.test(ventana.slice(-400));   // escritura, la cubre el caso de arriba
      });
      total += lecturas.length;
      expect(
        lecturas.length,
        `${rel} tiene ${lecturas.length} lecturas de survey_events.channel y están declaradas ` +
        `${esperado.n} (${esperado.quien}). Si agregaste una, decidí si es un DEDUP (va con ` +
        'CANALES_EMPUJE) o si filtra `whatsapp` a propósito, y actualizá esta lista con el motivo.',
      ).toBe(esperado.n);
    }
    expect(total, 'el barrido no encontró lectores: dejó de mirar').toBeGreaterThanOrEqual(4);
  });

  it('el insert del cron escribe el canal REAL, no la etiqueta fija', () => {
    const inserts = [...CHECKS.matchAll(/from\('survey_events'\)\.insert\(\{([\s\S]{0,400}?)\}\)/g)]
      .map((m) => m[1]);
    // Era 2 hasta el 01-sep-2026: el otro lo escribía el recordatorio de inactividad, que se
    // apagó (ver el docblock de `checkUpsellPro`). El conteo es fijo a propósito — con un
    // `>= 1` este barrido se quedaría verde el día que alguien borre el que queda.
    expect(inserts.length, 'el barrido no encontró el insert: este archivo dejó de mirar').toBe(1);
    for (const cuerpo of inserts) {
      expect(cuerpo, 'un insert volvió a fijar el canal').not.toMatch(/channel:\s*['"]whatsapp['"]/);
      expect(cuerpo).toMatch(/channel:\s*usuario\.whatsapp\s*\?\s*'whatsapp'\s*:\s*'in_app'/);
    }
  });

  /**
   * **La otra mitad, que este archivo no miraba hasta el 01-sep-2026 (ítem 23).**
   *
   * El acoplamiento que documenta el docblock de arriba tiene DOS escritores, no uno: el
   * `insert` de `checkUpsellPro` y el de `registrarEvento`, que sirve a los OCHO triggers de
   * `services/survey-triggers.js`. El de arriba se arregló el 27-ago; el de acá siguió fijando
   * `'whatsapp'` cuatro días más, y no se veía porque este archivo solo barría `CHECKS`.
   *
   * Mientras el cron cortaba a quien no tenía número la etiqueta era cierta por accidente. Al
   * sacar ese corte pasó a ser la falla nº1 del docblock, literal: la columna miente, y los
   * ocho triggers se apagan siete días para alguien a quien nunca se le mandó un WhatsApp.
   *
   * Los cinco call-sites NO son iguales, y por eso el barrido los cuenta en vez de exigirles a
   * todos la misma forma: `maybeWebappInvite` manda por `SOLO_WHATSAPP`, así que ahí `'in_app'`
   * sería la mentira opuesta. Es la única exención, y va nombrada.
   */
  it('los cinco registrarEvento de los triggers escriben el canal REAL', () => {
    const CANAL_FIJO_OK = new Set(['webapp_invite_10tx']);
    // Se trocea por el CALL-SITE (`registrarEvento({ … })`) y no por líneas contiguas: entre
    // `eventType` y `channel` hay comentarios, y `enviarYRegistrar` escribe `eventType` con la
    // forma abreviada. Un barrido que dependa del renglón de al lado se cae con el primer
    // comentario que alguien agregue, y se cae hacia el verde.
    const llamadas = [...TRIGGERS.matchAll(/registrarEvento\(\{([\s\S]{0,600}?)\n {2}\}\)/g)]
      .map((m) => m[1])
      // La DEFINICIÓN (`function registrarEvento({ userId, eventType, channel, … })`) matchea
      // igual y no es un call-site. Se distingue por la forma abreviada: los cinco llamadores
      // escriben `userId: …`, la firma escribe `userId,`.
      .filter((cuerpo) => /userId:/.test(cuerpo));
    // Antivacuidad: si el barrido deja de matchear, esto se ve igual que "todos correctos".
    expect(llamadas.length, 'el barrido no encontró los call-sites: este caso dejó de mirar').toBe(5);

    for (const cuerpo of llamadas) {
      const ev = cuerpo.match(/eventType:\s*'([a-z_0-9]+)'/);
      const evento = ev ? ev[1] : 'enviarYRegistrar(reminder_dN)';
      const ca = cuerpo.match(/\n\s*channel:\s*(.+?),\s*\n/);
      expect(ca, `${evento} no declara channel: el troceo dejó de ver el call-site`).toBeTruthy();
      const canal = ca[1].trim();
      if (CANAL_FIJO_OK.has(evento)) {
        expect(canal, `${evento} dejó de ser el único con canal fijo: revisá si sigue siendo SOLO_WHATSAPP`)
          .toBe("'whatsapp'");
        continue;
      }
      expect(canal, `${evento} fija el canal en vez de escribir el real`)
        .toBe("usuario.whatsapp ? 'whatsapp' : 'in_app'");
    }
  });

  /**
   * **`survey_events.channel` es un ENUM, no un `text` libre**, y esto se pagó en producción.
   *
   * `notification_deliveries.canal` sí es `text` con default, así que escribir `'email'` ahí
   * no necesita nada. Por analogía escribí `'in_app'` en `survey_events.channel` — y el tipo
   * es `survey_channel`, que solo tenía `whatsapp` y `webapp`. **La suite entera pasó en
   * verde**: los guards de este archivo son estáticos (leen el fuente) y los dobles de
   * Supabase no validan enums, así que nada podía verlo. Apareció recién al consultar
   * producción DESPUÉS del deploy, con un `22P02: invalid input value for enum`.
   *
   * El guard no puede consultar la base desde `npm test`. Lo que sí puede es exigir que todo
   * valor nuevo venga con su migración: es exactamente el paso que faltó, y es barato de
   * comprobar. Los dos originales están exentos porque nacieron con el tipo.
   */
  it('todo canal que el código escribe existe en el enum, o trae su migración', () => {
    const ORIGINALES = new Set(['whatsapp', 'webapp']);
    const migraciones = readdirSync(join(RAIZ, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(RAIZ, 'migrations', f), 'utf8'))
      .join('\n');

    const literal = CHECKS.match(/const CANALES_EMPUJE = \[([^\]]*)\]/)[1];
    const escritos = [...literal.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(escritos.length, 'el barrido no encontró los canales: dejó de mirar').toBeGreaterThan(1);

    for (const canal of escritos) {
      if (ORIGINALES.has(canal)) continue;
      expect(
        new RegExp(`ALTER TYPE survey_channel ADD VALUE[^;]*'${canal}'`).test(migraciones),
        `'${canal}' no existe en el enum survey_channel y ninguna migración lo agrega. ` +
        'Un INSERT con ese valor falla con 22P02 en producción, y ningún test local lo ve: ' +
        'los guards leen el fuente y los dobles de Supabase no validan enums.',
      ).toBe(true);
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
