import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..'
);
const { BANCOS_CATALOGO, remitentesParaSeleccion, menuSeleccionBancos } = require(
  path.join(projectRoot, 'gmail.js')
);

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

  it('el menú numera todos los bancos del catálogo', () => {
    const menu = menuSeleccionBancos();
    expect(menu).toContain('1. ' + BANCOS_CATALOGO[0].label);
    expect(menu).toContain(BANCOS_CATALOGO.length + '. ' + BANCOS_CATALOGO[BANCOS_CATALOGO.length - 1].label);
    expect(menu.toLowerCase()).toContain('todos');
  });
});
