/**
 * Demo Mode — Mock Data
 * Todos los datos son ficticios y las fechas son dinámicas (relativas a hoy).
 * Activado cuando NEXT_PUBLIC_DEMO_MODE=true
 */

import type { Usuario, Transaccion, Presupuesto } from '@/lib/types';
import type { MetaAhorro, MetaAporte, Logro } from '@/lib/hooks/use-goals';
import type { Deuda, DeudaAbono } from '@/lib/hooks/use-debts';
import type { NetoScoreData } from '@/lib/hooks/use-neto-score';
import type { AlertsData } from '@/lib/hooks/use-spending-alerts';
import type { Notificacion } from '@/lib/hooks/use-notifications';
import type { GastoCompartido } from '@/lib/hooks/use-split';
import type { SharedSpace, SpaceDetail } from '@/lib/hooks/use-shared-spaces';

// ─── Helpers de fecha ────────────────────────────────────────────────────────

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function monthStr(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toISOString().split('T')[0];
}

function periodStr(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const DEMO_USER_ID = 'demo-user-001';

// ─── Usuario ─────────────────────────────────────────────────────────────────

export const DEMO_USER: Usuario = {
  id: DEMO_USER_ID,
  whatsapp: '+51999000001',
  nombre: 'Favio Demo',
  email: 'demo@neto.pe',
  plan: 'premium',
  plan_expiry: dateStr(-30 + 365), // vence en ~1 año
  premium_vence: dateStr(-30 + 365),
  estado_pago: 'pagado',
  tipo_plan: 'mensual',
  aprobado_gcc: true,
  supabase_auth_id: 'demo-auth-001',
  created_at: dateStr(90),
  updated_at: dateStr(1),
};

// ─── Transacciones ───────────────────────────────────────────────────────────

export const DEMO_TRANSACTIONS: Transaccion[] = [
  // Mes actual — Gastos
  { id: 'tx-01', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 85, moneda: 'PEN', monto_pen: 85, metodo_pago: 'Yape', comercio: 'Wong', categoria: 'Alimentacion', subcategoria: 'supermercado', fecha: dateStr(2), confirmado: true, created_at: dateStr(2) },
  { id: 'tx-02', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 12.50, moneda: 'PEN', monto_pen: 12.50, metodo_pago: 'Efectivo', comercio: 'Grifo Pecsa', categoria: 'Transporte', subcategoria: 'combustible', fecha: dateStr(3), confirmado: true, created_at: dateStr(3) },
  { id: 'tx-03', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 15.49, moneda: 'USD', monto_pen: 57.5, tipo_cambio: 3.71, comercio: 'Netflix', categoria: 'Suscripciones', subcategoria: 'streaming', fecha: dateStr(5), confirmado: true, created_at: dateStr(5) },
  { id: 'tx-04', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 10.99, moneda: 'USD', monto_pen: 40.8, tipo_cambio: 3.71, comercio: 'Spotify', categoria: 'Suscripciones', subcategoria: 'musica', fecha: dateStr(5), confirmado: true, created_at: dateStr(5) },
  { id: 'tx-05', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 45, moneda: 'PEN', monto_pen: 45, metodo_pago: 'Tarjeta', comercio: 'Farmacia Mifarma', categoria: 'Salud', subcategoria: 'farmacia', fecha: dateStr(6), confirmado: true, created_at: dateStr(6) },
  { id: 'tx-06', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 1800, moneda: 'PEN', monto_pen: 1800, metodo_pago: 'Transferencia', comercio: 'Alquiler Miraflores', categoria: 'Vivienda', subcategoria: 'alquiler', fecha: dateStr(8), confirmado: true, created_at: dateStr(8) },
  { id: 'tx-07', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 35, moneda: 'PEN', monto_pen: 35, metodo_pago: 'Yape', comercio: 'Plaza Vea', categoria: 'Alimentacion', subcategoria: 'supermercado', fecha: dateStr(9), confirmado: true, created_at: dateStr(9) },
  { id: 'tx-08', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 28, moneda: 'PEN', monto_pen: 28, metodo_pago: 'Efectivo', comercio: 'Uber', categoria: 'Transporte', subcategoria: 'taxi', fecha: dateStr(10), confirmado: true, created_at: dateStr(10) },
  { id: 'tx-09', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 20, moneda: 'USD', monto_pen: 74.2, tipo_cambio: 3.71, comercio: 'ChatGPT', categoria: 'Suscripciones', subcategoria: 'ai', fecha: dateStr(10), confirmado: true, created_at: dateStr(10) },
  { id: 'tx-10', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 120, moneda: 'PEN', monto_pen: 120, metodo_pago: 'Tarjeta', comercio: 'Cineplanet', categoria: 'Entretenimiento', subcategoria: 'cine', fecha: dateStr(12), confirmado: true, created_at: dateStr(12) },
  { id: 'tx-11', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 250, moneda: 'PEN', monto_pen: 250, metodo_pago: 'Tarjeta', comercio: 'Ripley', categoria: 'Compras', subcategoria: 'ropa', fecha: dateStr(13), confirmado: true, created_at: dateStr(13) },
  { id: 'tx-12', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 60, moneda: 'PEN', monto_pen: 60, metodo_pago: 'Yape', comercio: 'Metro', categoria: 'Alimentacion', subcategoria: 'supermercado', fecha: dateStr(15), confirmado: true, created_at: dateStr(15) },
  { id: 'tx-13', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 200, moneda: 'PEN', monto_pen: 200, metodo_pago: 'Transferencia', comercio: 'Platzi', categoria: 'Suscripciones', subcategoria: 'educacion', fecha: dateStr(16), confirmado: true, created_at: dateStr(16) },
  { id: 'tx-14', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 18, moneda: 'PEN', monto_pen: 18, metodo_pago: 'Efectivo', comercio: 'Taxi Beat', categoria: 'Transporte', subcategoria: 'taxi', fecha: dateStr(17), confirmado: true, created_at: dateStr(17) },
  { id: 'tx-15', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 95, moneda: 'PEN', monto_pen: 95, metodo_pago: 'Yape', comercio: 'Tottus', categoria: 'Alimentacion', subcategoria: 'supermercado', fecha: dateStr(18), confirmado: true, created_at: dateStr(18) },
  { id: 'tx-16', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 55, moneda: 'PEN', monto_pen: 55, metodo_pago: 'Tarjeta', comercio: 'Restaurant El Rincón', categoria: 'Alimentacion', subcategoria: 'restaurante', fecha: dateStr(20), confirmado: true, created_at: dateStr(20) },
  { id: 'tx-17', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 14.90, moneda: 'PEN', monto_pen: 14.90, comercio: 'Rappi Prime', categoria: 'Suscripciones', subcategoria: 'delivery', fecha: dateStr(20), confirmado: true, created_at: dateStr(20) },
  { id: 'tx-18', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 380, moneda: 'PEN', monto_pen: 380, metodo_pago: 'Transferencia', comercio: 'Claro', categoria: 'Vivienda', subcategoria: 'servicios', fecha: dateStr(22), confirmado: true, created_at: dateStr(22) },

  // Mes actual — Ingresos
  { id: 'tx-19', usuario_id: DEMO_USER_ID, tipo: 'ingreso', monto: 4500, moneda: 'PEN', monto_pen: 4500, metodo_pago: 'Transferencia', comercio: 'Empresa ABC SAC', categoria: 'Sueldo', subcategoria: 'sueldo', fecha: dateStr(1), confirmado: true, created_at: dateStr(1) },
  { id: 'tx-20', usuario_id: DEMO_USER_ID, tipo: 'ingreso', monto: 800, moneda: 'PEN', monto_pen: 800, metodo_pago: 'Transferencia', comercio: 'Cliente Freelance', categoria: 'Freelance', subcategoria: 'freelance', fecha: dateStr(14), confirmado: true, created_at: dateStr(14) },

  // Mes anterior — Gastos
  { id: 'tx-21', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 1800, moneda: 'PEN', monto_pen: 1800, metodo_pago: 'Transferencia', comercio: 'Alquiler Miraflores', categoria: 'Vivienda', subcategoria: 'alquiler', fecha: dateStr(38), confirmado: true, created_at: dateStr(38) },
  { id: 'tx-22', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 720, moneda: 'PEN', monto_pen: 720, metodo_pago: 'Yape', comercio: 'Varios Supermercados', categoria: 'Alimentacion', subcategoria: 'supermercado', fecha: dateStr(35), confirmado: true, created_at: dateStr(35) },
  { id: 'tx-23', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 260, moneda: 'PEN', monto_pen: 260, metodo_pago: 'Efectivo', comercio: 'Transporte Varios', categoria: 'Transporte', subcategoria: 'taxi', fecha: dateStr(36), confirmado: true, created_at: dateStr(36) },
  { id: 'tx-24', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 15.49, moneda: 'USD', monto_pen: 57.5, tipo_cambio: 3.71, comercio: 'Netflix', categoria: 'Suscripciones', subcategoria: 'streaming', fecha: dateStr(35), confirmado: true, created_at: dateStr(35) },
  { id: 'tx-25', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 10.99, moneda: 'USD', monto_pen: 40.8, tipo_cambio: 3.71, comercio: 'Spotify', categoria: 'Suscripciones', subcategoria: 'musica', fecha: dateStr(35), confirmado: true, created_at: dateStr(35) },
  { id: 'tx-26', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 20, moneda: 'USD', monto_pen: 74.2, tipo_cambio: 3.71, comercio: 'ChatGPT', categoria: 'Suscripciones', subcategoria: 'ai', fecha: dateStr(38), confirmado: true, created_at: dateStr(38) },
  { id: 'tx-27', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 180, moneda: 'PEN', monto_pen: 180, metodo_pago: 'Tarjeta', comercio: 'Entretenimiento Varios', categoria: 'Entretenimiento', subcategoria: 'cine', fecha: dateStr(40), confirmado: true, created_at: dateStr(40) },
  { id: 'tx-28', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 320, moneda: 'PEN', monto_pen: 320, metodo_pago: 'Tarjeta', comercio: 'Saga Falabella', categoria: 'Compras', subcategoria: 'ropa', fecha: dateStr(42), confirmado: true, created_at: dateStr(42) },
  { id: 'tx-29', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 90, moneda: 'PEN', monto_pen: 90, metodo_pago: 'Tarjeta', comercio: 'Clínica San Pablo', categoria: 'Salud', subcategoria: 'consulta', fecha: dateStr(44), confirmado: true, created_at: dateStr(44) },
  { id: 'tx-30', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 14.90, moneda: 'PEN', monto_pen: 14.90, comercio: 'Rappi Prime', categoria: 'Suscripciones', subcategoria: 'delivery', fecha: dateStr(40), confirmado: true, created_at: dateStr(40) },

  // Mes anterior — Ingresos
  { id: 'tx-31', usuario_id: DEMO_USER_ID, tipo: 'ingreso', monto: 4500, moneda: 'PEN', monto_pen: 4500, metodo_pago: 'Transferencia', comercio: 'Empresa ABC SAC', categoria: 'Sueldo', subcategoria: 'sueldo', fecha: dateStr(31), confirmado: true, created_at: dateStr(31) },
  { id: 'tx-32', usuario_id: DEMO_USER_ID, tipo: 'ingreso', monto: 500, moneda: 'PEN', monto_pen: 500, metodo_pago: 'Yape', comercio: 'Cliente Freelance 2', categoria: 'Freelance', subcategoria: 'freelance', fecha: dateStr(45), confirmado: true, created_at: dateStr(45) },

  // Mismo alquiler registrado con otro nombre (transferencia a la casera): mismo monto y
  // subcategoría que "Alquiler Miraflores" pero otro día → dispara sugerencia de fusión.
  { id: 'tx-33', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 1800, moneda: 'PEN', monto_pen: 1800, metodo_pago: 'Transferencia', comercio: 'Juno Luya E.', categoria: 'Vivienda', subcategoria: 'alquiler', fecha: dateStr(24), confirmado: true, created_at: dateStr(24) },
  { id: 'tx-34', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 1800, moneda: 'PEN', monto_pen: 1800, metodo_pago: 'Transferencia', comercio: 'Juno Luya E.', categoria: 'Vivienda', subcategoria: 'alquiler', fecha: dateStr(54), confirmado: true, created_at: dateStr(54) },

  // Gimnasio que dejó de cobrarse hace meses (sin gemelo activo) → "inactivo" gris, sin
  // la falsa alarma naranja "esperado hace X días".
  { id: 'tx-35', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 120, moneda: 'PEN', monto_pen: 120, metodo_pago: 'Tarjeta', comercio: 'Smart Fit', categoria: 'Salud', subcategoria: 'gimnasio', fecha: dateStr(78), confirmado: true, created_at: dateStr(78) },
  { id: 'tx-36', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 120, moneda: 'PEN', monto_pen: 120, metodo_pago: 'Tarjeta', comercio: 'Smart Fit', categoria: 'Salud', subcategoria: 'gimnasio', fecha: dateStr(108), confirmado: true, created_at: dateStr(108) },

  // Descriptor opaco de Apple: un solo comercio "APPLE.COM/BILL" que en realidad
  // agrupa 2 servicios (Apple Music S/19.90 + iCloud S/12.90), cada uno recurrente
  // mensual. Caso de la división manual (Fase 3): asignar cada cluster de monto a
  // su servicio real del catálogo.
  { id: 'tx-37', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 19.90, moneda: 'PEN', monto_pen: 19.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(5), confirmado: true, created_at: dateStr(5) },
  { id: 'tx-38', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 12.90, moneda: 'PEN', monto_pen: 12.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(6), confirmado: true, created_at: dateStr(6) },
  { id: 'tx-39', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 19.90, moneda: 'PEN', monto_pen: 19.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(35), confirmado: true, created_at: dateStr(35) },
  { id: 'tx-40', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 12.90, moneda: 'PEN', monto_pen: 12.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(36), confirmado: true, created_at: dateStr(36) },
  { id: 'tx-41', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 19.90, moneda: 'PEN', monto_pen: 19.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(65), confirmado: true, created_at: dateStr(65) },
  { id: 'tx-42', usuario_id: DEMO_USER_ID, tipo: 'gasto', monto: 12.90, moneda: 'PEN', monto_pen: 12.90, metodo_pago: 'Tarjeta', comercio: 'APPLE.COM/BILL', categoria: 'Suscripciones', subcategoria: 'suscripciones', fecha: dateStr(66), confirmado: true, created_at: dateStr(66) },
];

// ─── Presupuestos ─────────────────────────────────────────────────────────────

const now = new Date();

export const DEMO_BUDGETS: Presupuesto[] = [
  { id: 'bud-01', usuario_id: DEMO_USER_ID, categoria: 'Alimentacion', monto_limite: 800, alerta_porcentaje: 80, mes: now.getMonth() + 1, anio: now.getFullYear(), created_at: dateStr(30), updated_at: dateStr(30) },
  { id: 'bud-02', usuario_id: DEMO_USER_ID, categoria: 'Transporte', monto_limite: 300, alerta_porcentaje: 80, mes: now.getMonth() + 1, anio: now.getFullYear(), created_at: dateStr(30), updated_at: dateStr(30) },
  { id: 'bud-03', usuario_id: DEMO_USER_ID, categoria: 'Entretenimiento', monto_limite: 200, alerta_porcentaje: 80, mes: now.getMonth() + 1, anio: now.getFullYear(), created_at: dateStr(30), updated_at: dateStr(30) },
  { id: 'bud-04', usuario_id: DEMO_USER_ID, categoria: 'Suscripciones', monto_limite: 250, alerta_porcentaje: 80, mes: now.getMonth() + 1, anio: now.getFullYear(), created_at: dateStr(30), updated_at: dateStr(30) },
  { id: 'bud-05', usuario_id: DEMO_USER_ID, categoria: 'Vivienda', monto_limite: 1800, alerta_porcentaje: 90, mes: now.getMonth() + 1, anio: now.getFullYear(), created_at: dateStr(30), updated_at: dateStr(30) },
];

// ─── Metas de ahorro ──────────────────────────────────────────────────────────

export const DEMO_GOALS: MetaAhorro[] = [
  {
    id: 'goal-01',
    usuario_id: DEMO_USER_ID,
    nombre: 'MacBook Pro M4',
    monto_objetivo: 6000,
    monto_actual: 1020,
    icono: '💻',
    fecha_limite: dateStr(-180 + 365),
    completada: false,
    monthly_quota: 400,
    status: 'active',
    space_id: null,
    created_at: dateStr(60),
    updated_at: dateStr(5),
  },
  {
    id: 'goal-02',
    usuario_id: DEMO_USER_ID,
    nombre: 'Viaje a Cusco',
    monto_objetivo: 3000,
    monto_actual: 1500,
    icono: '✈️',
    fecha_limite: dateStr(-90 + 180),
    completada: false,
    monthly_quota: 500,
    status: 'active',
    space_id: null,
    created_at: dateStr(75),
    updated_at: dateStr(10),
  },
  {
    id: 'goal-03',
    usuario_id: DEMO_USER_ID,
    nombre: 'Fondo de emergencia',
    monto_objetivo: 10000,
    monto_actual: 200,
    icono: '🛡️',
    fecha_limite: null,
    completada: false,
    monthly_quota: 300,
    status: 'active',
    space_id: null,
    created_at: dateStr(30),
    updated_at: dateStr(2),
  },
];

export const DEMO_GOAL_CONTRIBUTIONS: MetaAporte[] = [
  { id: 'ap-01', meta_id: 'goal-01', monto: 400, tipo: 'aporte', fecha: dateStr(5), nota: 'Aporte mensual', created_at: dateStr(5) },
  { id: 'ap-02', meta_id: 'goal-01', monto: 300, tipo: 'aporte', fecha: dateStr(35), nota: 'Aporte extra', created_at: dateStr(35) },
  { id: 'ap-03', meta_id: 'goal-01', monto: 200, tipo: 'aporte', fecha: dateStr(65), nota: 'Inicio', created_at: dateStr(65) },
  { id: 'ap-04', meta_id: 'goal-01', monto: 120, tipo: 'aporte', fecha: dateStr(75), nota: null, created_at: dateStr(75) },
  { id: 'ap-05', meta_id: 'goal-02', monto: 500, tipo: 'aporte', fecha: dateStr(10), nota: 'Bono trabajo', created_at: dateStr(10) },
  { id: 'ap-06', meta_id: 'goal-02', monto: 500, tipo: 'aporte', fecha: dateStr(40), nota: null, created_at: dateStr(40) },
  { id: 'ap-07', meta_id: 'goal-02', monto: 500, tipo: 'aporte', fecha: dateStr(70), nota: null, created_at: dateStr(70) },
  { id: 'ap-08', meta_id: 'goal-03', monto: 200, tipo: 'aporte', fecha: dateStr(2), nota: 'Primer aporte', created_at: dateStr(2) },
];

// ─── Logros ───────────────────────────────────────────────────────────────────

export const DEMO_ACHIEVEMENTS: Logro[] = [
  { id: 'log-01', usuario_id: DEMO_USER_ID, tipo: 'first_goal', meta_id: 'goal-01', datos: { nombre: 'MacBook Pro M4' }, fecha: dateStr(60), created_at: dateStr(60) },
  { id: 'log-02', usuario_id: DEMO_USER_ID, tipo: 'streak_7', meta_id: null, datos: { dias: 7 }, fecha: dateStr(20), created_at: dateStr(20) },
  { id: 'log-03', usuario_id: DEMO_USER_ID, tipo: '50_percent', meta_id: 'goal-02', datos: { nombre: 'Viaje a Cusco', porcentaje: 50 }, fecha: dateStr(10), created_at: dateStr(10) },
];

// ─── Deudas ───────────────────────────────────────────────────────────────────

const DEMO_DEBT_ABONOS_CARLOS: DeudaAbono[] = [
  { id: 'dab-01', deuda_id: 'debt-01', monto: 100, fecha: dateStr(20), nota: 'Abono parcial', created_at: dateStr(20) },
];

const DEMO_DEBT_ABONOS_MAMA: DeudaAbono[] = [
  { id: 'dab-02', deuda_id: 'debt-03', monto: 200, fecha: dateStr(15), nota: 'Primer abono', created_at: dateStr(15) },
];

export const DEMO_DEBTS: Deuda[] = [
  {
    id: 'debt-01',
    usuario_id: DEMO_USER_ID,
    tipo: 'debo',
    contraparte: 'Carlos',
    monto_original: 400,
    monto_pendiente: 300,
    moneda: 'PEN',
    descripcion: 'Préstamo para reparación laptop',
    fecha_inicio: dateStr(30),
    fecha_vencimiento: dateStr(-15 + 60),
    estado: 'activa',
    invite_code: null,
    deuda_vinculada_id: null,
    created_at: dateStr(30),
    updated_at: dateStr(20),
    deuda_abonos: DEMO_DEBT_ABONOS_CARLOS,
  },
  {
    id: 'debt-02',
    usuario_id: DEMO_USER_ID,
    tipo: 'me_deben',
    contraparte: 'Ana',
    monto_original: 150,
    monto_pendiente: 150,
    moneda: 'PEN',
    descripcion: 'Cena de cumpleaños',
    fecha_inicio: dateStr(10),
    fecha_vencimiento: null,
    estado: 'activa',
    invite_code: null,
    deuda_vinculada_id: null,
    created_at: dateStr(10),
    updated_at: dateStr(10),
    deuda_abonos: [],
  },
  {
    id: 'debt-03',
    usuario_id: DEMO_USER_ID,
    tipo: 'debo',
    contraparte: 'Mamá',
    monto_original: 800,
    monto_pendiente: 600,
    moneda: 'PEN',
    descripcion: 'Préstamo emergencia médica',
    fecha_inicio: dateStr(45),
    fecha_vencimiento: dateStr(-45 + 120),
    estado: 'activa',
    invite_code: null,
    deuda_vinculada_id: null,
    created_at: dateStr(45),
    updated_at: dateStr(15),
    deuda_abonos: DEMO_DEBT_ABONOS_MAMA,
  },
];

// ─── Neto Score ───────────────────────────────────────────────────────────────

export const DEMO_SCORE: NetoScoreData = {
  score: 72,
  period: periodStr(0),
  factors: {
    consistency: 85,
    budget: 68,
    savings: 60,
    goals: 75,
    debts: 55,
    visibility: 90,
  },
  history: [
    { score: 58, period: periodStr(5), factor_consistency: 70, factor_budget: 55, factor_savings: 40, factor_goals: 60, factor_debts: 50, factor_visibility: 65 },
    { score: 62, period: periodStr(4), factor_consistency: 72, factor_budget: 58, factor_savings: 45, factor_goals: 65, factor_debts: 52, factor_visibility: 70 },
    { score: 65, period: periodStr(3), factor_consistency: 75, factor_budget: 60, factor_savings: 50, factor_goals: 68, factor_debts: 53, factor_visibility: 75 },
    { score: 68, period: periodStr(2), factor_consistency: 78, factor_budget: 62, factor_savings: 55, factor_goals: 70, factor_debts: 54, factor_visibility: 80 },
    { score: 70, period: periodStr(1), factor_consistency: 82, factor_budget: 65, factor_savings: 58, factor_goals: 72, factor_debts: 55, factor_visibility: 85 },
    { score: 72, period: periodStr(0), factor_consistency: 85, factor_budget: 68, factor_savings: 60, factor_goals: 75, factor_debts: 55, factor_visibility: 90 },
  ],
};

// ─── Alertas de gasto ─────────────────────────────────────────────────────────

export const DEMO_ALERTS: AlertsData = {
  isPro: true,
  alerts: [
    {
      id: 'alert-01',
      type: 'spike',
      category: 'Entretenimiento',
      amount: 120,
      comparison_amount: 65,
      message: 'Tu gasto en Entretenimiento subió 85% vs el mes pasado. Gastaste S/120 vs S/65.',
      action_taken: false,
      limit_set: null,
      created_at: dateStr(12),
    },
    {
      id: 'alert-02',
      type: 'ant',
      category: 'Suscripciones',
      amount: 227.4,
      comparison_amount: 0,
      message: 'Detectamos S/227 en suscripciones este mes. Tienes 5 servicios activos que quizás no recuerdas.',
      action_taken: false,
      limit_set: null,
      created_at: dateStr(8),
    },
    {
      id: 'alert-03',
      type: 'recurring',
      category: 'Suscripciones',
      amount: 57.5,
      comparison_amount: 57.5,
      message: 'Netflix se cobró puntual este mes: S/57.50. Lleva 3 meses consecutivos.',
      action_taken: true,
      limit_set: null,
      created_at: dateStr(5),
    },
    {
      id: 'alert-04',
      type: 'projection',
      category: null,
      amount: 3850,
      comparison_amount: 3200,
      message: 'A este ritmo, cerrarás el mes con S/3,850 en gastos. Tu presupuesto objetivo es S/3,200.',
      action_taken: false,
      limit_set: null,
      created_at: dateStr(3),
    },
  ],
};

// ─── Notificaciones ───────────────────────────────────────────────────────────

export const DEMO_NOTIFICATIONS: { notifications: Notificacion[]; unreadCount: number } = {
  unreadCount: 2,
  notifications: [
    {
      id: 'notif-01',
      usuario_id: DEMO_USER_ID,
      tipo: 'deuda_vence',
      titulo: 'Deuda próxima a vencer',
      mensaje: 'Tu deuda con Carlos (S/300) vence en 7 días. ¡No olvides abonar!',
      datos: { deuda_id: 'debt-01', contraparte: 'Carlos', monto: 300 },
      leida: false,
      fecha: dateStr(1),
      created_at: dateStr(1),
    },
    {
      id: 'notif-02',
      usuario_id: DEMO_USER_ID,
      tipo: 'milestone',
      titulo: '¡Meta al 50%!',
      mensaje: 'Tu meta "Viaje a Cusco" llegó al 50%. ¡Vas muy bien, sigue así!',
      datos: { meta_id: 'goal-02', nombre: 'Viaje a Cusco', porcentaje: 50 },
      leida: false,
      fecha: dateStr(2),
      created_at: dateStr(2),
    },
    {
      id: 'notif-03',
      usuario_id: DEMO_USER_ID,
      tipo: 'sistema',
      titulo: 'Bienvenido al modo demo',
      mensaje: 'Estás explorando Neto con datos de demostración. Todo lo que ves es un ejemplo real de las funcionalidades Pro.',
      datos: {},
      leida: true,
      fecha: dateStr(5),
      created_at: dateStr(5),
    },
    {
      id: 'notif-04',
      usuario_id: DEMO_USER_ID,
      tipo: 'recordatorio',
      titulo: 'Resumen semanal listo',
      mensaje: 'Esta semana gastaste S/463. Tu mayor gasto fue en Alimentación (S/145). Tu score subió 2 puntos.',
      datos: { semana: 'actual', total: 463 },
      leida: true,
      fecha: dateStr(7),
      created_at: dateStr(7),
    },
  ],
};

// ─── Gastos compartidos (Split) ───────────────────────────────────────────────

export const DEMO_SPLITS: GastoCompartido[] = [
  {
    id: 'split-01',
    creador_id: DEMO_USER_ID,
    descripcion: 'Cena de cumpleaños de Carlos',
    monto_total: 320,
    moneda: 'PEN',
    fecha: dateStr(10),
    fecha_limite: dateStr(-10 + 20),
    notas: 'Restaurante La Rosa Náutica',
    categoria: 'Alimentacion',
    estado: 'activo',
    created_at: dateStr(10),
    gasto_participantes: [
      {
        id: 'part-01',
        gasto_id: 'split-01',
        nombre: 'Favio Demo',
        usuario_id: DEMO_USER_ID,
        monto_debe: 80,
        monto_pagado: 80,
        pagado: true,
        invite_code: null,
        notas: null,
        created_at: dateStr(10),
        gasto_participante_abonos: [],
      },
      {
        id: 'part-02',
        gasto_id: 'split-01',
        nombre: 'Ana',
        usuario_id: null,
        monto_debe: 80,
        monto_pagado: 40,
        pagado: false,
        invite_code: 'SPLIT-ANA-001',
        notas: 'Pagó la mitad',
        created_at: dateStr(10),
        gasto_participante_abonos: [
          { id: 'spab-01', participante_id: 'part-02', monto: 40, nota: 'Abono Yape', created_at: dateStr(8) },
        ],
      },
      {
        id: 'part-03',
        gasto_id: 'split-01',
        nombre: 'Mario',
        usuario_id: null,
        monto_debe: 80,
        monto_pagado: 0,
        pagado: false,
        invite_code: null,
        notas: null,
        created_at: dateStr(10),
        gasto_participante_abonos: [],
      },
      {
        id: 'part-04',
        gasto_id: 'split-01',
        nombre: 'Lucía',
        usuario_id: null,
        monto_debe: 80,
        monto_pagado: 80,
        pagado: true,
        invite_code: null,
        notas: null,
        created_at: dateStr(10),
        gasto_participante_abonos: [],
      },
    ],
  },
  {
    id: 'split-02',
    creador_id: DEMO_USER_ID,
    descripcion: 'Netflix compartido',
    monto_total: 57.5,
    moneda: 'PEN',
    fecha: dateStr(5),
    fecha_limite: null,
    notas: 'Mensual',
    categoria: 'Suscripciones',
    estado: 'activo',
    created_at: dateStr(5),
    gasto_participantes: [
      {
        id: 'part-05',
        gasto_id: 'split-02',
        nombre: 'Favio Demo',
        usuario_id: DEMO_USER_ID,
        monto_debe: 28.75,
        monto_pagado: 28.75,
        pagado: true,
        invite_code: null,
        notas: null,
        created_at: dateStr(5),
        gasto_participante_abonos: [],
      },
      {
        id: 'part-06',
        gasto_id: 'split-02',
        nombre: 'Carlos',
        usuario_id: null,
        monto_debe: 28.75,
        monto_pagado: 0,
        pagado: false,
        invite_code: 'SPLIT-CARLOS-001',
        notas: null,
        created_at: dateStr(5),
        gasto_participante_abonos: [],
      },
    ],
  },
];

// ─── Espacios compartidos ─────────────────────────────────────────────────────

export const DEMO_SPACES: { spaces: SharedSpace[]; isPro: boolean } = {
  isPro: true,
  spaces: [
    {
      id: 'space-01',
      name: 'Depa Miraflores',
      type: 'roommates',
      invite_code: 'SPACE-ROOM-001',
      role: 'owner',
      created_at: dateStr(60),
    },
    {
      id: 'space-02',
      name: 'Con mi pareja',
      type: 'pareja',
      invite_code: 'SPACE-PARE-001',
      role: 'owner',
      created_at: dateStr(45),
    },
  ],
};

export const DEMO_SPACE_DETAIL: SpaceDetail = {
  space: { id: 'space-01', name: 'Depa Miraflores', type: 'roommates', invite_code: 'SPACE-ROOM-001' },
  members: [
    { user_id: DEMO_USER_ID, role: 'owner', split_percentage: 50, usuarios: { nombre: 'Favio Demo' } },
    { user_id: 'demo-user-002', role: 'member', split_percentage: 50, usuarios: { nombre: 'Mario Rodríguez' } },
  ],
  expenses: [
    { id: 'sexp-01', paid_by: DEMO_USER_ID, amount: 1800, description: 'Alquiler Marzo', category: 'Vivienda', created_at: dateStr(8), usuarios: { nombre: 'Favio Demo' } },
    { id: 'sexp-02', paid_by: 'demo-user-002', amount: 380, description: 'Internet + Cable', category: 'Vivienda', created_at: dateStr(10), usuarios: { nombre: 'Mario Rodríguez' } },
    { id: 'sexp-03', paid_by: DEMO_USER_ID, amount: 120, description: 'Artículos limpieza', category: 'Compras', created_at: dateStr(14), usuarios: { nombre: 'Favio Demo' } },
    { id: 'sexp-04', paid_by: 'demo-user-002', amount: 250, description: 'Supermercado semanal', category: 'Alimentación', created_at: dateStr(5), usuarios: { nombre: 'Mario Rodríguez' } },
  ],
  splitRules: [
    { id: 'rule-01', category: 'Vivienda', splits: { [DEMO_USER_ID]: 60, 'demo-user-002': 40 } },
    { id: 'rule-02', category: 'Compras', splits: { [DEMO_USER_ID]: 80, 'demo-user-002': 20 } },
  ],
  budgets: [
    { id: 'sbud-01', category: 'Vivienda', limit: 2200 },
    { id: 'sbud-02', category: 'Compras', limit: 300 },
    { id: 'sbud-03', category: 'Alimentación', limit: 800 },
  ],
  settlements: [],
  balance: {
    [DEMO_USER_ID]: 710,
    'demo-user-002': -710,
  },
  currentUserId: DEMO_USER_ID,
  isPro: true,
};

const DEMO_SPACE_DETAIL_PAREJA: SpaceDetail = {
  space: { id: 'space-02', name: 'Con mi pareja', type: 'pareja', invite_code: 'SPACE-PARE-001' },
  members: [
    { user_id: DEMO_USER_ID, role: 'owner', split_percentage: 50, usuarios: { nombre: 'Favio Demo' } },
    { user_id: 'demo-user-003', role: 'member', split_percentage: 50, usuarios: { nombre: 'Lucía García' } },
  ],
  expenses: [
    { id: 'sexp-p01', paid_by: DEMO_USER_ID, amount: 320, description: 'Cena aniversario', category: 'Alimentación', created_at: dateStr(3), usuarios: { nombre: 'Favio Demo' } },
    { id: 'sexp-p02', paid_by: 'demo-user-003', amount: 150, description: 'Mercado semanal', category: 'Alimentación', created_at: dateStr(7), usuarios: { nombre: 'Lucía García' } },
    { id: 'sexp-p03', paid_by: DEMO_USER_ID, amount: 89, description: 'Netflix + Disney+', category: 'Suscripciones', created_at: dateStr(10), usuarios: { nombre: 'Favio Demo' } },
  ],
  splitRules: [],
  budgets: [
    { id: 'sbud-p01', category: 'Alimentación', limit: 600 },
  ],
  settlements: [],
  balance: {
    [DEMO_USER_ID]: 129.5,
    'demo-user-003': -129.5,
  },
  currentUserId: DEMO_USER_ID,
  isPro: true,
};

export const DEMO_SPACE_DETAIL_MAP: Record<string, SpaceDetail> = {
  'space-01': DEMO_SPACE_DETAIL,
  'space-02': DEMO_SPACE_DETAIL_PAREJA,
};
