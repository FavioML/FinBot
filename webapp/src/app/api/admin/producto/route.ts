import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import { EXCLUDED_REVENUE_WHATSAPP } from '@/lib/admin-revenue';
import type {
  AdminProducto,
  AdminRetention,
  EngagementBucket,
  FeatureAdoptionRow,
  RetentionCohort,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const PERIODS = [0, 1, 2, 3, 4, 5];

interface RetentionRow {
  cohort: string;
  cohort_size: number | string;
  period: number;
  active: number | string;
}

interface AdoptionRow {
  feature: string;
  users: number | string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Primer instante (ms UTC) del mes de la cohorte 'YYYY-MM'. Un periodo se marca "maduro" cuando
// su ventana ya transcurrió medida desde el inicio del mes, es decir cuando incluso el miembro
// MÁS ANTIGUO de la cohorte la completó. Convención estándar de retención: no se pinta un periodo
// que aún no transcurrió para nadie (evitaría un 0% que en realidad es "muy pronto"); la cohorte
// en curso muestra sus periodos como un piso que sube a medida que maduran.
function cohortMonthStartMs(cohort: string): number {
  const [y, m] = cohort.split('-').map(Number); // m = 1..12
  return Date.UTC(y, m - 1, 1);
}

export async function GET() {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getServiceClient();
  const excluded = Array.from(EXCLUDED_REVENUE_WHATSAPP);

  const [retRes, engRes, adoptRes] = await Promise.all([
    db.rpc('admin_retention_cohorts', { p_excluded: excluded }),
    db.rpc('admin_engagement_distribution', { p_excluded: excluded }),
    db.rpc('admin_feature_adoption', { p_excluded: excluded }),
  ]);

  const err = retRes.error || engRes.error || adoptRes.error;
  if (err) {
    return NextResponse.json(
      { error: 'No se pudieron leer métricas de producto', detail: err.message },
      { status: 500 },
    );
  }

  // --- Engagement (jsonb directo del RPC) ---
  const engRaw = (engRes.data ?? {}) as {
    total?: number | string;
    dormant?: number | string;
    mean?: number | string;
    median?: number | string;
    buckets?: EngagementBucket[];
  };
  const engagement = {
    total: Number(engRaw.total ?? 0),
    dormant: Number(engRaw.dormant ?? 0),
    mean: Number(engRaw.mean ?? 0),
    median: Number(engRaw.median ?? 0),
    buckets: (engRaw.buckets ?? []).map((b) => ({
      bucket: b.bucket,
      usuarios: Number(b.usuarios),
    })),
  };
  const totalUsers = engagement.total;

  // --- Retención: pivotea las filas largas (cohorte × periodo) a una fila por cohorte, y marca
  // qué celdas ya maduraron (en JS, con "ahora"). Newest-first para lectura del fundador. ---
  const now = Date.now();
  const byCohort = new Map<string, RetentionCohort>();
  for (const raw of (retRes.data ?? []) as RetentionRow[]) {
    let c = byCohort.get(raw.cohort);
    if (!c) {
      c = { cohort: raw.cohort, size: Number(raw.cohort_size), cells: [] };
      byCohort.set(raw.cohort, c);
    }
    const active = Number(raw.active);
    const mature = cohortMonthStartMs(raw.cohort) + (raw.period + 1) * 30 * 86400000 <= now;
    c.cells.push({
      period: raw.period,
      active,
      mature,
      rate: mature && c.size > 0 ? round1((active / c.size) * 100) : null,
    });
  }
  const retention: AdminRetention = {
    periods: PERIODS,
    cohorts: Array.from(byCohort.values()).sort((a, b) => b.cohort.localeCompare(a.cohort)),
  };

  // --- Adopción: porcentaje sobre el total real (mismo denominador que engagement). ---
  const adoption: FeatureAdoptionRow[] = ((adoptRes.data ?? []) as AdoptionRow[])
    .map((r) => {
      const users = Number(r.users);
      return {
        feature: r.feature,
        users,
        pct: totalUsers > 0 ? round1((users / totalUsers) * 100) : 0,
      };
    })
    .sort((a, b) => b.users - a.users);

  const payload: AdminProducto = {
    retention,
    engagement,
    adoption,
    total_users: totalUsers,
  };

  return NextResponse.json(payload);
}
