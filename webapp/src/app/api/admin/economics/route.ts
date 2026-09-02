import { NextResponse } from 'next/server';
import { requireAdminUser, type ActivityRow } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import {
  CAC_REFERIDOS_PEN,
  COST_PER_PRO_USER_PEN,
  PRO_PRICE_MONTHLY_PEN,
} from '@/lib/constants';
import {
  computeRevenue,
  cajaDelMes,
  esProActivo,
  isRevenueUser,
  computeChurn,
  mrrAtMonthEnd,
  newProInMonth,
  churnedInMonth,
  EXCLUDED_REVENUE_WHATSAPP,
  idsParaIndicePagos,
} from '@/lib/admin-revenue';
import { cargarPagosConPlata } from '@/lib/admin-revenue-db';
import { startOfDayLima, startOfMonthLima, todayIsoLima, monthWindowLima } from '@/lib/date-lima';
import type {
  AdminCost,
  AdminCostDueSoon,
  AdminEconomics,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

interface UsuarioRow {
  id: string;
  whatsapp: string | null;
  is_test_user: boolean | null;
  plan: string | null;
  tipo_plan: string | null;
  // Va declarada aunque acá no se lea directo: es la columna que decide si un `plan:'premium'`
  // cuenta como ingreso (esProPagado). El select ya la traía, pero la interfaz no la nombraba,
  // así que el compilador no veía el dato del que depende todo lo de abajo.
  trial_estado: string | null;
  // Misma razón que `trial_estado`: decide si un Pro pagado cuenta como ingreso, y el `as
  // UsuarioRow[]` de más abajo es la única fuente de tipo de estas filas. Omitirla compilaba
  // igual —en `RevenueUserRow` es opcional—, así que ni el compilador ni un guard que mire
  // el `.select()` veían la falta.
  cuenta_borrada_at: string | null;
  premium_desde: string | null;
  premium_vence: string | null;
  created_at: string;
}

function diffDaysUTC(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

export async function GET() {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const db = getServiceClient();
  const now = new Date();
  const todayIso = todayIsoLima(now);
  const startMonth = startOfMonthLima(now); // inicio de mes en día Lima
  const monthAgoIso = new Date(now.getTime() - 30 * 86400000).toISOString();

  // Las seis lecturas son independientes entre sí y antes iban encadenadas.
  //
  // Las dos llamadas a admin_activity_counts (migración 039) reemplazan selects de
  // `transacciones` que contaban filas en JS. Todavía no truncaban porque el mes iba en
  // menos de 1000 filas, pero era el mismo bug que en /api/admin/stats esperando volumen:
  // PostgREST corta en 1000 y el conteo se congela sin devolver ningún error.
  //
  // Se llama dos veces porque son dos ventanas distintas para dos métricas distintas:
  // transacciones del mes CALENDARIO, y usuarios activos de los últimos 30 DÍAS. Pasar los
  // tres parámetros iguales es la forma de pedir una sola ventana.
  const startMonthIso = startMonth.toISOString();
  const [
    usuariosRes,
    costsRes,
    pagosMesRes,
    txTotalRes,
    mesRes,
    treintaRes,
    pnlTotalsRes,
  ] = await Promise.all([
    db
      .from('usuarios')
      // is_test_user va en el select porque isRevenueUser decide por ella: sin traerla, la fila
      // llega con la marca en undefined y una cuenta de prueba entra al MRR como cliente.
      // `cuenta_borrada_at` va por el MISMO motivo: computeRevenue decide por ella, y una
      // columna ausente llega como undefined, que es falsy, así que una baja declarada
      // vuelve al MRR sin que nada falle.
      .select('id, whatsapp, is_test_user, cuenta_borrada_at, plan, tipo_plan, trial_estado, premium_desde, premium_vence, created_at'),
    db.from('admin_costs').select('*').order('next_due_date', { ascending: true }),
    db
      .from('pagos')
      .select('monto, estado, aprobado_at, created_at, usuario_id')
      .gte('created_at', startMonthIso),
    db.from('transacciones').select('id', { count: 'exact', head: true }),
    db.rpc('admin_activity_counts', {
      p_day: startMonthIso,
      p_week: startMonthIso,
      p_month: startMonthIso,
    }),
    db.rpc('admin_activity_counts', {
      p_day: monthAgoIso,
      p_week: monthAgoIso,
      p_month: monthAgoIso,
    }),
    db.rpc('admin_pnl_totals', {
      p_excluded: Array.from(EXCLUDED_REVENUE_WHATSAPP),
    }),
  ]);

  // NINGUNA de las siete puede fallar en silencio. `supabase-js` no lanza: devuelve
  // `{data: null, error}`, y estas siete destructuraciones descartaban el error, así que un
  // hipo del pooler pintaba **"MRR S/0.00 · 0 Pro activos"** en verde con HTTP 200 — y como
  // la respuesta era 200, el `ErrorState` que existe justamente para esto nunca se disparaba.
  // La peor era `admin_costs`: sin costos, `breakeven_gap` sale negativo y la tarjeta dice
  // "✓ Breakeven alcanzado".
  //
  // Es la misma política que ya aplica `cargarPagosConPlata`. Tenerla en una lectura de 10
  // filas y no en la de 115 que decide el mismo número era la asimetría, no la política.
  const lecturas: Array<[string, { message: string } | null]> = [
    ['usuarios', usuariosRes.error],
    ['admin_costs', costsRes.error],
    ['pagos', pagosMesRes.error],
    ['transacciones', txTotalRes.error],
    ['admin_activity_counts (mes)', mesRes.error],
    ['admin_activity_counts (30d)', treintaRes.error],
    ['admin_pnl_totals', pnlTotalsRes.error],
  ];
  const fallo = lecturas.find(([, e]) => e);
  if (fallo) {
    return NextResponse.json(
      { error: `No se pudo leer ${fallo[0]}: ${fallo[1]!.message}` },
      { status: 500 },
    );
  }

  const usuariosRaw = usuariosRes.data;
  const costsRaw = costsRes.data;
  const pagosMes = pagosMesRes.data;
  const txTotalCount = txTotalRes.count;
  const mesRows = mesRes.data;
  const treintaRows = treintaRes.data;
  const pnlTotalsRows = pnlTotalsRes.data;

  // --- Users ---
  const usuarios = (usuariosRaw || []) as UsuarioRow[];
  // PostgREST corta en 1000 filas SIN error. Esta lectura no lleva `.limit()` ni `.order()`,
  // así que al pasar el techo faltan usuarios indeterminados: el MRR y `bajas_declaradas`
  // bajan en silencio, y desde este cambio también sale de acá el dominio del índice de pagos.
  if (usuarios.length >= 1000) {
    return NextResponse.json(
      { error: 'La lectura de `usuarios` llegó al techo de 1000 filas de PostgREST: el MRR saldría incompleto. Hay que paginar.' },
      { status: 500 },
    );
  }
  const totalUsers = usuarios.length;
  const freeUsers = usuarios.filter((u) => u.plan !== 'premium');

  const realUsers = usuarios.filter(isRevenueUser);

  // A quién le entró plata alguna vez. Se lee ANTES de computeRevenue porque el MRR depende
  // de esto por dos vías: sin el índice, un cliente que borró su cuenta y después volvió a
  // pagar quedaría descontado del ingreso estando al día, y un Pro de cortesía sumaría S/10
  // que nadie transfirió.
  //
  // **La lista sale de `idsParaIndicePagos`, no se arma acá.** Escribirla a mano es cómo se
  // vuelve a acotar el índice a una población más chica que las preguntas que se le hacen; el
  // `dominio` que sella el índice convierte ese error en un throw, pero la forma de no
  // cometerlo es tener una sola definición.
  //
  // El cargador LANZA cuando no puede leer (falla cerrado, a proposito). Se traduce aca a
  // la misma forma `{error}` con la que responde el resto de la ruta: un throw suelto sale
  // como text/plain y las pantallas muestran 'Failed to load' sin el motivo.
  let pagosConPlata;
  try {
    pagosConPlata = await cargarPagosConPlata(usuarios);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Ingreso: solo negocio real (excluye fundador + QA). Fuente única: admin-revenue.ts.
  const rev = computeRevenue(usuarios, pagosConPlata, now);
  const proCountReal = rev.proCount;
  const proMonthly = rev.proMonthly;
  const proYearly = rev.proYearly;
  const mrr = rev.mrr;
  const arr = rev.arr;

  // Pro de cortesía: tienen el plan y no les entró un sol. **Ya NO están dentro del MRR**, y
  // ese es el cambio del 2026-09-01. Este número existía desde antes con otro nombre
  // (`pro_sin_pago_registrado`) y solo REPORTABA: el comentario decía que el comp se registra
  // en `pagos` con monto 0, y medido contra producción ninguno de los tres caminos que regalan
  // Pro escribía esa fila, así que el regalo entraba al ingreso a precio de lista.
  //
  // Sigue publicándose pegado al MRR porque ahora responde otra cosa: cuánto ingreso se está
  // descontando y por qué. Y es el delator de un pagador mal clasificado — si sube sin que
  // nadie haya regalado nada, hay un cobro que no llega a `pagos`.
  const cortesias = rev.cortesias;

  const newUsersThisMonth = usuarios.filter(
    (u) => new Date(u.created_at) >= startMonth,
  ).length;

  const conversionRate =
    realUsers.length > 0 ? Math.round((proCountReal / realUsers.length) * 1000) / 10 : 0;

  // Churn 30d (fuente única: computeChurn, excluye internos, base = churned + pro reales)
  const churnRate30d = computeChurn(usuarios, now, pagosConPlata).rate;

  // --- Costs ---
  const costs = (costsRaw || []) as AdminCost[];
  const activeCosts = costs.filter((c) => c.active);

  let totalMonthlyCostsPen = 0;
  for (const c of activeCosts) {
    if (c.frequency === 'monthly') totalMonthlyCostsPen += Number(c.amount_pen);
    else if (c.frequency === 'yearly')
      totalMonthlyCostsPen += Number(c.amount_pen) / 12;
  }
  totalMonthlyCostsPen = Math.round(totalMonthlyCostsPen * 100) / 100;
  const totalYearlyCostsPen = Math.round(totalMonthlyCostsPen * 12 * 100) / 100;

  const inSevenDaysIso = (() => {
    const d = new Date(todayIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const costsDueThisWeek: AdminCostDueSoon[] = activeCosts
    .filter(
      (c) =>
        c.next_due_date !== null &&
        c.next_due_date >= todayIso &&
        c.next_due_date <= inSevenDaysIso,
    )
    .map((c) => ({
      id: c.id,
      label: c.label,
      amount_pen: Number(c.amount_pen),
      currency: c.currency,
      amount_original: c.amount_original !== null ? Number(c.amount_original) : null,
      next_due_date: c.next_due_date as string,
      days_until: diffDaysUTC(todayIso, c.next_due_date as string),
    }))
    .sort((a, b) => a.days_until - b.days_until);

  const costsDueToday = activeCosts.filter(
    (c) => c.next_due_date === todayIso,
  ).length;
  const costsOverdue = activeCosts.filter(
    (c) => c.next_due_date !== null && c.next_due_date < todayIso,
  ).length;

  // --- Unit economics ---
  const grossMarginProPen =
    Math.round((PRO_PRICE_MONTHLY_PEN - COST_PER_PRO_USER_PEN) * 100) / 100;
  const breakevenProUsers =
    grossMarginProPen > 0
      ? Math.ceil(totalMonthlyCostsPen / grossMarginProPen)
      : 0;
  const breakevenGap = breakevenProUsers - proCountReal;

  // LTV = margin / churn_rate_monthly. churn_rate_30d already monthly approx.
  // If churn = 0 → fallback to S/100 (10 meses × margen).
  const churnMonthly = churnRate30d / 100;
  const ltvProPen =
    churnMonthly > 0
      ? Math.round((grossMarginProPen / churnMonthly) * 100) / 100
      : Math.round(grossMarginProPen * 10 * 100) / 100;

  // Revenue this month = caja real cobrada: suma de pagos aprobados este mes
  // (excluye cuentas internas). Ya existe la tabla `pagos`, así que es dinero de verdad,
  // no una aproximación al MRR.
  const excludedIds = new Set(
    usuarios.filter((u) => !isRevenueUser(u)).map((u) => u.id),
  );
  const revenueThisMonth = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // --- Activity ---
  // Agregados en SQL. `transactions_this_month` cuenta filas y `active_users_30d` cuenta
  // usuarios distintos: las dos cosas se rompían al pasar las 1000 filas de PostgREST.
  const transactionsTotal = txTotalCount || 0;
  const transactionsThisMonth = Number((mesRows as ActivityRow[] | null)?.[0]?.tx_month ?? 0);
  const activeUsers30d = Number((treintaRows as ActivityRow[] | null)?.[0]?.mau ?? 0);

  // --- MRR history (last 6 months) ---
  const mrrHistory: AdminEconomics['mrr_history'] = [];
  for (let i = 5; i >= 0; i--) {
    // Ventana de mes LIMA. Antes se armaba con `new Date(y, m + 1, 0, 23, 59, 59)`, que es
    // hora local del SERVIDOR: en Vercel (TZ=UTC) ese "fin de mes" son las 18:59:59 de Lima,
    // así que cinco horas del último día caían en el mes siguiente. Daba igual mientras se
    // comparara contra DATEs; `cuenta_borrada_at` es timestamptz y ahí la hora decide.
    const { start: monthStart, end: mesCompleto, label: monthLabel } = monthWindowLima(now, i);
    // El mes en curso todavia no termino: su ventana se corta en `now`. Sin esto, `mrr`
    // se calculaba con `now` y `new_pro`/`churned` con un fin de mes en el FUTURO, o sea
    // que las tres columnas de la misma fila preguntaban por dos instantes distintos.
    const monthEnd = mesCompleto > now ? now : mesCompleto;

    mrrHistory.push({
      month: monthLabel,
      // Mes en curso (i=0): MRR vivo (headline) para que el último punto == KPI MRR.
      // Meses pasados: reconstruido desde premium_desde/premium_vence (no created_at ni
      // la heurística vence−30d). Solo negocio real (excluye internos).
      mrr: i === 0 ? mrr : mrrAtMonthEnd(usuarios, monthEnd, pagosConPlata),
      new_pro: newProInMonth(usuarios, monthStart, monthEnd, pagosConPlata),
      churned: churnedInMonth(usuarios, monthStart, monthEnd, pagosConPlata),
    });
  }

  // --- User growth (12 weeks) ---
  const userGrowth12w: AdminEconomics['user_growth_12w'] = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = startOfDayLima(
      new Date(now.getTime() - (i + 1) * 7 * 86400000),
    );
    const weekEnd = startOfDayLima(new Date(now.getTime() - i * 7 * 86400000));
    const newInWeek = usuarios.filter((u) => {
      const d = new Date(u.created_at);
      return d >= weekStart && d < weekEnd;
    });
    const weekLabel = `${String(weekStart.getUTCDate()).padStart(2, '0')}/${String(
      weekStart.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    userGrowth12w.push({
      week: weekLabel,
      // `free` es el complemento exacto de `pro` (free + pro === total), así que las dos
      // ramas tienen que hacer la MISMA pregunta. Se evalúa sobre la fila de hoy, o sea que
      // es una pregunta sobre el presente: quien pidió borrar su cuenta hoy no es cliente,
      // y contarlo como Pro acá lo dejaba discrepando del KPI de MRR de la misma pantalla.
      free: newInWeek.filter((u) => !esProActivo(u, pagosConPlata, now)).length,
      // Ver M16: el trial vale 'premium' y esta métrica mide conversión, no acceso.
      pro: newInWeek.filter((u) => esProActivo(u, pagosConPlata, now)).length,
      total: newInWeek.length,
    });
  }

  // Margen operativo mensual = MRR − costos mensuales (lo que Neto genera limpio al mes). Caja
  // generada acumulada = result_total del RPC admin_pnl_totals (045): suma histórica de la caja neta.
  const operatingMarginMonthlyPen =
    Math.round((mrr - totalMonthlyCostsPen) * 100) / 100;
  const pnlTotals = (pnlTotalsRows as Array<{ result_total: number | string }> | null)?.[0];
  const cashGeneratedPen = pnlTotals ? Number(pnlTotals.result_total) : 0;

  const economics: AdminEconomics = {
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(arr * 100) / 100,
    revenue_this_month: revenueThisMonth,
    total_users: totalUsers,
    free_users: freeUsers.length,
    pro_users: proCountReal,
    // Pro pagados descontados del MRR porque pidieron borrar su cuenta. Va al JSON para que
    // la caída del MRR tenga explicación en la misma pantalla.
    bajas_declaradas: rev.bajasDeclaradas,
    cortesias,
    conversion_rate: conversionRate,
    new_users_this_month: newUsersThisMonth,
    churn_rate_30d: churnRate30d,
    total_monthly_costs_pen: totalMonthlyCostsPen,
    total_yearly_costs_pen: totalYearlyCostsPen,
    costs_due_this_week: costsDueThisWeek,
    costs_due_today: costsDueToday,
    costs_overdue: costsOverdue,
    gross_margin_pro_pen: grossMarginProPen,
    breakeven_pro_users: breakevenProUsers,
    breakeven_gap: breakevenGap,
    ltv_pro_pen: ltvProPen,
    cac_referidos_pen: CAC_REFERIDOS_PEN,
    operating_margin_monthly_pen: operatingMarginMonthlyPen,
    cash_generated_pen: cashGeneratedPen,
    transactions_total: transactionsTotal,
    transactions_this_month: transactionsThisMonth,
    active_users_30d: activeUsers30d,
    mrr_history: mrrHistory,
    user_growth_12w: userGrowth12w,
  };

  return NextResponse.json(economics);
}
