// `/health?strict=1`: ¿la base contesta? (13-oct-2026)
//
// `/health` solo dice que el proceso está vivo. El 13-oct la base estuvo dos horas sin contestar
// (presupuesto de Disk IO agotado en Supabase Free) y `/health` siguió dando 200, así que el
// canary y Better Stack lo vieron verde mientras el bot no podía leer ni anotar nada. El modo
// estricto hace UNA lectura mínima y devuelve 503 si falla o tarda más que el tope.
//
// `/health` sin parámetro queda igual a propósito: es lo que mira Railway y no debe reiniciar el
// contenedor por una caída de la base, que reiniciarlo no arregla. Mismo patrón que el
// `?strict=1` del CRM.

const TOPE_MS = 5000;

async function saludBase(supabase, topeMs = TOPE_MS) {
  const inicio = Date.now();
  try {
    const { error } = await supabase.from('usuarios').select('id').limit(1)
      .abortSignal(AbortSignal.timeout(topeMs));
    if (error) return { ok: false, db: false, error: error.message || 'error', latencyMs: Date.now() - inicio };
    return { ok: true, db: true, latencyMs: Date.now() - inicio };
  } catch (e) {
    return { ok: false, db: false, error: (e && e.message) || 'error', latencyMs: Date.now() - inicio };
  }
}

module.exports = { saludBase, TOPE_MS };
