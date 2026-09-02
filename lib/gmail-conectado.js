/**
 * Espejo CommonJS de `webapp/src/lib/gmail-conectado.ts`.
 *
 * La fuente de verdad es el TS (ahí está el docblock largo con la medición que originó el
 * módulo). Acá vive la misma pregunta para el backend, que es CJS. La paridad la vigila
 * `tests/lib/gmail-conectado-parity.test.js`: si los dos divergen, CI en rojo.
 *
 * El invariante que protege: "tiene Gmail vinculado" tiene que salir de las MISMAS DOS FUENTES
 * en el panel admin, en la ficha de usuario, en la métrica de adopción, en el Neto Score y en
 * el cron que lee los correos (`services/gmail-scanner.js`). El panel decía que no sobre
 * usuarios a los que el cron sí les escaneaba la bandeja, porque miraba solo el legacy.
 *
 * Ojo con leer `conectados` como "a estos les escanea el cron": `escanearGmailYRegistrar`
 * aplica además dos filtros de elegibilidad sobre esta misma unión (`esProPagado` y excluir
 * las lápidas del borrado), así que este conjunto es un superconjunto. Detalle en el TS.
 */

/**
 * @param {Array<{id: string, gmail_access_token?: string|null}>} usuarios
 * @param {Array<{usuario_id: string|null, activa: boolean|null, auth_error_at?: string|null}>} cuentas
 * @returns {{conectados: Set<string>, caidos: Set<string>, cupoGastado: Set<string>}}
 */
function indexarGmail(usuarios, cuentas) {
  const conectados = new Set();
  const caidos = new Set();
  const cupoGastado = new Set();

  for (const u of usuarios) {
    if (u.gmail_access_token) {
      conectados.add(u.id);
      cupoGastado.add(u.id);
    }
  }

  for (const c of cuentas) {
    if (!c.usuario_id) continue;
    cupoGastado.add(c.usuario_id);
    if (c.activa) {
      conectados.add(c.usuario_id);
      if (c.auth_error_at) caidos.add(c.usuario_id);
    }
  }

  return { conectados, caidos, cupoGastado };
}

module.exports = { indexarGmail };
