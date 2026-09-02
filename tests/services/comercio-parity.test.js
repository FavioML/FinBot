import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { canonizarComercio as canonWebapp, esPasarelaSola as solaWebapp } from '../../webapp/src/lib/comercio.ts';

const require = createRequire(import.meta.url);
const { canonizarComercio: canonBackend, esPasarelaSola: solaBackend } = require('../../services/parsers');

/**
 * LAS DOS COPIAS DE `canonizarComercio` TIENEN QUE COINCIDIR.
 *
 * Hay dos porque el backend es CommonJS en Railway y la webapp es Next.js en Vercel, que no
 * puede importar de la raíz del repo. Es el mismo trato que `services/spaces-split.js` y su
 * test de paridad, y el precio se paga acá: si divergen, el mismo comercio se guarda con dos
 * nombres según por dónde entró el gasto, y `buscarReglaComercio` —que compara por igualdad
 * exacta— deja de reconocer la regla que el usuario corrigió a mano. O sea, el defecto que
 * esta función existe para cerrar, reabierto por la copia.
 *
 * Se comparan RESULTADOS sobre entradas adversariales, no el texto de los archivos: dos copias
 * escritas distinto pueden hacer lo mismo, y dos copias escritas igual pueden divergir al
 * editar sólo una. Lo que decide es qué devuelven.
 */

const ENTRADAS = [
  // Las tres grafías del bug original
  'IZI*BARBANEGRA', 'IZI* Barbanegra', 'IZI BARBANEGRA', 'IZI', 'izi',
  // El caso degenerado en todas sus formas
  'IZI*', 'IZI *', 'IZI**', 'IZI  ', 'NIUBIZ', ' OPENPAY ',
  // Prefijo de dos tokens (Culqi manda "CULQI QR*<comercio>")
  'CULQI QR', 'CULQI QR*', 'Culqi Qr*lenon', 'Culqi Qr Mm*Crediarauco', 'Culqi*Multitienda Carmen',
  // La pasarela cobrándose a sí misma: NO se pela sin asterisco
  'NIUBIZ PERU', 'IZIPAY SA', 'CULQI SAC', 'DLC MOTORS', 'OPENPAY SOLUCIONES',
  // Prefijos que NO son pasarela
  'APPLE*ICLOUD', 'AMZN*MKTPLACE', 'IZIPAYASO', 'IZIS', 'VNX*ALGO',
  // Prefijos cortos y ambiguos
  'VN*ESTACION', 'VN SERVICIOS GENERALES', 'MPO*SPOTIFY', 'PYU*TIENDA',
  // Nombres reales tal como los guarda BCP
  'Plaza Vea', 'Cineplanet Alcazar Tote', 'E S REPUBLICA DE PANAMA', 'PLIN-SERGIO JARAMILLO',
  // Unicode, espacios raros, bordes
  'IZI*ÑAÑA MARKET', 'IZI*ÓPTICA LUZ', 'izi*ñaña', 'IZI*  DOBLE  ESPACIO  ',
  'IZI*\tTAB', 'IZI*\nSALTO', '  ', '', 'a', '*', '**IZI',
  // Ya canónico: la segunda pasada no puede moverlo
  'BARBANEGRA', 'CARPPONE BARBERIA',
];

const NO_STRINGS = [null, undefined, 42, 0, false, true, {}, []];

describe('paridad backend ↔ webapp de canonizarComercio', () => {
  it('devuelven lo mismo sobre las entradas adversariales, con y sin separadorEspacio', () => {
    const divergen = [];
    for (const entrada of ENTRADAS) {
      for (const opts of [undefined, { separadorEspacio: true }, { separadorEspacio: false }]) {
        const b = canonBackend(entrada, opts);
        const w = canonWebapp(entrada, opts);
        if (b !== w) divergen.push({ entrada, opts, backend: b, webapp: w });
      }
    }
    expect(divergen).toEqual([]);
  });

  it('coinciden también sobre entradas que no son string', () => {
    for (const v of NO_STRINGS) expect(canonWebapp(v)).toBe(canonBackend(v));
  });

  it('`esPasarelaSola` coincide', () => {
    const divergen = ENTRADAS.concat(NO_STRINGS)
      .filter(e => solaBackend(e) !== solaWebapp(e));
    expect(divergen).toEqual([]);
  });

  it('las dos son idempotentes', () => {
    for (const entrada of ENTRADAS) {
      const una = canonBackend(entrada, { separadorEspacio: true });
      if (typeof una !== 'string') continue;
      expect(canonBackend(una, { separadorEspacio: true })).toBe(una);
      expect(canonWebapp(una, { separadorEspacio: true })).toBe(una);
    }
  });

  it('coinciden sobre 20000 entradas generadas, no sólo sobre las que alguien pensó', () => {
    // La lista de arriba cubre exactamente lo que a alguien se le ocurrió poner. Una revisión
    // adversarial lo midió: recortando puntuación de cola SÓLO en la copia TS, las dos copias
    // divergían en razones sociales terminadas en "S.A." y "S.A.C." —de las más comunes que
    // manda un banco peruano— y el test pasaba en verde, porque ninguna estaba en ENTRADAS.
    // Un generador no depende de que alguien haya previsto el caso.
    //
    // Determinista a propósito (LCG con semilla fija): un fuzzer que cambia de entradas en cada
    // corrida delata una divergencia UNA vez y después la esconde, y encima hace que un rojo no
    // se pueda reproducir.
    let semilla = 20260902;
    const rnd = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
    const PIEZAS = [
      'IZI', 'izi', 'NIUBIZ', 'Culqi', 'QR', 'DLC', 'VN', 'MPO', 'OPENPAY', 'IZIPAY',
      '*', '**', ' ', '  ', '.', ',', ';', ':', '(', ')', '|', '-', '\t', '\n',
      'BARBANEGRA', 'S.A.', 'S.A.C.', 'SAC', 'PERU', 'ÑAÑA', 'ÓPTICA', 'Ürsula', 'MOTORS',
      'D.ONOFRIO', 'REST.', 'EL PARAISO', '4821', 'x9', 'Ø', '€', '💳', 'a', '',
      // Piezas largas: sin ellas ninguna entrada generada pasaba de ~50 caracteres, así que
      // un tope de largo puesto en UNA sola copia era estructuralmente invisible. Las razones
      // sociales peruanas completas pasan los 60 sin esfuerzo.
      'CORPORACION DE SERVICIOS GENERALES DEL PERU SOCIEDAD ANONIMA CERRADA',
      'ASOCIACION DE COMERCIANTES DEL MERCADO CENTRAL DE SURQUILLO LIMA PERU',
    ];
    const divergen = [];
    for (let i = 0; i < 20000; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      let entrada = '';
      for (let j = 0; j < n; j++) entrada += PIEZAS[Math.floor(rnd() * PIEZAS.length)];
      const opts = rnd() < 0.5 ? { separadorEspacio: true } : undefined;
      const b = canonBackend(entrada, opts);
      const w = canonWebapp(entrada, opts);
      if (b !== w) divergen.push({ entrada, opts, backend: b, webapp: w });
      if (solaBackend(entrada) !== solaWebapp(entrada)) divergen.push({ entrada, sola: true });
      if (divergen.length > 3) break;
    }
    expect(divergen).toEqual([]);
  });

  it('la lista de pasarelas es la MISMA en las dos copias', () => {
    // Los resultados de arriba sólo cubren las pasarelas que alguien pensó en poner en
    // ENTRADAS. Una pasarela agregada de un solo lado no movería ni un caso, y el día que
    // llegue un cargo de esa pasarela los dos canales lo escribirían distinto en silencio.
    const lista = (txt) => {
      const m = txt.match(/const PASARELAS = \[([\s\S]*?)\];/);
      if (!m) throw new Error('no se encontró la lista PASARELAS');
      return m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    };
    const backend = lista(readFileSync(new URL('../../services/parsers.js', import.meta.url), 'utf8'));
    const webapp = lista(readFileSync(new URL('../../webapp/src/lib/comercio.ts', import.meta.url), 'utf8'));
    expect(backend.length).toBeGreaterThan(5);
    expect(webapp).toEqual(backend);
  });
});
