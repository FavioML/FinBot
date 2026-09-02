export type AdminCostFrequency = 'monthly' | 'yearly' | 'one_time';
export type AdminCostCategory =
  | 'infra'
  | 'domain'
  | 'comms'
  | 'ai'
  | 'compliance'
  | 'tooling'
  | 'other';

export interface AdminCostPaidEntry {
  paid_at: string;
  amount_pen: number;
  marked_by: string;
}

export interface AdminCost {
  id: string;
  label: string;
  category: AdminCostCategory;
  notes: string | null;
  amount_pen: number;
  amount_original: number | null;
  currency: 'PEN' | 'USD';
  frequency: AdminCostFrequency;
  next_due_date: string | null;
  active: boolean;
  // false = manual (dispara recordatorio Telegram); true = débito automático (se cobra solo,
  // solo informativo el día del cobro, el cron auto-avanza y auto-registra el pago).
  auto_debit: boolean;
  paid_history: AdminCostPaidEntry[];
  last_reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

// ===== P&L mensual (Rework Costos, RPC admin_pnl_monthly 044) =====
export interface AdminPnlMonth {
  month: string; // 'YYYY-MM-DD' (primer día del mes Lima)
  income_pen: number; // caja: pagos aprobados del mes (excluye internos)
  cost_pen: number; // suma de paid_history con paid_at en el mes
  result_pen: number; // income_pen - cost_pen
}

export interface AdminPnlResponse {
  months: AdminPnlMonth[];
}

export interface AdminCostDueSoon {
  id: string;
  label: string;
  amount_pen: number;
  currency: 'PEN' | 'USD';
  amount_original: number | null;
  next_due_date: string;
  days_until: number;
}

export interface AdminEconomics {
  // Revenue
  mrr: number;
  arr: number;
  revenue_this_month: number;

  // Users
  total_users: number;
  free_users: number;
  pro_users: number;
  /**
   * Pro que cuentan en el MRR y no tienen NI UN pago aprobado con monto > 0: hoy, un comp
   * (Pro regalado por POST /admin/activar). El MRR los valora como si pagaran, así que este
   * número es cuánto del MRR es humo. Se muestra pegado al KPI de MRR, y solo cuando > 0.
   * Mientras siga en 0 no vale una columna nueva en `usuarios` para distinguirlos.
   */
  /**
   * Pro de cortesía: tienen el plan y nunca les entró un sol, así que NO están en el MRR.
   * Se publica al lado del MRR para que el descuento tenga explicación en la pantalla, y
   * porque delata lo contrario: si sube sin que nadie haya regalado nada, hay un cobro real
   * que no está llegando a la tabla `pagos`.
   */
  cortesias: number;
  /**
   * Pro pagados descontados del MRR porque pidieron borrar su cuenta. Se muestra pegado al
   * KPI de MRR: un número que baja sin explicación en la misma pantalla se lee como un bug
   * del panel, y esta es la explicación.
   */
  bajas_declaradas: number;
  conversion_rate: number;
  new_users_this_month: number;
  churn_rate_30d: number;

  // Costs
  total_monthly_costs_pen: number;
  total_yearly_costs_pen: number;
  costs_due_this_week: AdminCostDueSoon[];
  costs_due_today: number;
  costs_overdue: number;

  // Unit economics
  gross_margin_pro_pen: number;
  breakeven_pro_users: number;
  breakeven_gap: number;
  ltv_pro_pen: number;
  cac_referidos_pen: number;
  // Margen operativo mensual = MRR − costos mensuales (lo que Neto genera limpio al mes; puede ser
  // negativo). Caja generada acumulada = suma histórica de (ingresos − costos pagados) = result_total
  // del RPC admin_pnl_totals. Reemplazan al runway (no aplica: Neto es cash-positive en infra).
  operating_margin_monthly_pen: number;
  cash_generated_pen: number;

  // Activity
  transactions_total: number;
  transactions_this_month: number;
  active_users_30d: number;

  // Charts data
  mrr_history: Array<{
    month: string;
    mrr: number;
    new_pro: number;
    churned: number;
  }>;
  user_growth_12w: Array<{
    week: string;
    free: number;
    pro: number;
    total: number;
  }>;
}

// ===== Survey events (UPDATE-05) =====

export type SurveyEventType =
  | 'reminder_d3'
  | 'reminder_d7'
  | 'reminder_d14'
  | 'reminder_d30'
  | 'webapp_invite_10tx'
  | 'feedback_open_30tx'
  | 'nps_inapp'
  | 'inactivity_reminder'
  | 'pro_upsell_d28';

export type SurveyChannel = 'whatsapp' | 'webapp';

export interface NpsResponseData {
  ease: number;        // 1-5
  usefulness: number;  // 1-5
  recommend: number;   // 1-5
  comment?: string | null;
}

export interface FeedbackResponseData {
  reply_text: string;
}

export interface ReminderResponseData {
  user_replied: boolean;
  reply_text?: string;
}

export interface WebappInviteResponseData {
  logged_in_webapp_within_7d: boolean;
}

export interface InactivityReminderData {
  dias_sin_tx: number;
}

export type SurveyResponseData =
  | NpsResponseData
  | FeedbackResponseData
  | ReminderResponseData
  | WebappInviteResponseData
  | InactivityReminderData
  | Record<string, unknown>
  | null;

export interface SurveyEvent {
  id: string;
  user_id: string;
  user_nombre?: string | null;
  user_whatsapp?: string | null;
  user_plan?: 'free' | 'premium' | null;
  user_fecha_pago?: string | null;
  event_type: SurveyEventType;
  channel: SurveyChannel;
  triggered_at: string;
  sent_at: string | null;
  responded_at: string | null;
  dismissed_at: string | null;
  // message_sent salio del listado (Ola 2): era 73% del payload de la tabla y su unico consumo
  // era un title= de hover. El texto real de la conversacion vive en el dialogo de chat.
  response_data: SurveyResponseData;
  conversion_within_24h: boolean;
  conversion_within_7d: boolean;
  opted_out_after: boolean;
  // Computed server-side for pro_upsell_d28 rows
  converted_to_pro?: boolean;
  days_to_conversion?: number | null;
  was_pro_at_send?: boolean;
  created_at: string;
}

export interface SurveyTypeStats {
  count_sent: number;
  count_responded: number;
  count_dismissed: number;
  response_rate: number;
  opt_out_rate: number;
  conversion_rate?: number;
  conversion_to_pro_rate?: number;
  count_converted_to_pro?: number;
  nps_avg_ease?: number;
  nps_avg_usefulness?: number;
  nps_avg_recommend?: number;
}

export interface SurveyStats {
  by_event_type: Partial<Record<SurveyEventType, SurveyTypeStats>>;
  totals: {
    total_sent: number;
    total_responded: number;
  };
}

// ===== Product metrics (Ola 3: retención, engagement, adopción) =====

export interface RetentionCell {
  period: number;
  active: number;
  rate: number | null; // null = periodo aún no maduró (no pintar como churn)
  mature: boolean;
}

export interface RetentionCohort {
  cohort: string; // 'YYYY-MM'
  size: number;
  cells: RetentionCell[];
}

export interface AdminRetention {
  periods: number[];
  cohorts: RetentionCohort[];
}

export interface EngagementBucket {
  bucket: string;
  usuarios: number;
}

export interface AdminEngagement {
  total: number;
  dormant: number;
  mean: number;
  median: number;
  buckets: EngagementBucket[];
}

export interface FeatureAdoptionRow {
  feature: string;
  users: number;
  pct: number;
}

export interface AdminProducto {
  retention: AdminRetention;
  engagement: AdminEngagement;
  adoption: FeatureAdoptionRow[];
  total_users: number;
  /**
   * Cupos gastados de los 100 que da Google a la app OAuth sin certificar. Va aparte de
   * `adoption` porque no es adopción: su denominador es 100, no `total_users`, y cuenta
   * también las cuentas internas — el cupo se gasta igual y no se recupera nunca.
   */
  gmail_cupo: number;
}

export interface SurveyConversationMessage {
  id: string;
  rol: string; // 'user' | 'assistant' | other roles existing in conversaciones
  mensaje: string;
  created_at: string;
}

// ===== Ficha individual de usuario (Ola 4 Fase 2, RPC admin_user_features 043) =====
export interface AdminUserFeatures {
  transacciones: number;
  categorias: number;
  presupuestos: number;
  deudas: number;
  metas: number;
  espacios: number;
  alertas: number;
  /** Último valor del Neto Score (migración 053), no el número de cálculos. null = nunca tuvo. */
  score: number | null;
  /** Unión de las dos fuentes: token legacy en `usuarios` ∪ `gmail_cuentas.activa`. */
  gmail: boolean;
  /** Conectado pero con la autorización caída: hay que pedirle que reconecte. */
  gmail_caido?: boolean;
  tickets: number;
  pagos_aprobados: number;
  ltv_pen: number;
}

export interface AdminUserNps {
  responded_at: string | null;
  response_data: {
    ease?: number;
    usefulness?: number;
    recommend?: number;
    comment?: string;
  } | null;
}

export interface AdminUserFichaResponse {
  ok: boolean;
  features: AdminUserFeatures | null;
  nps: AdminUserNps | null;
}
