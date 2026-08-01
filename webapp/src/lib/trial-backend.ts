const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * Avisa al backend que el usuario acaba de registrar una transacción, para que arranque
 * su trial de 14 días si le corresponde.
 *
 * Por qué un hop de red en vez de hacer el UPDATE acá:
 *  1. El arranque del trial vive en UN solo lugar (`lib/trial.js`), con su CAS atómico y
 *     su re-anclaje del descuento de referido. Replicar eso en TypeScript es garantizar
 *     que las dos copias diverjan.
 *  2. El evento del embudo necesita `distinctId = usuarios.id`. La webapp usa posthog-js
 *     con otro distinct_id, así que emitirlo desde acá partiría el embudo en dos mitades
 *     que ya no se pueden unir (mismo motivo que `/internal/activacion-completada`).
 *
 * Es idempotente del lado del backend, así que se puede llamar en cada insert sin
 * condicionar nada. Best-effort: si falla, la transacción del usuario ya quedó guardada
 * y su próximo gasto vuelve a intentarlo — la invariante "cualquier transacción arranca
 * el trial" se auto-repara.
 */
export async function iniciarTrialBackend(usuarioId: string): Promise<void> {
  if (!INTERNAL_API_KEY) {
    console.error('[trial] INTERNAL_API_KEY no configurada: el usuario web-first no recibirá su trial');
    return;
  }
  try {
    const res = await fetch(`${BACKEND_URL}/internal/trial-iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
      body: JSON.stringify({ usuario_id: usuarioId }),
    });
    if (!res.ok) console.error('[trial] backend respondió', res.status);
  } catch (e) {
    console.error('[trial] no se pudo avisar al backend', e);
  }
}

/**
 * Telemetría de trial nacida en la webapp (hoy solo `paywall_visto`). Mismo motivo del
 * hop que arriba: el evento tiene que salir con `usuarios.id` como distinctId.
 */
export async function eventoTrialBackend(usuarioId: string, evento: string): Promise<void> {
  if (!INTERNAL_API_KEY) return;
  try {
    await fetch(`${BACKEND_URL}/internal/trial-evento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
      body: JSON.stringify({ usuario_id: usuarioId, evento }),
    });
  } catch (e) {
    console.error('[trial] no se pudo emitir el evento', e);
  }
}
