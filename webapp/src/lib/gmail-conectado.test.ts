import { describe, it, expect } from 'vitest';
import { indexarGmail } from './gmail-conectado';

const sinLegacy = (id: string) => ({ id, gmail_access_token: null });

describe('indexarGmail', () => {
  it('cuenta al que solo tiene el token legacy en usuarios', () => {
    const e = indexarGmail([{ id: 'u1', gmail_access_token: 'cifrado' }], []);
    expect(e.conectados.has('u1')).toBe(true);
    expect(e.cupoGastado.has('u1')).toBe(true);
  });

  // Este es EL caso que originó el módulo: la cuenta del fundador vivía solo en
  // `gmail_cuentas` y el panel, que leía la columna legacy, la pintaba apagada.
  it('cuenta al que solo tiene fila activa en gmail_cuentas', () => {
    const e = indexarGmail([sinLegacy('u1')], [{ usuario_id: 'u1', activa: true }]);
    expect(e.conectados.has('u1')).toBe(true);
    expect(e.cupoGastado.has('u1')).toBe(true);
  });

  it('no cuenta como conectado al que desconectó, pero le cobra el cupo', () => {
    const e = indexarGmail([sinLegacy('u1')], [{ usuario_id: 'u1', activa: false }]);
    expect(e.conectados.has('u1')).toBe(false);
    expect(e.cupoGastado.has('u1')).toBe(true);
  });

  it('separa la cuenta conectada con autorización caída', () => {
    const e = indexarGmail(
      [sinLegacy('u1')],
      [{ usuario_id: 'u1', activa: true, auth_error_at: '2026-09-01T00:00:00Z' }],
    );
    expect(e.conectados.has('u1')).toBe(true);
    expect(e.caidos.has('u1')).toBe(true);
  });

  // Una cuenta desconectada no es una cuenta rota: no hay nada que reconectar porque no hay
  // vínculo. Sin este corte, `caidos` se llenaría de gente que se fue por su cuenta.
  it('una cuenta inactiva con auth_error_at no es un caído', () => {
    const e = indexarGmail(
      [sinLegacy('u1')],
      [{ usuario_id: 'u1', activa: false, auth_error_at: '2026-09-01T00:00:00Z' }],
    );
    expect(e.conectados.has('u1')).toBe(false);
    expect(e.caidos.has('u1')).toBe(false);
  });

  it('no duplica al que está en las dos fuentes', () => {
    const e = indexarGmail(
      [{ id: 'u1', gmail_access_token: 'cifrado' }],
      [{ usuario_id: 'u1', activa: true }],
    );
    expect(e.conectados.size).toBe(1);
    expect(e.cupoGastado.size).toBe(1);
  });

  it('ignora filas huérfanas sin usuario_id', () => {
    const e = indexarGmail([sinLegacy('u1')], [{ usuario_id: null, activa: true }]);
    expect(e.conectados.size).toBe(0);
    expect(e.cupoGastado.size).toBe(0);
  });

  // `cupoGastado` ⊋ `conectados` no es un detalle: el cap de 100 de la app OAuth se mide con
  // el primero. Si alguien los iguala "para simplificar", el techo se descubre chocándolo.
  it('el cupo gastado incluye a los desconectados y por eso es mayor que los conectados', () => {
    const e = indexarGmail(
      [sinLegacy('u1'), sinLegacy('u2'), sinLegacy('u3')],
      [
        { usuario_id: 'u1', activa: true },
        { usuario_id: 'u2', activa: false },
        { usuario_id: 'u3', activa: false },
      ],
    );
    expect(e.conectados.size).toBe(1);
    expect(e.cupoGastado.size).toBe(3);
  });
});
