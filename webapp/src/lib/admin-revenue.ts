import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';
import { esProPagado as esProPagadoPlan } from '@/lib/plan';
import { msDeFechaLima } from '@/lib/date-lima';

/**
 * Cuentas internas (fundador + QA) que NO son negocio real. Se excluyen de las
 * métricas de ingreso (MRR / ARR / caja / conversión) para que el panel refleje
 * pagos de clientes de verdad. NO se excluyen de las de volumen (total usuarios,
 * DAU/WAU/MAU) porque ahí sí cuentan como registro/actividad.
 * Mantener sincronizado si aparecen más bots de prueba.
 */
export const EXCLUDED_REVENUE_WHATSAPP = new Set<string>([
  '51970398192', // Favio (fundador)
  '51999999997', // Andrea QA Pro (cuenta de prueba)
]);

export interface RevenueUserRow {
  id?: string;
  plan: string | null;
  tipo_plan: string | null;
  whatsapp?: string | null;
  /** Marca de cuenta de prueba (harness qa-e2e, seeds de demo). Nunca es ingreso. */
  is_test_user?: boolean | null;
  /**
   * Estado del trial de 14 días. Durante el trial `plan` vale `'premium'` (así el
   * usuario en prueba recibe Pro sin tocar los ~40 gates que miran esa columna), o sea
   * que **`plan === 'premium'` ya NO significa "paga"**. Este es el único lugar donde
   * ese truco cobra peaje, y por eso se paga acá y no en 40 sitios.
   */
  trial_estado?: string | null;
  /**
   * Cuándo el usuario pidió borrar TODOS sus datos. Es la única baja **declarada** que
   * existe en el producto: inactividad y vencimiento son inferencias nuestras, esto lo
   * pidió la persona con todas las letras. Es un HECHO histórico y no se limpia nunca
   * (ver migración 072 y el comentario de la columna en Postgres).
   *
   * Tiene que venir en el `select`. Como `is_test_user`, si no se pide llega `undefined`
   * y la fila entra al MRR como si nada hubiera pasado. Lo vigila
   * `admin-revenue-callsites.test.ts`.
   */
  cuenta_borrada_at?: string | null;
}

/**
 * ¿Este usuario PAGA? Es lo que cuenta para MRR, ARR y churn. Un trial es plan
 * `'premium'` con `trial_estado='activo'`: entrega Pro pero no factura, así que
 * contarlo inflaría el MRR con dinero que nadie transfirió.
 *
 * Delega en `@/lib/plan` en vez de reimplementar la condición: es la misma pregunta que
 * responden `/api/pro/status` (para mostrar el descuento) y `pantallaPro`. Tenerla escrita
 * dos veces en la webapp es cómo empiezan las divergencias que esta columna ya causó.
 */
export function esProPagado(u: RevenueUserRow): boolean {
  return esProPagadoPlan(u.plan, u.trial_estado);
}

/** Fila con fechas de alta/baja Pro, para reconstrucción histórica de MRR. */
export interface HistoryUserRow extends RevenueUserRow {
  premium_desde?: string | null; // fecha (YYYY-MM-DD) de alta Pro
  premium_vence?: string | null; // fecha (YYYY-MM-DD) de vencimiento Pro
}

export interface PagoRow {
  monto: number | string | null;
  estado: string | null;
  aprobado_at?: string | null;
  created_at?: string | null;
  usuario_id?: string | null;
}

/**
 * Instantes (ms) en que a un usuario le entró plata de verdad, por `usuarios.id`.
 *
 * Es el testigo de "volvió", y el que se elija NO es un detalle de implementación: es la
 * diferencia entre descontar del MRR a alguien que se fue y borrar del MRR a alguien que
 * está pagando. Los dos candidatos obvios de la fila `usuarios` NO sirven, y los dos se
 * escriben sin que entre un sol:
 *
 *   · `fecha_pago` la escribe `activarPro` (`lib/pro-payment.js`) SIEMPRE, incluidos los
 *     comps (`esConversionPagada: false`, o sea `POST /admin/activar` y el `/activar` de
 *     WhatsApp). Un regalo del admin resucitaba al churneado al MRR a precio de lista.
 *   · `premium_desde` la escribe además el premio de referidos (`services/referrals.js`)
 *     sin pasar por `activarPro`. O sea que un TERCERO metía al MRR a alguien que se
 *     había ido, por S/10 que nadie transfirió.
 *
 * Una fila de `pagos` con `estado='aprobado'` y `monto > 0` no tiene esa ambigüedad, y es
 * el mismo predicado que ya usa `pro_sin_pago_registrado`: el comp se registra
 * explícitamente en S/0 para no inflar `cajaDelMes`, así que el filtro lo deja fuera solo.
 *
 * Sobrevive al borrado de cuenta a propósito: la migración 073 vacía 24 tablas y a `pagos`
 * solo le borra `comprobante_url` y `notas`. El registro financiero queda, que es lo que
 * hace que este testigo siga existiendo después del wipe.
 */
export interface PagosConPlata {
  /**
   * Los `usuarios.id` por los que SE PREGUNTÓ. Fuera de este conjunto el índice no dice
   * "no hay pagos": dice **no sé**, y confundir las dos cosas es el modo de falla más caro
   * que tiene este archivo.
   *
   * Existe por un bug que se evitó al escribir `esCortesia`. `cargarPagosConPlata` acota la
   * lectura a una lista de ids, y `/api/admin/stats` le pasaba SOLO los que pidieron la baja
   * —le alcanzaba, porque su única pregunta era "¿alguno volvió?"—. Un predicado nuevo que
   * pregunte "¿a este le entró plata alguna vez?" contra ese mismo índice contesta que no
   * sobre TODOS los pagadores del producto, y el MRR se va a cero con el panel en verde.
   * Con el dominio explícito ese call-site no devuelve un número falso: revienta.
   */
  readonly dominio: ReadonlySet<string>;
  /** Instantes (ms) de los pagos con plata, por `usuarios.id`. */
  readonly porUsuario: ReadonlyMap<string, number[]>;
}

/**
 * A quién hay que preguntarle por sus pagos para que las métricas de este archivo sean
 * correctas. **Los call-sites no arman esta lista a mano**: es la definición del dominio y
 * tenerla escrita en dos rutas es cómo se reintroduce el bug que `dominio` vigila.
 *
 * Las tres ramas, y por qué ninguna sobra:
 *   · `esProPagado` — el MRR de hoy y `esCortesia`.
 *   · `premium_desde` — el histórico: `wasProAtMonthEnd` puede clasificar como Pro de un mes
 *     pasado a alguien que hoy es free, y también necesita saber si en ese mes había pagado.
 *   · `premium_vence` — el churn le pregunta a todo el que tuvo Pro y venció. **No sobra por
 *     estar cubierta por `premium_desde`**: al 2026-09-01 hay 4 filas con vencimiento y sin
 *     fecha de alta, porque el panel admin da Pro escribiendo solo `premium_vence`.
 *   · `cuenta_borrada_at` — el testigo de "volvió".
 *
 * **`necesitaIndicePagos` responde la misma pregunta por usuario, y los predicados que recorren
 * la población entera la usan como guarda.** No es duplicación: es que "¿a quién hay que
 * consultarle?" y "¿a este puedo preguntarle?" tienen que dar lo mismo, o el índice se arma
 * sobre un conjunto y se consulta sobre otro. Ese desacuerdo mandaba un 500 a
 * `/admin/operacion` con cualquier base que tuviera un usuario free, que son casi todas.
 *
 * Difieren en UN caso, a propósito: una fila sin `id` **necesita** el índice pero no puede
 * entrar en él, porque no hay clave con la que indexarla. Ahí `pagosDe` lanza con un mensaje
 * distinto ("sin `id`"), que es la respuesta correcta — el problema no es el dominio, es el
 * `select` de la ruta. Las tres rutas admin traen `id` y el guard de call-sites lo exige.
 */
export function necesitaIndicePagos(u: HistoryUserRow): boolean {
  return Boolean(
    esProPagado(u) || u.premium_desde || u.premium_vence || u.cuenta_borrada_at,
  );
}

export function idsParaIndicePagos(users: HistoryUserRow[]): string[] {
  const ids = new Set<string>();
  for (const u of users) {
    if (u.id && necesitaIndicePagos(u)) ids.add(u.id);
  }
  return [...ids];
}

/**
 * Los pagos con plata de este usuario, exigiendo que esté en el dominio.
 *
 * Lanza en vez de devolver `[]` a propósito: ver el docblock de `dominio`. Un usuario sin
 * `id` tampoco puede responderse (no hay a quién buscarle los pagos) y también lanza — las
 * rutas admin traen `id` en el select y el guard de call-sites lo exige.
 */
function pagosDe(u: RevenueUserRow, pagos: PagosConPlata): number[] {
  if (!u.id) {
    throw new Error(
      'admin-revenue: se preguntó por los pagos de un usuario sin `id`. El `select` de la ruta tiene que traer `id`.',
    );
  }
  if (!pagos.dominio.has(u.id)) {
    throw new Error(
      `admin-revenue: el índice de pagos no cubre a ${u.id}. Arma la lista con \`idsParaIndicePagos()\`: ` +
        'un índice acotado a otra población contesta "no hay pagos" sobre gente que sí pagó.',
    );
  }
  return pagos.porUsuario.get(u.id) || [];
}

/**
 * ¿A este usuario le entró plata alguna vez? Pasa por `pagosDe`, o sea que **exige el
 * dominio**, y esa es la razón de que exista en vez de que el call-site mire el `Map`.
 *
 * `/api/admin/users` lo hacía: leía `pagos.porUsuario.get(id)` directo para armar la señal del
 * badge. Era el único lector del índice que se salteaba la guarda, y una revisión adversarial
 * midió lo que costaba — acotando ahí la población, `tiene_pago` quedaba `false` para todos los
 * pagadores y el panel pintaba "Pro cortesía" sobre cada cliente que paga, sin un error, sin un
 * 500, sin nada. Con esta función ese mismo cambio revienta en la primera fila.
 */
export function tienePagoConPlata(u: RevenueUserRow, pagos: PagosConPlata): boolean {
  return pagosDe(u, pagos).length > 0;
}

/** El instante en que un pago se hizo plata. Mismo fallback que `cajaDelMes`. */
function instanteDelPago(p: PagoRow): number | null {
  const when = p.aprobado_at || p.created_at;
  if (!when) return null;
  const ms = new Date(when).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Índice de pagos con plata por usuario. Filtra acá y no en el call-site: el filtro
 * (`aprobado` + `monto > 0`) ES la definición del testigo, y tenerlo escrito en cada ruta
 * es cómo empiezan las divergencias.
 */
export function indexarPagosConPlata(
  pagos: PagoRow[],
  dominio: Iterable<string>,
): PagosConPlata {
  const idx = new Map<string, number[]>();
  for (const p of pagos) {
    if (p.estado !== 'aprobado' || !p.usuario_id) continue;
    // El `parseFloat` está por simetría con `cajaDelMes`, que hace lo mismo sobre la misma
    // columna, NO porque acá haga falta: `pagos.monto` es NUMERIC y PostgREST lo devuelve
    // como string, pero `isNaN` y `<=` coaccionan igual, así que para cualquier salida real
    // de esa columna el resultado es idéntico con o sin parsear. Se dice acá porque una
    // revisión adversarial buscó el test que lo cubriera y no existe ninguno que pueda:
    // no hay input realista que separe las dos versiones. No escribas uno que finja hacerlo.
    const monto = typeof p.monto === 'string' ? parseFloat(p.monto) : p.monto;
    if (monto == null || isNaN(monto) || monto <= 0) continue;
    const ms = instanteDelPago(p);
    if (ms == null) continue;
    const lista = idx.get(p.usuario_id);
    if (lista) lista.push(ms);
    else idx.set(p.usuario_id, [ms]);
  }
  return { dominio: new Set(dominio), porUsuario: idx };
}

/**
 * ¿La baja de este usuario seguía vigente en `hastaMs`? O sea: ya había pedido borrar su
 * cuenta, y todavía no había vuelto a pagar.
 *
 * Es la primitiva de todo lo demás. Está parametrizada por instante y no fija en "hoy"
 * porque el histórico pregunta otra cosa: el chart de 6 meses necesita saber si estaba de
 * baja **al cierre de ESE mes**. Preguntar por hoy dentro de una función sobre el mes X le
 * cobra MRR al que se fue en julio por los meses en que tenía la cuenta borrada, solo
 * porque volvió en septiembre.
 *
 * Un usuario sin `id`, o fuera del dominio del índice, no se puede responder: `pagosDe`
 * lanza. Antes esos dos casos caían en "no volvió" —o sea, en baja— que es la respuesta
 * plausible y equivocada.
 */
export function bajaVigenteAl(
  u: RevenueUserRow,
  hastaMs: number,
  pagos: PagosConPlata,
): boolean {
  if (!u.cuenta_borrada_at) return false;
  const baja = new Date(u.cuenta_borrada_at).getTime();
  if (isNaN(baja) || baja > hastaMs) return false; // todavía no se había ido
  const cobros = pagosDe(u, pagos);
  // Estricto por la izquierda: un pago en el MISMO instante que la baja no es un retorno.
  // El caso real es exactamente ese orden (pagó el 08-ago 11:52, borró el 09-ago 00:42) y
  // el lado seguro para equivocarse es no resucitar al que se fue horas después de pagar.
  return !cobros.some((t) => t > baja && t <= hastaMs);
}

/**
 * ¿Este usuario se dio de baja y NO volvió? Es `bajaVigenteAl` sin techo: cualquier pago
 * posterior a la baja, sea cuando sea, dice que volvió a ser cliente.
 *
 * Se DERIVA en vez de guardarse como estado, y esa es la decisión de fondo. La primera
 * versión trataba la marca como estado mutable y la limpiaba en `completarAlta()`, pero
 * `onboarding_completado = true` se escribe en al menos otros cinco lugares que no
 * limpiaban nada (`lib/pro-payment.js` al aprobar un pago, los pasos 1 y 10 del
 * onboarding, el callback de Gmail, el alta web), y `merge_and_link` hereda las dos
 * columnas en el mismo UPDATE — así que tras un merge la marca quedaba puesta con el alta
 * ya cerrada, sin salida. El peor caso era un cliente que PAGA fuera del MRR para siempre.
 * Derivarlo elimina la clase entera: no hay dos lugares que sincronizar.
 *
 * Deliberadamente NO toca el entitlement: quien pagó conserva su Pro si vuelve, y los ~40
 * gates que miran `plan` siguen viendo exactamente lo mismo. Esto es métrica, no permiso.
 *
 * **Pide `ahora` en vez de preguntar "alguna vez": los dos instantes tienen que ser el
 * mismo.** La primera versión preguntaba sin techo (`Infinity`) mientras `computeChurn`
 * preguntaba por `now`, y eso reabría la clase que este cambio vino a cerrar, con el signo
 * invertido: un pago con `aprobado_at` en el futuro contaba como retorno para el MRR y no
 * para el churn, así que la misma persona sumaba en el numerador del churn Y en el ingreso.
 * Una `cuenta_borrada_at` futura hacía lo espejo.
 *
 * **Límite conocido del modelo, y no tiene arreglo desde acá:** `usuarios.cuenta_borrada_at`
 * guarda UNA fecha y la migración 073d la congela (`COALESCE`, más un corte que devuelve
 * `ya_borrada` antes de tocar nada). O sea que la SEGUNDA baja de una misma fila no se
 * escribe en ningún lado, y un pago posterior a la primera revierte todas las futuras. El
 * día que eso sea alcanzable, la columna no alcanza: hace falta una tabla de bajas.
 *
 * **Acá decía "hoy no es alcanzable" y era falso.** El argumento era que el wipe borra el
 * `whatsapp`, así que nadie puede encontrar la fila. Pero `bindActivacion` no busca por
 * identidad: busca por **PK**, y `usuarios.id` es lo único que el wipe NO puede limpiar. Y
 * el wipe pone `supabase_auth_id = NULL`, que era justo lo que hacía al token de activación
 * de un solo uso — o sea que borrar la cuenta REARMABA el link por lo que le quedara de sus
 * 7 días, y la lápida adoptaba la sesión quedando viva con la marca puesta. Eso está cortado
 * explícitamente en `lib/bind-activation.ts`, con su test. Verificado contra producción el
 * 18-ago: ninguna de las dos lápidas llegó a adoptarse, así que no hubo daño.
 *
 * Que hoy no quede un camino conocido no es lo mismo que que no exista: la afirmación que
 * había acá es la que hacía que nadie lo buscara. Si aparece una fila con `cuenta_borrada_at`
 * y sesión viva, el problema es este.
 *
 * Y pesa más que una métrica: `checkPremiumExpiry` (`cron/checks.js`) filtra
 * `.is('cuenta_borrada_at', null)`, así que a una fila con marca nunca se le baja el plan; y
 * `borrar_cuenta_total` corta en `ya_borrada`, así que una baja pedida DE VERDAD sobre esa
 * fila no borraría nada.
 */
export function esBajaDeclarada(
  u: RevenueUserRow,
  pagos: PagosConPlata,
  ahora: Date,
): boolean {
  return bajaVigenteAl(u, ahora.getTime(), pagos);
}

/**
 * ¿Este Pro llegó sin que entrara un sol? O sea: tiene el plan, y a `hastaMs` no había ni un
 * pago aprobado con monto > 0.
 *
 * **Es un regalo, no un cliente, y por eso no es MRR.** Hoy hay tres caminos que dan Pro sin
 * cobrar, y ninguno deja rastro en la fila de `usuarios` que lo distinga de un pago:
 *
 *   · el panel admin de la webapp (`set_plan` / `extend_premium`): escribe `plan='premium'` y
 *     `estado_pago='pagado'`, que es literalmente la misma fila que deja un pago real, y no
 *     registra nada en `pagos`;
 *   · `POST /admin/activar` con `esConversionPagada: false`, que va por `activarPro` y SÍ deja
 *     su fila en `pagos` con `monto: 0` — el filtro `monto > 0` la descarta igual, que es
 *     justamente por qué el criterio funciona con o sin ese registro;
 *   · el premio de referidos (`services/referrals.js`), que da un mes gratis sin pasar por
 *     `activarPro`.
 *
 * Se DERIVA de `pagos` en vez de marcarse en una columna nueva, y esa es la decisión de fondo.
 * El eje del plan ya tiene dos columnas (`plan` + `trial_estado`) y mirar una sola ya costó
 * seis huecos; una tercera sería un estado más que sincronizar en cada uno de esos tres
 * caminos, y el que se olvide cobra MRR fantasma para siempre. Derivarlo elimina la clase: no
 * hay nada que recordar, y el día que la persona paga vuelve al MRR sola.
 *
 * **Toma `hastaMs` por la misma razón que `bajaVigenteAl`**: el chart histórico pregunta si en
 * el cierre de ESE mes ya había pagado. Sin techo, alguien que recibió un mes de cortesía en
 * julio y pagó en septiembre aparecería cobrando MRR en julio y agosto, meses en los que no
 * había transferido nada.
 *
 * **Lo que NO hace: tocar el entitlement.** Quien tiene Pro de cortesía lo tiene entero, y los
 * ~40 gates que miran `plan` siguen viendo exactamente lo mismo. Esto es métrica, no permiso.
 *
 * Límite conocido, y hay que tenerlo presente antes de "arreglarlo": si algún día aparece un
 * camino que cobre de verdad sin escribir en `pagos`, ese cliente se leería como cortesía y
 * saldría del MRR en silencio. Por eso el panel PINTA la cortesía en la lista de usuarios en
 * vez de solo descontarla: un pagador mal clasificado se ve en la fila, no se descubre por un
 * MRR raro tres meses después. Al 2026-09-01 los 6 pagadores reales tienen su fila de `pagos`,
 * y en toda la tabla no hay una sola fila en S/0 (12 aprobadas, ninguna en cero): los comps que
 * existen hoy se dieron desde el panel de la webapp, que es el camino que no registra.
 */
export function nuncaPagoAl(
  u: RevenueUserRow,
  pagos: PagosConPlata,
  hastaMs: number,
): boolean {
  return !pagosDe(u, pagos).some((t) => t <= hastaMs);
}

/**
 * `nuncaPagoAl` restringido a quien HOY tiene el plan Pro. Es la cortesía propiamente dicha:
 * lo que sale del MRR.
 *
 * La separación de `nuncaPagoAl` no es de estilo. El churn pregunta por gente que **ya es
 * free** (venció su Pro), y ahí `esProPagado` es false, así que preguntar por la cortesía
 * devuelve un "no" que parece una respuesta y no lo es: una cortesía que vence entraba al
 * numerador del churn como si se hubiera ido un cliente. Nunca hubo ingreso que perder.
 */
export function esCortesiaAl(
  u: RevenueUserRow,
  pagos: PagosConPlata,
  hastaMs: number,
): boolean {
  return esProPagado(u) && nuncaPagoAl(u, pagos, hastaMs);
}

/** `esCortesiaAl` en el presente. Pide `ahora` para que no haya dos relojes distintos. */
export function esCortesia(
  u: RevenueUserRow,
  pagos: PagosConPlata,
  ahora: Date,
): boolean {
  return esCortesiaAl(u, pagos, ahora.getTime());
}

/**
 * ¿Es un cliente Pro que sigue siéndolo hoy? La pregunta que quieren casi todos los
 * consumidores. Existe como función única para que no se repita el estado en que quedó el
 * primer intento: `computeRevenue` descontando la baja y `computeChurn` contándola, o sea
 * dos números del mismo JSON midiendo universos distintos.
 */
export function esProActivo(
  u: RevenueUserRow,
  pagos: PagosConPlata,
  ahora: Date,
): boolean {
  return (
    esProPagado(u) &&
    !esBajaDeclarada(u, pagos, ahora) &&
    !esCortesia(u, pagos, ahora)
  );
}

/**
 * ¿Cuenta este usuario como negocio real para métricas de ingreso?
 *
 * Dos señales, porque la lista de números no alcanza. `is_test_user` es la marca canónica que
 * ya ponen los harness de qa-e2e y los seeds de demo, y cubre lo que la lista no puede: una
 * cuenta de prueba web-first (sin whatsapp que listar) y cualquier QA nuevo que nadie se acordó
 * de agregar acá. El 2026-08-02 eran dos cuentas de prueba con `plan: 'premium'` sumando S/20
 * al MRR del panel, sobre ~S/56 reales: la métrica con la que se decide si el producto funciona
 * exageraba un tercio. La lista se queda para el fundador, que no es `is_test_user`.
 */
export function isRevenueUser(u: {
  whatsapp?: string | null;
  is_test_user?: boolean | null;
}): boolean {
  if (u.is_test_user) return false;
  return !u.whatsapp || !EXCLUDED_REVENUE_WHATSAPP.has(u.whatsapp);
}

/** Valor mensual normalizado: anual = precio anual / 12, mensual = precio mensual. */
export function monthlyValuePen(u: RevenueUserRow): number {
  if (!esProPagado(u)) return 0;
  return u.tipo_plan === 'anual'
    ? PRO_PRICE_YEARLY_PEN / 12
    : PRO_PRICE_MONTHLY_PEN;
}

export interface RevenueSummary {
  proCount: number; // Pro reales (excluye internos y bajas declaradas)
  proMonthly: number;
  proYearly: number;
  mrr: number; // normalizado
  arr: number;
  /**
   * Pro pagados que pidieron borrar su cuenta y por eso NO están en `mrr`.
   *
   * Se devuelve en vez de descontarse en silencio a propósito: un MRR que baja sin
   * explicación en la misma pantalla se lee como un bug del panel. Que el panel pueda
   * decir "S/X, 2 dados de baja no contados" es la mitad del valor de esta marca.
   */
  bajasDeclaradas: number;
  /**
   * Pro de cortesía que por eso NO están en `mrr`: tienen el plan y nunca pagaron.
   *
   * Se devuelve por el mismo motivo que `bajasDeclaradas` — un MRR que baja sin explicación
   * en la misma pantalla se lee como un bug del panel — y por uno propio: es el número que
   * delata un pagador mal clasificado. Si sube sin que nadie haya regalado nada, hay un
   * cobro que no está llegando a la tabla `pagos`.
   */
  cortesias: number;
}

/**
 * MRR/ARR normalizado sobre usuarios reales (excluye cuentas internas y bajas declaradas).
 *
 * La baja NO entra por `isRevenueUser`, y no es un detalle de estilo: esa función también
 * arma el set de excluidos de `cajaDelMes`, y ahí la plata SÍ entró. Un cliente que pagó
 * S/10 y después borró su cuenta cobró S/10 ese mes; lo que dejó de ser cierto es que vaya
 * a pagar el siguiente. Meterlo en `isRevenueUser` habría borrado un ingreso real de la caja.
 */
export function computeRevenue(
  users: RevenueUserRow[],
  pagos: PagosConPlata,
  ahora: Date,
): RevenueSummary {
  const real = users.filter(isRevenueUser);
  const pagados = real.filter(esProPagado);
  const bajas = pagados.filter((u) => esBajaDeclarada(u, pagos, ahora));
  // La baja gana sobre la cortesía cuando las dos aplican: quien pidió borrar su cuenta ya
  // está contado ahí, y sumarlo a los dos lados haría que la pantalla reporte dos personas
  // donde hay una. No cambia el MRR (los dos salen), sí el desglose que lo explica.
  const cortesias = pagados.filter(
    (u) => !esBajaDeclarada(u, pagos, ahora) && esCortesia(u, pagos, ahora),
  );
  const pro = pagados.filter((u) => esProActivo(u, pagos, ahora));
  const proYearly = pro.filter((u) => u.tipo_plan === 'anual').length;
  const proMonthly = pro.length - proYearly;
  const mrr = round2(pro.reduce((sum, u) => sum + monthlyValuePen(u), 0));
  return {
    proCount: pro.length,
    proMonthly,
    proYearly,
    mrr,
    arr: round2(mrr * 12),
    bajasDeclaradas: bajas.length,
    cortesias: cortesias.length,
  };
}

/**
 * Caja real cobrada desde el inicio del mes: suma de pagos aprobados cuyo
 * aprobado_at (o created_at como fallback) cae en el mes, excluyendo pagos de
 * cuentas internas. Es dinero de verdad, distinto del MRR recurrente.
 * Compara como instante (Date), no como string, para no depender del formato
 * del timestamp (Z vs +00:00) en el borde del mes.
 */
export function cajaDelMes(
  pagos: PagoRow[],
  excludedUserIds: Set<string>,
  monthStartIso: string,
): number {
  const monthStartMs = new Date(monthStartIso).getTime();
  const total = pagos.reduce((sum, p) => {
    if (p.estado !== 'aprobado') return sum;
    if (p.usuario_id && excludedUserIds.has(p.usuario_id)) return sum;
    const when = p.aprobado_at || p.created_at;
    if (!when) return sum;
    const whenMs = new Date(when).getTime();
    if (isNaN(whenMs) || whenMs < monthStartMs) return sum;
    const monto = typeof p.monto === 'string' ? parseFloat(p.monto) : p.monto;
    if (monto == null || isNaN(monto)) return sum;
    return sum + monto;
  }, 0);
  return round2(total);
}

/**
 * Valor mensual normalizado para reconstrucción histórica. A diferencia de
 * monthlyValuePen (que devuelve 0 si el plan actual no es premium), asume que el
 * usuario YA fue clasificado como Pro en ese mes, así que valora por tipo_plan
 * aunque hoy sea free (churned). Anual = precio anual / 12.
 */
function historyMonthlyValue(u: HistoryUserRow): number {
  return u.tipo_plan === 'anual'
    ? PRO_PRICE_YEARLY_PEN / 12
    : PRO_PRICE_MONTHLY_PEN;
}

/**
 * ¿El usuario era Pro activo al cierre de `monthEnd`? Basado en premium_desde
 * (alta real) y premium_vence, NO en created_at (registro) ni en la heurística
 * vence−30d, que ubicaba a los anuales +11 meses en el futuro.
 */
export function wasProAtMonthEnd(
  u: HistoryUserRow,
  monthEnd: Date,
  pagos: PagosConPlata,
): boolean {
  // Se pregunta por el CIERRE de ese mes, no por hoy. Sin el techo, alguien que borró su
  // cuenta en julio y volvió a pagar en septiembre no es baja hoy, así que el chart le
  // cobraba MRR por agosto — un mes en que tenía la cuenta borrada. Y al revés: quien se
  // fue en agosto seguía sumando en todos los meses pasados y se soltaba solo en `i === 0`,
  // o sea que la caída se atribuía siempre al mes en curso.
  if (bajaVigenteAl(u, monthEnd.getTime(), pagos)) return false;
  // Quien no está en el índice no pudo haber pagado nunca, y además preguntarle lanzaría.
  // Antes esta rama estaba escrita como `if (!u.premium_desde) return esProPagado(u)` más
  // abajo, que da el mismo resultado para esta población pero después de tocar el índice.
  if (!necesitaIndicePagos(u)) return false;
  // Mismo techo temporal, misma razón: si al cierre de ese mes todavía no le había entrado un
  // sol, ese mes no aportó MRR — aunque hoy sí pague. Va antes que las fechas de `premium_*`
  // porque los tres caminos que regalan Pro escriben esas columnas igual que un pago real.
  //
  // **`nuncaPagoAl` y no `esCortesiaAl`, y la diferencia se pagó.** La cortesía exige ser Pro
  // pagado HOY, así que dejaba de proteger apenas la fila caía a `free`: a un ex-Pro que tuvo
  // el plan de regalo en junio, pagó en julio y venció en agosto, el chart le cobraba MRR por
  // junio — un mes en que no había transferido un sol. Es la misma clase que rompió
  // `newProInMonth`, y la encontró el test de reconciliación del chart, no la revisión.
  if (nuncaPagoAl(u, pagos, monthEnd.getTime())) return false;
  if (!u.premium_desde) return esProPagado(u); // Pro pagado sin fecha de alta (los trials no tienen premium_desde)
  // `msDeFechaLima` y no `new Date`: estas dos son DATE y nombran un día calendario peruano.
  // Parsearlas como medianoche UTC las deja cinco horas antes del borde del mes Lima, y toda
  // fecha del día 1 se cae al mes anterior.
  if (msDeFechaLima(u.premium_desde) > monthEnd.getTime()) return false; // aún no era Pro
  if (u.premium_vence) return msDeFechaLima(u.premium_vence) >= monthEnd.getTime(); // vigente
  return esProPagado(u);
}

/**
 * MRR histórico normalizado al cierre de `monthEnd`, solo negocio real (excluye
 * cuentas internas). Suma el valor por tipo de plan de los Pro activos ese mes.
 */
export function mrrAtMonthEnd(
  users: HistoryUserRow[],
  monthEnd: Date,
  pagos: PagosConPlata,
): number {
  return round2(
    users
      .filter(isRevenueUser)
      .filter((u) => wasProAtMonthEnd(u, monthEnd, pagos))
      .reduce((s, u) => s + historyMonthlyValue(u), 0),
  );
}

/**
 * El primer pago con plata POSTERIOR a la baja, o `null` si no volvió. Es el instante en
 * que esa persona vuelve a ser cliente.
 */
export function primerRetorno(u: RevenueUserRow, pagos: PagosConPlata): number | null {
  if (!u.cuenta_borrada_at) return null;
  const baja = new Date(u.cuenta_borrada_at).getTime();
  if (isNaN(baja)) return null;
  const posteriores = pagosDe(u, pagos).filter((t) => t > baja);
  return posteriores.length ? Math.min(...posteriores) : null;
}

/**
 * El instante del PRIMER pago con plata de este usuario, o `null` si nunca pagó.
 *
 * Es el alta comercial de quien empezó con Pro regalado: el día que transfiere, entra al MRR.
 * Sin esta rama, `newProInMonth` documentaba ese caso ("quien recibió cortesía y pagó DESPUÉS
 * sigue contando como alta del mes en que pagó") y **no lo implementaba**: las dos ramas que
 * había eran `premium_desde` —que la cortesía ya tenía desde antes— y `primerRetorno`, que
 * exige `cuenta_borrada_at`. Medido: una cortesía de junio que paga el 15-ago hacía saltar el
 * MRR de S/0 a S/10 con `newPro = 0` y `churned = 0` en la misma fila del chart, o sea las dos
 * únicas columnas que existen para explicar el delta diciendo cero. Es el mismo defecto que
 * `primerRetorno` vino a arreglar para las reactivaciones, entrando por la otra puerta.
 */
export function primerPagoConPlata(
  u: RevenueUserRow,
  pagos: PagosConPlata,
): number | null {
  const cobros = pagosDe(u, pagos);
  return cobros.length ? Math.min(...cobros) : null;
}

/**
 * **La** fecha de alta comercial de este usuario, o `null` si nunca la tuvo.
 *
 * Es UNA sola por usuario, y esa unicidad es el punto: mientras fueron tres ramas en `or`
 * (`premium_desde`, el retorno, el primer pago), la misma persona podía contarse como alta en
 * DOS meses distintos. Medido por una revisión adversarial: una cortesía de junio que paga en
 * julio y se le vence en agosto contaba en junio por `premium_desde` —la guarda era
 * `esCortesiaAl`, que exige ser Pro pagado HOY y deja de proteger apenas la fila cae a free— y
 * otra vez en julio por el pago. Julio quedaba con el MRR plano y `newPro = 1`, que es
 * exactamente el defecto que la rama del pago venía a arreglar, con el signo invertido.
 *
 * **Es `max`, no `min`, y no es una elección de estilo: es lo que hace que reconcilie.** El MRR
 * de un mes lo decide `wasProAtMonthEnd`, que exige las DOS condiciones — que `premium_desde`
 * ya haya pasado, y que a esa fecha ya hubiera entrado plata (`esCortesiaAl`). O sea que el
 * usuario empieza a aportar en el más TARDÍO de los dos instantes, y el alta tiene que ser ese
 * mismo, o la columna que explica el delta apunta a un mes en que el MRR no se movió.
 *
 * Sin pagos no hay alta: quien tiene Pro de regalo no aportó nada que anunciar.
 */
export function altaComercial(
  u: HistoryUserRow,
  pagos: PagosConPlata,
): number | null {
  const primerPago = primerPagoConPlata(u, pagos);
  if (primerPago == null) return null;
  if (!u.premium_desde) return primerPago;
  const desde = msDeFechaLima(u.premium_desde);
  return isNaN(desde) ? primerPago : Math.max(desde, primerPago);
}

/**
 * Nuevos Pro reales del mes: los que se dieron de alta (premium_desde) y **los que
 * volvieron** después de haber pedido la baja.
 *
 * La segunda rama no es un extra. `activarPro` hace `usuario.premium_desde || hoy`, o sea
 * que a quien vuelve NO se le mueve la fecha de alta: sin mirar el retorno, el mes en que
 * alguien reactiva sube el MRR con `new_pro = 0` y `churned = 0`, y las dos únicas columnas
 * que existen para explicar el delta de esa fila del chart dicen cero.
 *
 * Las dos ramas se evalúan en OR y cada usuario se cuenta una vez: quien se dio de alta y
 * se fue el mismo mes (el caso real de agosto: pagó el 08, borró el 09) tiene que seguir
 * contando como alta de ese mes, aunque hoy tenga la marca puesta.
 */
export function newProInMonth(
  users: HistoryUserRow[],
  monthStart: Date,
  monthEnd: Date,
  pagos: PagosConPlata,
): number {
  const enVentana = (ms: number) => ms >= monthStart.getTime() && ms <= monthEnd.getTime();
  return users.filter(isRevenueUser).filter((u) => {
    // Fuera del dominio del índice no hay nada que preguntar y `pagosDe` lanzaría. Un usuario
    // sin plan Pro, sin fechas de `premium_*` y sin baja no puede ser alta de ningún mes.
    if (!necesitaIndicePagos(u)) return false;
    // Dos ramas, no tres, y son eventos DISTINTOS: darse de alta, y volver después de haberse
    // ido. Cada una es una fecha única por usuario, así que ninguna persona puede contarse dos
    // veces por el mismo evento. Cuando coinciden —alguien que se fue sin haber pagado nunca y
    // después paga— el `filter` la cuenta una sola vez igual.
    const alta = altaComercial(u, pagos);
    if (alta != null && enVentana(alta)) return true;
    const retorno = primerRetorno(u, pagos);
    return retorno != null && enVentana(retorno);
  }).length;
}

/** Churn real cuyo vencimiento cae en [monthStart, monthEnd] y hoy ya es free. */
export function churnedInMonth(
  users: HistoryUserRow[],
  monthStart: Date,
  monthEnd: Date,
  pagos: PagosConPlata,
): number {
  return users.filter(isRevenueUser).filter((u) => {
    // Mismo criterio que `computeChurn`: la baja cuenta en el mes en que se pidió, no
    // cuando vence el plan. Si difirieran, el chart mensual y el KPI de 30d contarían
    // cosas distintas sobre la misma persona.
    //
    // `esProPagado &&` NO es redundante: sin él, un usuario FREE que borra sus datos entra
    // al numerador mientras la base solo cuenta pagadores. Un free que se va no es una baja
    // de ingreso, porque nunca hubo ingreso.
    //
    // Esta columna del chart cuenta EVENTOS del mes, así que una baja cuenta aunque la
    // persona haya vuelto ese mismo mes: ese mes tuvo una baja y un alta, `newProInMonth`
    // reporta el retorno, y `+1 − 1` reconcilia con un MRR que no se movió. La primera
    // versión suprimía la baja en ese caso para "no contradecir al MRR" y lograba lo
    // contrario: la fila decía +1 Pro nuevo con el MRR plano y nada que lo explicara.
    // (El KPI de churn a 30 días sí exige que siga ida: ahí la base son los que pagan HOY y
    // contar a alguien de los dos lados del ratio es otra cosa. Ver `computeChurn`.)
    // Se descarta a quien no puede ser churn ANTES de consultar el índice, por el mismo
    // motivo que en `computeChurn`: el índice solo cubre a quien `necesitaIndicePagos`, y
    // preguntarle por un free lanza. Las dos formas de ser churn garantizan estar adentro.
    const pagador = esProPagado(u);
    const porBaja = pagador && !!u.cuenta_borrada_at;
    const porVencimiento = !pagador && !!u.premium_vence;
    if (!porBaja && !porVencimiento) return false;
    // Quien nunca pagó no puede churnear: no hay ingreso que perder. Sin este corte, el mes
    // en que se vence una cortesía aparece como una baja de un cliente que nunca existió.
    // `nuncaPagoAl` y no `esCortesiaAl`: acá la mitad de los candidatos ya son free, y sobre
    // un free la cortesía devuelve false — un "no" que parece respuesta y no lo es.
    if (nuncaPagoAl(u, pagos, monthEnd.getTime())) return false;
    if (porBaja) {
      const baja = new Date(u.cuenta_borrada_at as string).getTime();
      if (!isNaN(baja)) return baja >= monthStart.getTime() && baja <= monthEnd.getTime();
      return false;
    }
    const vence = msDeFechaLima(u.premium_vence as string);
    return vence >= monthStart.getTime() && vence <= monthEnd.getTime();
  }).length;
}

export interface ChurnSummary {
  churned: number; // Pro reales que vencieron en los últimos 30d y hoy son free
  rate: number; // churned / (churned + pro reales) * 100, redondeado a 1 decimal
}

/**
 * Churn 30d unificado (fuente única para stats y economics). Excluye internos
 * en numerador y base. Base = churned reales + Pro reales activos.
 *
 * **Una baja declarada es churn, y contarla a medias invierte el signo.** El primer intento
 * de este cambio la descontaba solo de `computeRevenue`: el numerador quedaba igual y la
 * base la seguía CONTANDO, así que dos clientes que se iban **bajaban** la tasa de churn —
 * y como `ltvProPen = margen / churn`, subían el LTV. La señal más fuerte de abandono que
 * tiene el producto mejoraba los números. La regla que deja: cualquier cambio acá se evalúa
 * mirando TODAS las funciones de este archivo a la vez, no la que estás tocando.
 */
export function computeChurn(
  users: HistoryUserRow[],
  now: Date,
  pagos: PagosConPlata,
): ChurnSummary {
  const real = users.filter(isRevenueUser);
  const thirtyAgo = new Date(now.getTime() - 30 * 86400000);
  const enVentana = (valor: string | null | undefined, esFechaDate = false) => {
    if (!valor) return false;
    const t = esFechaDate ? msDeFechaLima(valor) : new Date(valor).getTime();
    return !isNaN(t) && t >= thirtyAgo.getTime() && t < now.getTime();
  };
  const churned = real.filter((u) => {
    // **Primero se descarta a quien NO puede ser churn, y recién después se toca el índice.**
    // El orden no es estilo: `nuncaPagoAl` consulta el índice, y el índice solo cubre a quien
    // `necesitaIndicePagos`. Con la pregunta adelante, un usuario free —o uno en trial, que
    // tampoco tiene `premium_*`— caía fuera del dominio y `pagosDe` lanzaba: 500 en
    // `/admin/operacion` y `/admin/economics` con cualquier base real. Lo encontró la revisión
    // adversarial del cambio, no la suite, porque los casos usan un dominio abierto.
    //
    // Hay exactamente dos formas de ser churn, y las dos garantizan estar en el dominio:
    //   · pagador que pidió la baja (churn ya, sin esperar a que venza el plan: es lo que hace
    //     visible al anual que se fue en agosto y cuyo `premium_vence` es 2027);
    //   · ex-Pro cuyo plan venció.
    // `esProPagado` separa las dos y de paso filtra al free que borra sus datos: un free que
    // se va no es una baja de ingreso, porque nunca hubo ingreso.
    const pagador = esProPagado(u);
    const porBaja = pagador && !!u.cuenta_borrada_at;
    const porVencimiento = !pagador && !!u.premium_vence;
    if (!porBaja && !porVencimiento) return false;
    // Sin ingreso no hay churn. La base de abajo ya usa `esProActivo`, que también excluye la
    // cortesía, así que queda fuera de los DOS lados del ratio: contarla en uno solo movería
    // la tasa sin que se hubiera ido nadie.
    if (nuncaPagoAl(u, pagos, now.getTime())) return false;
    if (porBaja) {
      return bajaVigenteAl(u, now.getTime(), pagos) ? enVentana(u.cuenta_borrada_at) : false;
    }
    return enVentana(u.premium_vence, true);
  }).length;
  // La base son los que SIGUEN pagando: una baja no puede estar en los dos lados del ratio.
  const pro = real.filter((u) => esProActivo(u, pagos, now)).length;
  const base = churned + pro;
  const rate = base > 0 ? Math.round((churned / base) * 1000) / 10 : 0;
  return { churned, rate };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
