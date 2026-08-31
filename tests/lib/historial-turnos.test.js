import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { soloTurnosRespondidos } = require('../../lib/historial-turnos');

const u = (m) => ({ rol: 'usuario', mensaje: m });
const n = (m) => ({ rol: 'neto', mensaje: m });
const textos = (filas) => filas.map((f) => f.rol + ':' + f.mensaje);

describe('soloTurnosRespondidos', () => {
  it('deja intacta la ventana que alterna: es el caso normal y no debe tocarse', () => {
    const v = [u('gaste 20'), n('listo'), u('cuanto llevo'), n('S/20')];
    expect(soloTurnosRespondidos(v)).toEqual(v);
  });

  it('tira el turno del usuario que quedó SIN respuesta al final de la ventana', () => {
    // El caso de producción: el usuario mandó dos mensajes antes de que NETO contestara el
    // primero (12 veces entre marzo y agosto de 2026, huecos de 0.8s a 16s).
    const v = [u('gaste 20'), n('listo'), u('cual es mi score')];
    expect(textos(soloTurnosRespondidos(v))).toEqual(['usuario:gaste 20', 'neto:listo']);
  });

  it('tira una racha entera de turnos sin respuesta', () => {
    const v = [u('cuanto gaste'), u('dame mi reporte'), u('cual es mi score')];
    expect(soloTurnosRespondidos(v)).toEqual([]);
  });

  it('conserva la respuesta de NETO aunque su pregunta se haya caído de la ventana', () => {
    // La ventana son las últimas 6 filas: la primera puede ser un 'neto' cuya pregunta quedó
    // afuera. Esa respuesta SÍ es contexto y no se toca.
    const v = [n('S/20 en total'), u('gaste 30 en taxi'), n('listo')];
    expect(soloTurnosRespondidos(v)).toEqual(v);
  });

  it('tolera una ventana vacía o ausente sin lanzar', () => {
    expect(soloTurnosRespondidos([])).toEqual([]);
    expect(soloTurnosRespondidos(undefined)).toEqual([]);
    expect(soloTurnosRespondidos(null)).toEqual([]);
  });
});
