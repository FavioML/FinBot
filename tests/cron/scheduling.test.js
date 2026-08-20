import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TAREAS, TAREAS_SIEMPRE, MIN } = require('../../cron/schedule.js');
const { FUNCIONES } = require('../../cron/index.js');

/**
 * Guard de la CADENCIA de los crons. El del CABLEADO es `programar.test.js`.
 *
 * Los cinco guards viejos de `tests/cron/` miran qué HACE un cron (que gatee por plan, que
 * dedupee, que no mande dos veces). Ninguno miraba si el cron llega a correr, y ahí hay un
 * acoplamiento que rompe en silencio:
 *
 *   **El período y el ancho de la ventana del gate son UNA decisión, no dos.** Un check que
 *   solo actúa entre las 0 y las 14 de cada hora funciona con período de 15 min porque los
 *   cuatro ticks de una hora caen en m, m+15, m+30 y m+45 y exactamente uno está en [0,14].
 *   A 30 minutos, si el proceso levanta en el minuto 20 los ticks caen en :20 y :50 y el cron
 *   **no corre nunca**: sin excepción, sin log, sin fila en `errores`.
 *
 * La primera versión de este archivo solo reconocía la ventana escrita como `getMinutes() > 14`,
 * así que dejaba fuera a `checkPremiumExpiry` y `checkTrialExpiry` (`getHours() >= 8`) y a
 * `checkRecordatorioOnboarding` / `checkActivacionDia2` (9-21h), que tienen el MISMO
 * acoplamiento. Una revisión adversarial lo midió: subir `checkPremiumExpiry` a 24h pasaba en
 * verde, y con un boot a las 3am ese check no vuelve a correr nunca.
 *
 * Por eso el detector de abajo **falla cerrado**: una forma de gate que no reconoce revienta el
 * test en vez de devolver "sin gate", que es como se sub-reporta en silencio.
 */

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FUENTES = ['cron/checks.js', 'services/gmail-scanner.js', 'cron/index.js', 'lib/error-monitor.js'].map((rel) =>
  readFileSync(path.join(RAIZ, rel), 'utf-8'),
);

/** Cuerpo de una función top-level, desde su declaración hasta la siguiente. */
function cuerpoDe(nombre) {
  for (const fuente of FUENTES) {
    const decl = new RegExp(`^(?:async )?function ${nombre}\\s*\\(`, 'm');
    const m = fuente.match(decl);
    if (!m) continue;
    const resto = fuente.slice(m.index + m[0].length);
    const siguiente = resto.search(/^(?:async )?function \w+\s*\(/m);
    return siguiente === -1 ? resto : resto.slice(0, siguiente);
  }
  return null;
}

/**
 * Ancho de la ventana en la que el check hace algo, derivado del gate.
 *
 * Devuelve `{ clase, ventanaMin }`, o `null` si no hay ninguna referencia horaria (el check
 * corre cada vez que lo llaman). **Tira** si encuentra referencias horarias con una forma que
 * no sabe interpretar: sub-reportar acá da un PASS sobre un cron que no corre.
 */
function ventanaDe(nombre) {
  const cuerpo = cuerpoDe(nombre);
  if (cuerpo === null) return null;

  const minutos = cuerpo.match(/get(?:UTC)?Minutes\(\)\s*>\s*(\d+)/);
  if (minutos) return { clase: 'minutos', ventanaMin: Number(minutos[1]) + 1 };

  const horas = [...cuerpo.matchAll(/get(?:UTC)?Hours\(\)\s*(>=|<=|<|>|!==|===)\s*(\d+)/g)]
    .map((m) => ({ op: m[1], n: Number(m[2]) }));
  if (horas.length === 0) return null;

  // Los gates son guardas de SALIDA (`if (...) return`), así que la ventana activa es el
  // complemento de lo que matchea.
  const soloDistinto = horas.every((h) => h.op === '!==');
  if (soloDistinto) return { clase: 'horas', ventanaMin: 60 };

  const desde = horas.filter((h) => h.op === '<').map((h) => h.n);
  const hasta = horas.filter((h) => h.op === '>=').map((h) => h.n);
  if (desde.length === 0 && hasta.length === 1) {
    // `if (h >= 8) { ... }` — bloque de entrada, no guarda de salida: activa de 8 a 23:59.
    return { clase: 'horas', ventanaMin: (24 - hasta[0]) * 60, desdeHora: hasta[0], hastaHora: 24 };
  }
  if (desde.length === 1 && hasta.length === 1) {
    // `if (h < 9 || h >= 21) return;` — activa de 9 a 20:59.
    return { clase: 'horas', ventanaMin: (hasta[0] - desde[0]) * 60, desdeHora: desde[0], hastaHora: hasta[0] };
  }
  throw new Error(
    `ventanaDe("${nombre}"): forma de gate horario no reconocida (${JSON.stringify(horas)}). ` +
      'Ampliá el detector antes de agregar el gate: devolver "sin ventana" acá deja pasar un cron que no corre.',
  );
}

/**
 * ¿El check filtra por una ventana MÓVIL que se cierra sola (`created_at` entre A y B)?
 *
 * Esa ventana no está en el gate horario y no se puede derivar del texto —sale de restar dos
 * constantes calculadas en el código— pero es la restricción que MANDA cuando existe: el gate de
 * `checkRecordatorioOnboarding` dice 9-21h y su elegibilidad real dura 3 horas. Lo que el guard
 * sí puede hacer es reconocer la forma y exigir que `schedule.js` declare el número.
 */
function tieneVentanaMovil(nombre) {
  const cuerpo = cuerpoDe(nombre);
  if (cuerpo === null) return false;
  return /\.gte\(\s*'created_at'/.test(cuerpo) && /\.lte\(\s*'created_at'/.test(cuerpo);
}

/**
 * El ancho que de verdad manda cuando una ventana MÓVIL tiene que intersectar un gate diario.
 *
 * **Acá había un `Math.min(gate, movil)` y era incorrecto en la dirección peligrosa.** Con el
 * nudge de onboarding (gate 9-21h, ventana móvil de 3h) daba `min(720, 180) = 180`, y `cadaMs`
 * de 15 min pasaba cómodo — mientras **el 50.9% del padrón real no recibía el aviso jamás**.
 * O sea que el único guard escrito para este cron era estructuralmente incapaz de ver su fallo.
 *
 * El modelo correcto sale de preguntar qué le pasa a UN usuario. Madura en `M` y expira en
 * `M + movil`. Lo que puede aprovechar es `[M, M+movil] ∩ (horas abiertas)`, y `M` cae en
 * cualquier momento del día:
 *
 *   · **Si `movil < cerrado`, hay `M` para los que esa intersección es VACÍA.** Ninguna
 *     cadencia lo arregla: el usuario madura y expira con el gate cerrado. Es un error de
 *     diseño de la ventana, no de la frecuencia, y por eso se reporta aparte.
 *   · **Si no, el tramo abierto más corto que le toca a un `M` cualquiera es
 *     `min(abierto, movil − cerrado)`**, y ése es el que el período tiene que caber.
 *
 * Verificado contra un barrido de los 1440 minutos de alta: con `movil = 15h` y este gate, un
 * período de 3h deja 0 minutos sin cobertura y uno de 4h deja 298. La fórmula devuelve
 * exactamente 3h.
 */
function ventanaEfectivaMin(tarea) {
  const gate = ventanaDe(tarea.nombre);
  const movilMin = tarea.ventanaMaxMs ? tarea.ventanaMaxMs / MIN : null;
  if (!gate) return movilMin === null ? null : { clase: 'horas', ventanaMin: movilMin, desdeHora: 0, hastaHora: 24 };
  if (movilMin === null) return gate;
  const cerradoMin = 24 * 60 - gate.ventanaMin;
  if (movilMin < cerradoMin) return { ...gate, ventanaMin: 0, imposible: { movilMin, cerradoMin } };
  return { ...gate, ventanaMin: Math.min(gate.ventanaMin, movilMin - cerradoMin) };
}

const TODAS = [...TAREAS, ...TAREAS_SIEMPRE];

/** Minuto de la hora en que cae cada tick de un día, arrancando en `arranqueMs`. */
function* ticksDelDia(arranqueMs, cadaMs) {
  for (let ms = arranqueMs; ms < 24 * 60 * MIN; ms += cadaMs) {
    yield { hora: Math.floor(ms / (60 * MIN)) % 24, minuto: Math.floor(ms / MIN) % 60, diaMs: ms };
  }
}

describe('cadencia de los crons', () => {
  it('cada tarea de la tabla resuelve a una función DE VERDAD', () => {
    // Resuelve contra el mapa real de `cron/index.js`, no contra un regex de su texto. La
    // versión anterior leía el mapa con `/^\s{2}(\w+),/gm`, así que comentar un nombre del
    // `module.exports` de `checks.js` —lo que deja la entrada en `undefined`— pasaba en verde.
    const rotas = TODAS.filter((t) => typeof FUNCIONES[t.nombre] !== 'function').map((t) => t.nombre);
    expect(rotas, 'tareas de schedule.js que no resuelven a una función').toEqual([]);
  });

  it('ningún nombre está repetido en la tabla', () => {
    // `enVuelo` y los offsets se llavean por nombre, así que dos filas con el mismo nombre no
    // son dos tareas: la segunda comparte la llave de la primera, **no corre nunca** y dispara
    // el aviso de atasco. Nada más lo valida.
    const nombres = TODAS.map((t) => t.nombre);
    expect(nombres.length, 'nombres repetidos en schedule.js').toBe(new Set(nombres).size);
  });

  it('el detector de ventana sabe leer las formas que existen (control positivo y negativo)', () => {
    // Sin esto, un cambio de formato en checks.js dejaría a `ventanaDe` devolviendo null para
    // todo y las aserciones de abajo pasarían por vacuidad.
    expect(ventanaDe('checkRecordatorioDiario')).toMatchObject({ clase: 'minutos', ventanaMin: 15 });
    expect(ventanaDe('checkResumenSemanal'), 'usa getUTCMinutes').toMatchObject({ clase: 'minutos' });
    expect(ventanaDe('checkPremiumExpiry'), 'getHours() >= 8 → 8am-23:59').toMatchObject({ clase: 'horas', ventanaMin: 960 });
    expect(ventanaDe('checkRecordatorioOnboarding'), '9-21h').toMatchObject({ clase: 'horas', ventanaMin: 720 });
    expect(ventanaDe('keepWarmWebapp'), 'sin gate horario').toBeNull();
  });

  it('la muestra no está vacía por ninguna de las dos clases', () => {
    // Las aserciones de abajo son universales sobre un filtro: con el filtro vacío pasan solas.
    const conVentana = TODAS.map((t) => ventanaDe(t.nombre)).filter(Boolean);
    expect(conVentana.filter((v) => v.clase === 'minutos').length).toBeGreaterThanOrEqual(10);
    expect(conVentana.filter((v) => v.clase === 'horas').length).toBeGreaterThanOrEqual(4);
  });

  it('ninguna ventana móvil puede quedar ATRAPADA dentro del gate cerrado', () => {
    // El fallo que el `Math.min` no podía ver, y que le costó al nudge de onboarding el 50.9%
    // del padrón: si la ventana móvil es más angosta que las horas que el gate está cerrado,
    // hay usuarios que maduran y expiran de madrugada. Ninguna cadencia lo arregla.
    const atrapadas = TODAS
      .map((t) => ({ nombre: t.nombre, ef: ventanaEfectivaMin(t) }))
      .filter((x) => x.ef && x.ef.imposible)
      .map((x) => `${x.nombre}: ventana móvil de ${x.ef.imposible.movilMin}min contra ${x.ef.imposible.cerradoMin}min de gate cerrado`);
    expect(atrapadas, 'ventanas móviles que no alcanzan a cruzar el gate cerrado').toEqual([]);
  });

  it('la fórmula de la ventana efectiva distingue los tres casos (control)', () => {
    // Sin esto, `ventanaEfectivaMin` podría devolver cualquier cosa y las aserciones de arriba
    // pasarían solas. Los tres números salen del barrido de los 1440 minutos de alta.
    const gate12h = { nombre: 'checkRecordatorioOnboarding' };
    // Hoy: móvil 15h contra 12h cerradas → 3h de tramo abierto garantizado.
    expect(ventanaEfectivaMin({ ...gate12h, ventanaMaxMs: 15 * 60 * MIN }).ventanaMin).toBe(180);
    // La config VIEJA (móvil 3h) tiene que salir marcada como imposible, no como "3h".
    expect(ventanaEfectivaMin({ ...gate12h, ventanaMaxMs: 3 * 60 * MIN }).imposible).toBeTruthy();
    // Una móvil enorme queda topada por el gate abierto, no crece indefinidamente.
    expect(ventanaEfectivaMin({ ...gate12h, ventanaMaxMs: 48 * 60 * MIN }).ventanaMin).toBe(720);
  });

  it('todo check con ventana móvil la tiene DECLARADA en schedule.js', () => {
    // Fail-closed sobre la forma que el detector no puede medir. Sin esto, el próximo check con
    // `created_at` entre A y B queda cubierto por su gate horario —que puede ser 4x más ancho—
    // y el guard da PASS sobre un cron que se saltea usuarios.
    const sinDeclarar = TODAS.filter((t) => tieneVentanaMovil(t.nombre) && !t.ventanaMaxMs).map((t) => t.nombre);
    expect(sinDeclarar, 'checks que filtran por una ventana móvil sin `ventanaMaxMs` en schedule.js').toEqual([]);
    // Antivacuidad: si el detector deja de reconocer la forma, esto se cae.
    expect(TODAS.filter((t) => tieneVentanaMovil(t.nombre)).length).toBeGreaterThanOrEqual(2);
  });

  it('el período nunca supera el ancho de la ventana que de verdad manda', () => {
    // La cota directa, y NO es una tautología: compara dos números de fuentes independientes —
    // el período, que se declara en `schedule.js`, contra el ancho, que sale del gate en
    // `checks.js` acotado por la ventana móvil. Es la que atrapa a `checkRecordatorioOnboarding`
    // con período de 6 h (gate de 12 h, elegibilidad real de 3) y a `checkPremiumExpiry` con 20.
    for (const t of TODAS) {
      const v = ventanaEfectivaMin(t);
      if (!v) continue;
      expect(
        t.cadaMs,
        `${t.nombre}: período de ${t.cadaMs / MIN} min contra una ventana de ${v.ventanaMin} min`,
      ).toBeLessThanOrEqual(v.ventanaMin * MIN);
    }
  });

  it('ningún check con gate se queda sin tick dentro de su ventana', () => {
    // La cota de arriba dice que ENTRA; esto dice que entra **arranque el proceso cuando
    // arranque**, que es lo que el hallazgo pone en juego. Un período de 30 min mata la clase
    // `minutos` para la mitad de los arranques.
    //
    // **El barrido de arranques es de 24 HORAS para la clase `horas`, y de una hora para la
    // clase `minutos`.** La primera versión barría 3600s para las dos, y eso solo probaba boots
    // dentro de la hora 0: `checkPremiumExpiry` a 20 horas pasaba en verde (ticks en las horas
    // 0 y 20, y la 20 cae dentro de 8-24) cuando arrancando a las 04:00 no cae ni uno. Una
    // ventana que se repite cada día necesita muestrear el día entero.
    for (const t of TODAS) {
      const v = ventanaEfectivaMin(t);
      if (!v) continue;
      const finBarridoSeg = v.clase === 'minutos' ? 3600 : 24 * 3600;
      const pasoSeg = v.clase === 'minutos' ? 7 : 60;
      for (let arranqueSeg = 0; arranqueSeg < finBarridoSeg; arranqueSeg += pasoSeg) {
        const arranqueMs = arranqueSeg * 1000;
        if (v.clase === 'minutos') {
          const horasCubiertas = new Set();
          for (const tick of ticksDelDia(arranqueMs, t.cadaMs)) {
            if (tick.minuto < v.ventanaMin) horasCubiertas.add(Math.floor(tick.diaMs / (60 * MIN)));
          }
          // 23 y no 24: el primer y el último tramo del día están cortados por los bordes de
          // la simulación, no por el scheduling.
          expect(
            horasCubiertas.size,
            `${t.nombre} (cada ${t.cadaMs / MIN} min) se queda sin tick en su ventana arrancando en el segundo ${arranqueSeg}`,
          ).toBeGreaterThanOrEqual(23);
        } else {
          // Una ventana horaria se repite cada DÍA, así que la pregunta es "¿cae un tick en
          // CADA día?", no "¿cae alguno en la semana?". Sobre varios días un período que no
          // divide 24h termina entrando por deriva, y eso taparía justo el fallo: con dedup
          // diario, saltarse un día es un día de avisos que no salieron.
          //
          // Solo se exigen las ventanas que EMPIEZAN después del arranque: si el proceso
          // levanta a las 21:00 y la ventana de ese día era 9-21, no hay nada que exigirle.
          const DIA_MS = 24 * 60 * MIN;
          for (let dia = 0; dia < 7; dia++) {
            const desde = dia * DIA_MS + v.desdeHora * 60 * MIN;
            const hasta = dia * DIA_MS + v.hastaHora * 60 * MIN;
            if (desde < arranqueMs) continue;
            let entra = false;
            for (let ms = arranqueMs; ms < hasta; ms += t.cadaMs) if (ms >= desde) { entra = true; break; }
            expect(
              entra,
              `${t.nombre} (cada ${t.cadaMs / MIN} min) se saltea el día ${dia} entero: ningún tick entre las ${v.desdeHora} y las ${v.hastaHora} arrancando en el segundo ${arranqueSeg}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('un check de ventana de 15 min no corre MÁS de una vez por hora', () => {
    // La cota de arriba solo mira "no se queda sin correr". Sin esta, bajar un check de 15 min
    // a 1 min pasa en verde y multiplica por 15 su carga contra Supabase — que es justo lo
    // contrario de lo que el escalonado vino a hacer.
    for (const t of TODAS) {
      const v = ventanaDe(t.nombre);
      if (!v || v.clase !== 'minutos') continue;
      const porHora = new Map();
      for (const tick of ticksDelDia(0, t.cadaMs)) {
        if (tick.minuto < v.ventanaMin) {
          const h = Math.floor(tick.diaMs / (60 * MIN));
          porHora.set(h, (porHora.get(h) || 0) + 1);
        }
      }
      const max = Math.max(...porHora.values());
      expect(max, `${t.nombre} entra ${max} veces en la misma ventana`).toBe(1);
    }
  });
});
