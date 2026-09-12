/**
 * ¿Esta cuenta tiene WhatsApp vinculado? La respuesta ya no es solo `usuarios.whatsapp`.
 *
 * Desde el rollout de WhatsApp Usernames, quien oculta su número se vincula por su BSUID
 * (`PE.1049206861029395`): la fila queda con `whatsapp` NULL y `bsuid` puesto, y el bot le
 * contesta por ese identificador (backend, `lib/whatsapp.js`). Leer solo `whatsapp` le mostraba
 * "Conecta tu WhatsApp" a alguien que ya lo usa, y lo mandaba a vincular de nuevo.
 *
 * Tres formas de saberlo, según de dónde venga la fila:
 *   · en el SERVIDOR la fila trae `bsuid`;
 *   · en el NAVEGADOR no: `bsuid` es columna sensible (hallazgo D9, `use-user.ts`) y se borra
 *     antes de llegar a la cache persistida. Ahí viaja `tiene_whatsapp`, el booleano derivado,
 *     que dice lo que la pantalla necesita sin exponer el identificador.
 *
 * Un solo lugar para la regla, para que la próxima pantalla que pregunte lo mismo no vuelva a
 * mirar una sola columna.
 */
export interface VinculoWhatsapp {
  whatsapp?: unknown;
  bsuid?: unknown;
  tiene_whatsapp?: unknown;
}

// Recibe `object` y no `VinculoWhatsapp`: las filas del servidor (`NetoUserRow`) tipan todo como
// `unknown` detrás de un índice, y TS rechaza pasarlas a una interfaz de puros opcionales (TS2559).
export function tieneWhatsapp(fila: object | null | undefined): boolean {
  const u = fila as VinculoWhatsapp | null | undefined;
  return !!(u && (u.whatsapp || u.bsuid || u.tiene_whatsapp === true));
}

/**
 * Lo que se le muestra a la persona como "su WhatsApp". El BSUID es un identificador interno
 * que no reconoce nadie, así que no se pinta: se nombra lo que la persona sí reconoce.
 */
export function etiquetaWhatsapp(fila: object | null | undefined): string | null {
  const u = fila as VinculoWhatsapp | null | undefined;
  if (!u) return null;
  if (typeof u.whatsapp === 'string' && u.whatsapp) return u.whatsapp;
  if (tieneWhatsapp(u)) return 'Tu usuario de WhatsApp';
  return null;
}
