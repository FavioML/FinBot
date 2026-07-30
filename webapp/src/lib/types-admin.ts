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
  paid_history: AdminCostPaidEntry[];
  last_reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
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
  runway_months: number | null;

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

export interface SurveyConversationMessage {
  id: string;
  rol: string; // 'user' | 'assistant' | other roles existing in conversaciones
  mensaje: string;
  created_at: string;
}
