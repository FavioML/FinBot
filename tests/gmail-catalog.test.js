import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..'
);
const { BANCOS_CATALOGO, remitentesParaSeleccion, describirSeleccion, construirQueriesBancarias } = require(
  path.join(projectRoot, 'gmail.js')
);
const { bancoDeDominio, DOMINIOS_DMARC_P_NONE } = require(path.join(projectRoot, 'lib', 'auth-results.js'));

describe('BANCOS_CATALOGO / remitentesParaSeleccion (bank filter)', () => {
  it('expande una selección a la union de remitentes de esos bancos', () => {
    const r = remitentesParaSeleccion(['bcp', 'yape']);
    expect(r).toContain('notificaciones@bcp.com.pe');
    expect(r).toContain('notificaciones@yape.pe');
    // No debe traer remitentes de bancos no elegidos
    expect(r).not.toContain('notificaciones@interbank.pe');
    expect(r).not.toContain('notificaciones@bbva.pe');
  });

  it('selección vacía o null cae al set completo (backward-compatible)', () => {
    const completo = remitentesParaSeleccion(null);
    expect(completo).toContain('notificaciones@bcp.com.pe');
    expect(completo).toContain('notificaciones@interbank.pe');
    expect(completo).toContain('notificaciones@bbva.pe');
    // La union del catálogo completo cubre el mismo universo
    expect(remitentesParaSeleccion([])).toEqual(completo);
    expect(remitentesParaSeleccion('nope')).toEqual(completo);
  });

  it('ids desconocidos se ignoran; si no queda ninguno válido → set completo', () => {
    expect(remitentesParaSeleccion(['inexistente'])).toEqual(remitentesParaSeleccion(null));
    const r = remitentesParaSeleccion(['bcp', 'inexistente']);
    expect(r).toContain('notificaciones@bcp.com.pe');
    expect(r).not.toContain('notificaciones@yape.pe');
  });

  it('cada remitente del catálogo aparece en el set completo (sin huérfanos)', () => {
    const completo = new Set(remitentesParaSeleccion(null));
    for (const banco of BANCOS_CATALOGO) {
      for (const rem of banco.remitentes) {
        expect(completo.has(rem)).toBe(true);
      }
    }
  });

  it('ningún banco del catálogo queda sin remitentes (la UI no ofrece un banco que no se lee)', () => {
    for (const banco of BANCOS_CATALOGO) expect(banco.remitentes.length, banco.id).toBeGreaterThan(0);
  });

  /**
   * **Un remitente conocido se salta `esCorreoMasivo` y el filtro DKIM**, y lo único que lo frena
   * es el `dmarc=fail` que Gmail escribe ante un From falsificado. Sin registro DMARC en el dominio
   * Gmail no puede dar ese veredicto, así que una dirección ahí la imita cualquiera. Por eso el
   * dominio tiene que estar en `BANCOS_DKIM` (DMARC quarantine/reject verificado) o en
   * `DOMINIOS_DMARC_P_NONE`: Gmail los deja en la bandeja pero sí marca el `dmarc=fail`.
   *
   * Hasta el 31-oct-2026 la lista tenía `scotiabank.pe` (sin NS que respondan), `plin.pe`,
   * `tunki.pe` (registrado a nombre de un particular, no de Interbank) y tres cajas, todos sin DMARC.
   */
  it('todo remitente conocido es de un dominio con DMARC', () => {
    for (const rem of remitentesParaSeleccion(null)) {
      const dominio = rem.slice(rem.lastIndexOf('@') + 1);
      expect(bancoDeDominio(dominio) !== null || DOMINIOS_DMARC_P_NONE.includes(dominio), rem).toBe(true);
    }
  });

  // Los dos menús numerados de WhatsApp (`menuSeleccionBancos` / `menuEdicionBancos`) se
  // borraron junto con los pasos 30 y 31: la selección se hace con checkboxes en
  // app.neto.pe/dashboard/pro. `describirSeleccion` sigue viva — la usa el scanner.
  it('describirSeleccion: null/[] → "todos los bancos"; ids → labels', () => {
    expect(describirSeleccion(null)).toBe('todos los bancos');
    expect(describirSeleccion([])).toBe('todos los bancos');
    expect(describirSeleccion(['bcp', 'bbva'])).toBe('BCP, BBVA');
    expect(describirSeleccion(['inexistente'])).toBe('todos los bancos');
  });
});

describe('construirQueriesBancarias (ventana del scan)', () => {
  const remitentes = ['alertas@bcp.com.pe', 'notificaciones@yape.pe'];

  it('scan recurrente usa la ventana de 2 días en ambas queries', () => {
    const { queryDirecto, queryPalabrasClave } = construirQueriesBancarias(remitentes, 2);
    expect(queryDirecto).toContain('newer_than:2d');
    expect(queryPalabrasClave).toContain('newer_than:2d');
  });

  it('barrido histórico usa la ventana de 30 días en ambas queries', () => {
    const { queryDirecto, queryPalabrasClave } = construirQueriesBancarias(remitentes, 30);
    expect(queryDirecto).toContain('newer_than:30d');
    expect(queryPalabrasClave).toContain('newer_than:30d');
    // No debe quedar rastro de la ventana corta
    expect(queryDirecto).not.toContain('newer_than:2d');
  });

  it('queryDirecto incluye los remitentes elegidos y excluye enviados', () => {
    const { queryDirecto } = construirQueriesBancarias(remitentes, 30);
    expect(queryDirecto).toContain('alertas@bcp.com.pe');
    expect(queryDirecto).toContain('notificaciones@yape.pe');
    expect(queryDirecto).toContain('-in:sent');
  });
});
