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
