export interface Usuario {
  id: string;
  /** null para cuentas web-first (registradas por Google sin vincular WhatsApp aún). */
  whatsapp: string | null;
  nombre?: string;
  email?: string;
  plan: 'free' | 'premium';
  plan_expiry?: string;
  premium_vence?: string;
  estado_pago?: 'pendiente' | 'pagado' | 'vencido';
  tipo_plan?: 'mensual' | 'anual';
  fecha_pago?: string;
  fecha_vencimiento?: string;
  aprobado_gcc?: boolean;
  supabase_auth_id?: string;
  /** Descuento de referido: 50% off del primer mes Pro. Sembrado al registrarse con un link. */
  referido_dscto_pct?: number | null;
  /** Fecha (YYYY-MM-DD, Lima) en que vence el descuento de referido (7 días desde el alta). */
  referido_dscto_vence?: string | null;
  /** El usuario ya vio el tour de onboarding del dashboard (gate server-side, 1 vez por cuenta). */
  tour_visto?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Transaccion {
  id: string;
  usuario_id: string;
  tipo: 'gasto' | 'ingreso';
  monto: number;
  moneda: 'PEN' | 'USD';
  monto_pen: number;
  tipo_cambio?: number;
  metodo_pago?: string;
  comercio?: string;
  categoria: string;
  subcategoria: string;
  banco?: string;
  /** Últimos 4 dígitos de la tarjeta/cuenta origen (o undefined si la fuente no la expone). */
  tarjeta_last4?: string;
  fecha: string;
  descripcion_original?: string;
  confirmado: boolean;
  created_at: string;
}

export interface Presupuesto {
  id: string;
  usuario_id: string;
  categoria: string;
  subcategoria?: string;
  monto_limite: number;
  alerta_porcentaje: number;
  mes: number;
  anio: number;
  created_at: string;
  updated_at: string;
}

export interface Referido {
  id: string;
  usuario_id: string;
  codigo: string;
  usuario_referido_id?: string;
  plan_bonus: string;
  activado: boolean;
  created_at: string;
}

// Overrides de usuario sobre Suscripciones / Pagos Recurrentes (tabla recurrentes_overrides)
export interface RecurringOverride {
  id?: string;
  usuario_id?: string;
  dominio: 'recurrente' | 'suscripcion';
  /** comercio normalizado (lowercase+trim) o catalog id, según el dominio */
  clave_variante: string;
  /** clave canónica a la que se une (alias). Si === clave_variante = "pin/separar" (no auto-fusionar) */
  id_canonico?: string | null;
  label_canonico?: string | null;
  oculto?: boolean;
  es_recurrente_manual?: boolean | null;
  catalog_id?: string | null;
  plan_nombre?: string | null;
}

// Dashboard aggregated types
export interface KPIData {
  totalIngresos: number;
  totalGastos: number;
  ahorro: number;
  ahorroPorcentaje: number;
  scoreFinanciero: number;
  prevGastos?: number;
  prevIngresos?: number;
}

export interface CategoriaGasto {
  categoria: string;
  emoji: string;
  total: number;
  porcentaje: number;
  transacciones: number;
}

export interface TendenciaMensual {
  mes: string;
  mesNum: number;
  anio: number;
  gastos: number;
  ingresos: number;
}
