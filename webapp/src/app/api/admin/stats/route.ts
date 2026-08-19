import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import {
  computeRevenue,
  cajaDelMes,
  isRevenueUser,
  computeChurn,
  mrrAtMonthEnd,
  newProInMonth,
  churnedInMonth,
  esProActivo,
  EXCLUDED_REVENUE_WHATSAPP,
} from '@/lib/admin-revenue';
import { cargarPagosConPlata } from '@/lib/admin-revenue-db';
import { startOfDayLima, startOfMonthLima, monthWindowLima } from '@/lib/date-lima';
import { requireAdminUser, type ActivityRow, type UserTxStatsRow } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getServiceClient();
  const now = new Date();
  // "Hoy" en día Lima (UTC-5): Lima 00:00 = UTC 05:00. Ver lib/date-lima.ts.
  const todayLimaIso = startOfDayLima(now).toISOString();

  // 7 days ago
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  // 30 days ago
  const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
  // inicio de mes día Lima
  const startMonthIso = startOfMonthLima(now).toISOString();

  // Las cinco lecturas son independientes: en serie eran cinco roundtrips encadenados.
  //
  // Las dos RPC (migración 039) agregan en SQL lo que antes se agregaba en JS sobre filas
  // crudas. PostgREST corta la respuesta en 1000 filas, así que `transacciones` (2123)
  // llegaba truncada SIN error: el embudo veía 21 de 44 usuarios activados (25% reportado
  // vs 52% real) y DAU/WAU/MAU estaban a una semana de congelarse igual. La regla que sale
  // de ahí: no traigas filas para contarlas, cuéntalas en SQL.
  const [usuariosRes, pagosMesRes, activityRes, txStatsRes, nlpRes] = await Promise.all([
    db
      .from('usuarios')
      .select(
        // is_test_user va en el select porque isRevenueUser decide por ella: sin traerla, la
        // fila llega con la marca en undefined y una cuenta de prueba entra al MRR como cliente.
        // Idem `cuenta_borrada_at`: si no se pide, llega undefined —falsy— y computeRevenue
        // no puede descontar una baja que sí ocurrió.
        'id, whatsapp, is_test_user, cuenta_borrada_at, plan, tipo_plan, trial_estado, trial_vence, onboarding_completado, created_at, premium_desde, premium_vence, supabase_auth_id',
      ),
    db
      .from('pagos')
      .select('monto, estado, aprobado_at, created_at, usuario_id')
      .gte('created_at', startMonthIso),
    db.rpc('admin_activity_counts', {
      p_day: todayLimaIso,
      p_week: weekAgo,
      p_month: monthAgo,
    }),
    db.rpc('admin_user_tx_stats'),
    db
      .from('nlp_errors')
      .select('created_at')
      .neq('error_tipo', 'rate_limit') // 429 de OpenAI es infra, no NLP: fuera del chart
      .gte('created_at', monthAgo)
      .order('created_at', { ascending: true }),
  ]);

  // Ninguna puede fallar en silencio: `supabase-js` devuelve `{data: null, error}` y no
  // lanza, así que descartar el error pintaba **"MRR S/0.00"** y **"Caja del mes S/0"** en
  // verde con HTTP 200 — y con la respuesta en 200, el `ErrorState` de /admin/operacion no
  // se dispara. Misma política que `cargarPagosConPlata`, ahora también donde decide.
  const lecturas: Array<[string, { message: string } | null]> = [
    ['usuarios', usuariosRes.error],
    ['pagos', pagosMesRes.error],
    ['admin_activity_counts', activityRes.error],
    ['admin_user_tx_stats', txStatsRes.error],
    ['nlp_errors', nlpRes.error],
  ];
  const fallo = lecturas.find(([, e]) => e);
  if (fallo) {
    return NextResponse.json(
      { error: `No se pudo leer ${fallo[0]}: ${fallo[1]!.message}` },
      { status: 500 },
    );
  }

  const usuarios = usuariosRes.data;
  const pagosMes = pagosMesRes.data;
  const activityRows = activityRes.data;
  const txStats = txStatsRes.data;
  const nlpRaw = nlpRes.data;

  const allUsers = usuarios || [];
  const totalUsers = allUsers.length;
  // PostgREST corta en 1000 filas SIN error, y de esta lectura sale además el dominio del
  // índice de pagos: truncada, el MRR baja en silencio.
  if (allUsers.length >= 1000) {
    return NextResponse.json(
      { error: 'La lectura de `usuarios` llegó al techo de 1000 filas de PostgREST: el MRR saldría incompleto. Hay que paginar.' },
      { status: 500 },
    );
  }

  // --- Revenue KPIs (solo usuarios reales: excluye fundador + QA) ---
  // MRR normalizado (anual = S/99÷12), ARR, y desglose anual/mensual. Ver admin-revenue.ts.
  // Los pagos de quienes pidieron la baja: es el único testigo de que alguno volvió. Acá
  // alcanza con esos ids —a diferencia de /economics, esta ruta no reporta
  // `pro_sin_pago_registrado`— y con la lista vacía ni siquiera va a la red.
  // El cargador LANZA cuando no puede leer (falla cerrado, a proposito). Se traduce aca a
  // la misma forma `{error}` con la que responde el resto de la ruta: un throw suelto sale
  // como text/plain y las pantallas muestran 'Failed to load' sin el motivo.
  let pagosConPlata;
  try {
    pagosConPlata = await cargarPagosConPlata(
    allUsers.filter((u) => u.cuenta_borrada_at).map((u) => u.id),
  );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  const rev = computeRevenue(allUsers, pagosConPlata, now);
  const mrr = rev.mrr;
  const arr = rev.arr;
  const realUsers = allUsers.filter(isRevenueUser);
  const conversionRate =
    realUsers.length > 0 ? Math.round((rev.proCount / realUsers.length) * 1000) / 10 : 0;

  // Caja real cobrada este mes (pagos aprobados), distinta del MRR recurrente.
  const excludedIds = new Set(
    allUsers.filter((u) => !isRevenueUser(u)).map((u) => u.id),
  );
  const cajaMes = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // Churn 30d (fuente única: computeChurn, excluye internos, base = churned + pro reales).
  // Idéntico a economics para que no diverjan las dos rutas.
  const churnRate = computeChurn(allUsers, now, pagosConPlata).rate;

  // DAU/WAU/MAU: usuarios DISTINTOS, contados con count(distinct) en SQL.
  // Dos bugs vividos que este bloque cierra:
  //   1. Contar filas en vez de usuarios (un user con 15 tx hoy daba DAU=15, rompiendo el
  //      invariante DAU <= WAU <= MAU).
  //   2. Contar en JS sobre la respuesta de PostgREST, que viene topada en 1000 filas. MAU
  //      iba en 765 de 1000: se habría congelado sin avisar, igual que el embudo.
  const activity = (activityRows as ActivityRow[] | null)?.[0];
  const dau = Number(activity?.dau ?? 0);
  const wau = Number(activity?.wau ?? 0);
  const mau = Number(activity?.mau ?? 0);

  // Txs per active user this month
  const totalTxMonth = Number(activity?.tx_month ?? 0);
  const txPerActiveUser = mau > 0 ? Math.round((totalTxMonth / mau) * 10) / 10 : 0;

  // Primera transacción por usuario: min(created_at) agregado en SQL (una fila por usuario),
  // no la tabla entera ordenada ASC. Al pedirla ordenada ascendente, el truncado a 1000 filas
  // congelaba la ventana en el pasado y RETROCEDÍA con cada transacción nueva: el corte estaba
  // en el 07-jun-2026 y todo usuario activado después era invisible para el embudo.
  const firstTxByUser: Record<string, string> = {};
  for (const row of (txStats as UserTxStatsRow[] | null) || []) {
    if (row.first_tx) firstTxByUser[row.usuario_id] = row.first_tx;
  }

  let totalDaysToFirstTx = 0;
  let usersWithTx = 0;
  for (const u of realUsers) {
    const firstTx = firstTxByUser[u.id];
    if (firstTx) {
      const days = (new Date(firstTx).getTime() - new Date(u.created_at).getTime()) / 86400000;
      totalDaysToFirstTx += Math.max(0, days);
      usersWithTx++;
    }
  }
  const avgTimeToFirstTx = usersWithTx > 0 ? Math.round((totalDaysToFirstTx / usersWithTx) * 10) / 10 : 0;

  // --- User Growth (last 12 weeks) ---
  const userGrowth: { week: string; free: number; pro: number; total: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    // Semanas alineadas a día Lima (igual que economics) para que ambos charts coincidan.
    const weekStart = startOfDayLima(new Date(now.getTime() - (i + 1) * 7 * 86400000));
    const weekEnd = startOfDayLima(new Date(now.getTime() - i * 7 * 86400000));
    const weekLabel = `${String(weekStart.getUTCDate()).padStart(2, '0')}/${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}`;

    const newUsers = allUsers.filter((u) => {
      const d = new Date(u.created_at);
      return d >= weekStart && d < weekEnd;
    });

    userGrowth.push({
      week: weekLabel,
      // Complemento EXACTO de `pro` (free + pro === total), igual que en /economics. Con
      // `plan !== 'premium'` un trial y una baja no caían en ninguna de las dos ramas, así
      // que el área apilada del chart perdía altura y las dos rutas del mismo panel daban
      // números distintos para la misma semana — con el comentario de arriba diciendo
      // "para que ambos charts coincidan".
      free: newUsers.filter((u) => !esProActivo(u, pagosConPlata, now)).length,
      // `esProActivo`, no `plan === 'premium'`: durante el trial esa columna vale 'premium',
      // así que esta métrica —que es de CONVERSIÓN— contaba a quien está probando como si
      // hubiera pagado (hallazgo M16). Y descuenta la baja declarada por el mismo motivo por
      // el que la descuenta el MRR: las dos salen del mismo JSON y hablaban de la misma
      // persona con números distintos.
      pro: newUsers.filter((u) => esProActivo(u, pagosConPlata, now)).length,
      total: newUsers.length,
    });
  }

  // --- Onboarding Funnel ---
  // Solo pasos anidados y monotónicos: registro → onboarding → 1a tx → Pro.
  // "Webapp" NO va en el embudo (no es downstream de 1a tx: un user puede tener webapp
  // sin transacción), va aparte como métrica de cobertura para no simular un embudo falso.
  // Los cuatro pasos comparten universo: gente real (sin cuentas de prueba ni internas). El paso
  // Pro ya excluía (rev.proCount) mientras los tres primeros contaban la tabla entera, así que el
  // embudo cambiaba de denominador a mitad de camino y hacía ver la conversión final peor de lo
  // que es. Las altas de QA no son gente que activar.
  const realIds = new Set(realUsers.map((u) => u.id));
  const registered = realUsers.length;
  const onboardingComplete = realUsers.filter((u) => u.onboarding_completado).length;
  const withFirstTx = Object.keys(firstTxByUser).filter((id) => realIds.has(id)).length;

  const funnel = {
    registered,
    onboardingComplete,
    firstTransaction: withFirstTx,
    pro: rev.proCount, // Pro reales (excluye internos), coherente con MRR
  };
  // Cobertura webapp (Google OAuth + Magic Link): transversal, fuera del embudo pero sobre el
  // mismo universo, o sea comparable con `registered`.
  const webappCoverage = realUsers.filter((u) => !!u.supabase_auth_id).length;

  // --- NLP Errors per day (last 30 days) ---
  // La lectura sube al Promise.all de arriba; acá solo queda el agrupado por día.
  const nlpByDay: Record<string, number> = {};
  // Initialize all 30 days
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
    nlpByDay[key] = 0;
  }
  for (const err of nlpRaw || []) {
    const d = new Date(err.created_at);
    const key = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
    if (key in nlpByDay) nlpByDay[key]++;
  }

  const nlpActivity = Object.entries(nlpByDay).map(([date, errors]) => ({ date, errors }));

  // --- Revenue (last 6 months) ---
  const revenue: { month: string; mrr: number; newPro: number; churned: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    // Ventana de mes LIMA (ver monthWindowLima): el constructor anterior era hora local del
    // servidor, o sea 18:59:59 de Lima en Vercel.
    const { start: mDate, end: mesCompleto, label: monthLabel } = monthWindowLima(now, i);
    // El mes en curso se corta en `now`: las tres columnas de la fila tienen que preguntar
    // por el mismo instante (ver /economics).
    const mEnd = mesCompleto > now ? now : mesCompleto;

    revenue.push({
      month: monthLabel,
      // Mes en curso (i=0): MRR vivo (headline) para que el último punto == KPI MRR.
      // Meses pasados: reconstruido desde premium_desde/premium_vence (no created_at ni
      // la heurística vence−30d). Solo negocio real (excluye internos). Idéntico a economics.
      mrr: i === 0 ? mrr : mrrAtMonthEnd(allUsers, mEnd, pagosConPlata),
      newPro: newProInMonth(allUsers, mDate, mEnd, pagosConPlata),
      churned: churnedInMonth(allUsers, mDate, mEnd, pagosConPlata),
    });
  }

  return NextResponse.json({
    ok: true,
    kpis: {
      mrr,
      arr,
      cajaMes,
      proReal: rev.proCount,
      // Cuántos Pro pagados NO están en el MRR porque pidieron borrar su cuenta.
      bajasDeclaradas: rev.bajasDeclaradas,
      proMonthly: rev.proMonthly,
      proYearly: rev.proYearly,
      churnRate,
      dau,
      wau,
      mau,
      conversionRate,
      avgTimeToFirstTx,
      txPerActiveUser,
    },
    userGrowth,
    funnel,
    webappCoverage,
    nlpActivity,
    revenue,
  });
}
