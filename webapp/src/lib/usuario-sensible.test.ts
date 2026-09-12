import { describe, it, expect } from 'vitest';
import { quitarSensibles, COLUMNAS_SENSIBLES } from './usuario-sensible';
import type { Usuario } from './types';

const fila = (extra: Record<string, unknown>) =>
  ({ id: 'u1', whatsapp: null, plan: 'free', ...extra }) as unknown as Usuario;

describe('quitarSensibles', () => {
  it('no deja pasar ninguna columna sensible (D9)', () => {
    const r = quitarSensibles(fila({
      gmail_access_token: 'a', gmail_refresh_token: 'b', gmail_token_expiry: 'c', bsuid: 'PE.1049206861029395',
    })) as unknown as Record<string, unknown>;
    for (const c of COLUMNAS_SENSIBLES) expect(r, c).not.toHaveProperty(c);
  });

  it('deriva tiene_whatsapp del bsuid ANTES de borrarlo', () => {
    // Quien se vinculó sin mostrar su número solo tiene el BSUID. Si el orden se invierte, la
    // pantalla le vuelve a ofrecer "Conecta tu WhatsApp" a alguien que ya lo usa.
    const r = quitarSensibles(fila({ bsuid: 'PE.1049206861029395' }));
    expect(r?.tiene_whatsapp).toBe(true);
  });

  it('con número también, y sin ninguno de los dos es false', () => {
    expect(quitarSensibles(fila({ whatsapp: '51999888777' }))?.tiene_whatsapp).toBe(true);
    expect(quitarSensibles(fila({}))?.tiene_whatsapp).toBe(false);
  });

  it('null sigue siendo null', () => {
    expect(quitarSensibles(null)).toBeNull();
  });
});
