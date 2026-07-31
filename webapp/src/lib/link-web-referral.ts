const BACKEND_URL =
  process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';

/**
 * Vincula un usuario recién creado por la webapp (web-first) con su referrer, delegando
 * TODA la mecánica al backend (`POST /admin/referido-web` → services/referrals). La webapp
 * no replica la lógica del descuento a propósito: la siembra del 50% off (ventana 7d,
 * "no si ya es Pro") vive en un solo lugar. El backend resuelve ref_code → referrer,
 * guarda contra auto-referirse y es idempotente.
 *
 * Best-effort: si el hop falla, la cuenta ya quedó creada; el vínculo simplemente no se
 * registró. Nunca lanza — el signup no debe romperse por el referido. Devuelve true solo
 * si el backend confirmó que vinculó (para logging del caller).
 *
 * @param refCode    código de la cookie `neto_ref` (ya validado en formato por el middleware).
 * @param referidoId id interno de `usuarios` del recién registrado (el que devolvió createWebUser).
 */
export async function linkWebReferral(refCode: string, referidoId: string): Promise<boolean> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !refCode || !referidoId) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/admin/referido-web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ ref_code: refCode, referido_id: referidoId }),
    });
    if (!res.ok) {
      console.error('[link-web-referral] backend respondió', res.status);
      return false;
    }
    const json = (await res.json().catch(() => null)) as { linked?: boolean } | null;
    return !!json?.linked;
  } catch (e) {
    console.error('[link-web-referral] hop falló:', (e as Error).message);
    return false;
  }
}
