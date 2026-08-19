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
export type PagosConPlata = ReadonlyMap<string, number[]>;

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
export function indexarPagosConPlata(pagos: PagoRow[]): Map<string, number[]> {
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
  return idx;
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
 * Un usuario sin `id` no puede probar un retorno (no hay a quién buscarle los pagos) y
 * queda como baja. Las tres rutas admin traen `id` en el select y el guard de call-sites
 * lo exige, así que en producción ese caso no existe.
 */
export function bajaVigenteAl(
  u: RevenueUserRow,
  hastaMs: number,
  pagos: PagosConPlata,
): boolean {
  if (!u.cuenta_borrada_at) return false;
  const baja = new Date(u.cuenta_borrada_at).getTime();
  if (isNaN(baja) || baja > hastaMs) return false; // todavía no se había ido
  const cobros = (u.id && pagos.get(u.id)) || [];
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
  return esProPagado(u) && !esBajaDeclarada(u, pagos, ahora);
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
  const pro = pagados.filter((u) => !esBajaDeclarada(u, pagos, ahora));
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
  const posteriores = ((u.id && pagos.get(u.id)) || []).filter((t) => t > baja);
  return posteriores.length ? Math.min(...posteriores) : null;
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
    if (u.premium_desde) {
      const desde = msDeFechaLima(u.premium_desde);
      if (!isNaN(desde) && enVentana(desde)) return true;
    }
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
    if (esProPagado(u) && u.cuenta_borrada_at) {
      const baja = new Date(u.cuenta_borrada_at).getTime();
      if (!isNaN(baja)) return baja >= monthStart.getTime() && baja <= monthEnd.getTime();
    }
    if (esProPagado(u) || !u.premium_vence) return false;
    const vence = msDeFechaLima(u.premium_vence);
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
    // Pidió la baja dentro de la ventana: churn ya, sin esperar a que venza el plan. Es lo
    // que hace visible al anual que se fue en agosto y cuyo `premium_vence` es 2027.
    // `esProPagado &&` filtra al free que borra sus datos (ver `churnedInMonth`).
    if (esProPagado(u) && bajaVigenteAl(u, now.getTime(), pagos)) {
      return enVentana(u.cuenta_borrada_at);
    }
    if (esProPagado(u) || !u.premium_vence) return false;
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
