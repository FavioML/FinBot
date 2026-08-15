import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * `notificarAdmin` REPORTA si el aviso salió.
 *
 * Durante meses devolvió `undefined` siempre y se tragó sus propios errores, que para un aviso
 * best-effort está bien. Dejó de estarlo el 15-ago-2026, cuando el veredicto de D10
 * (`lib/whatsapp.js`) pasó a marcar avisos como "ya dados" con un throttle: sin saber si salió,
 * un Telegram caído marcaba como avisado algo que nunca llegó y perdía el veredicto **para
 * siempre**, con el único síntoma de un mensaje que no aparece.
 *
 * Este archivo existe porque la mutación "volver a `return;`" sobrevivía en verde: todos los
 * tests del veredicto MOCKEAN `notificarAdmin`, así que ninguno mira la implementación real. Es
 * la clase de hueco que un mock esconde por construcción — la única forma de verlo es probar la
 * función de verdad.
 */

const enviarTelegram = vi.fn();
require('../../lib/telegram').enviarTelegram = enviarTelegram;
const enviarWhatsapp = vi.fn();
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const { notificarAdmin } = require('../../lib/admin-notify');

describe('notificarAdmin dice si el aviso salió', () => {
  beforeEach(() => {
    enviarTelegram.mockReset();
    enviarWhatsapp.mockReset();
  });

  it('true cuando Telegram lo acepta, y no cae al fallback', async () => {
    enviarTelegram.mockResolvedValue(true);

    await expect(notificarAdmin('hola')).resolves.toBe(true);
    expect(enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('true cuando Telegram falla pero el WhatsApp de respaldo entra', async () => {
    enviarTelegram.mockResolvedValue(false);
    enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });

    await expect(notificarAdmin('hola')).resolves.toBe(true);
  });

  it('FALSE cuando los dos canales fallan', async () => {
    // El caso que importa: es lo que distingue "avisé" de "creí que avisé".
    enviarTelegram.mockResolvedValue(false);
    enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047, error: 'fuera de ventana' });

    await expect(notificarAdmin('hola')).resolves.toBe(false);
  });

  it('FALSE si algo lanza, y sigue sin propagar la excepción', async () => {
    // La otra mitad del contrato, y la que no se puede cambiar: hay llamadores en caminos de
    // error donde un throw acá se llevaría puesto el flujo que estaba reportando el problema.
    enviarTelegram.mockRejectedValue(new Error('telegram down'));

    await expect(notificarAdmin('hola')).resolves.toBe(false);
  });
});
