/**
 * Quién tiene Gmail conectado. Fuente única para todas las superficies de admin.
 *
 * **Existe porque el dato tenía dos almacenes y el panel leía el que se quedó vacío.** El
 * modelo viejo guardaba el token en `usuarios.gmail_access_token`; el actual lo guarda en
 * `gmail_cuentas`, una fila por cuenta conectada. `services/gmail-scanner.js` ya lee los DOS
 * (une los ids de las dos fuentes antes de escanear), pero el panel admin, la ficha de usuario
 * y la métrica de adopción se quedaron mirando solo la columna vieja.
 *
 * Medido contra producción el 2026-09-01: 6 usuarios habían conectado Gmail alguna vez, 3
 * seguían activos, y la columna legacy solo tenía a 2. Entre los invisibles estaba la cuenta
 * del fundador, que es la que hizo notar el bug. No era cosmético: la pantalla de Producto
 * reportaba la adopción de la feature más cara del producto con un tercio de los datos.
 *
 * **La unión de FUENTES es la misma que arma `escanearGmailYRegistrar`**, y ese es el
 * invariante que este módulo protege: mirar un almacén distinto que el cron es exactamente
 * cómo nació el bug.
 *
 * Lo que NO es igual, y conviene tenerlo claro antes de leer `conectados` como "a estos se les
 * escanea la bandeja": el scanner, sobre esa misma unión, aplica después dos filtros de
 * ELEGIBILIDAD que este módulo no tiene — exige `esProPagado(usuario)` (leer el correo es una
 * capability de Pro pagado, igual que conectarlo) y excluye las lápidas del borrado de cuenta
 * (`cuenta_borrada_at is null`). O sea que `conectados` es un superconjunto: la pregunta que
 * responde es "¿esta persona tiene Gmail vinculado?", no "¿el cron le lee el correo?".
 *
 * La diferencia es deliberada. El panel quiere saber quién conectó —para la adopción, para el
 * cupo, para el punto de la lista— y eso no cambia porque a alguien se le haya vencido el Pro.
 * Si algún día hace falta la otra pregunta, es un predicado NUEVO que componga estos dos
 * filtros encima, no un cambio acá.
 */

export interface GmailCuentaRow {
  usuario_id: string | null;
  activa: boolean | null;
  auth_error_at?: string | null;
}

export interface GmailLegacyRow {
  id: string;
  /** El token legacy viene cifrado; acá solo importa si está o no. */
  gmail_access_token?: string | null;
}

export interface EstadoGmail {
  /**
   * Conectados HOY: a estos los escanea el cron. Misma unión que `escaneoAutomatico`
   * (`gmail_cuentas.activa = true` ∪ token legacy no nulo).
   */
  conectados: ReadonlySet<string>;
  /**
   * Conectados pero con la autorización caída (`auth_error_at`). Siguen contando como
   * conectados —la cuenta está vinculada— pero el cron no puede leerles el correo hasta que
   * reconecten. Se separa porque es la única sub-población sobre la que hay algo que HACER.
   */
  caidos: ReadonlySet<string>;
  /**
   * Consumieron cupo de la app OAuth alguna vez. **No es lo mismo que `conectados`** y esa
   * diferencia es la que importa para el cap de 100 usuarios de la app sin verificar: quien
   * desconecta deja `activa = false` pero su consentimiento ya se gastó, y la fila sobrevive
   * incluso al borrado de cuenta porque ahí vive el `email_hash` que protege el cupo. Contar
   * de menos acá es descubrir el techo cuando ya se chocó.
   */
  cupoGastado: ReadonlySet<string>;
}

/**
 * Índice de estado de Gmail por `usuarios.id`, a partir de las dos fuentes.
 *
 * `usuarios` se pasa entero (no prefiltrado) a propósito: el que decide es este módulo, y un
 * call-site que filtre antes por su cuenta es exactamente cómo se reintroduce la divergencia.
 */
export function indexarGmail(
  usuarios: GmailLegacyRow[],
  cuentas: GmailCuentaRow[],
): EstadoGmail {
  const conectados = new Set<string>();
  const caidos = new Set<string>();
  const cupoGastado = new Set<string>();

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
