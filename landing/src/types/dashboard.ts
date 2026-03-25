export interface DashboardData {
  nombre: string;
  mes: number;
  anio: number;
  mesLabel: string;
  fechaGeneracion: string;
  kpis: {
    totalIngresos: number;
    totalGastos: number;
    ahorro: number;
    pctAhorro: number;
    deltaGasto: number;
    deltaIngreso: number;
  };
  categorias: Array<{
    nombre: string;
    monto: number;
    presupuesto: number;
    pctPresupuesto: number;
    color: string;
    subcategorias?: Array<{ nombre: string; monto: number }>;
  }>;
  comercios: Array<{ nombre: string; monto: number }>;
  metodosPago: Array<{ nombre: string; monto: number }>;
  suscripciones: Array<{ comercio: string; monto: number; moneda: string }>;
  totalSuscripciones: number;
  historial: Array<{
    mes: number;
    anio: number;
    label: string;
    totalGastos: number;
    totalIngresos: number;
  }>;
  score: {
    valor: number;
    label: string;
    color: string;
    factores: Array<{ texto: string; estado: string }>;
  };
  proyeccion: {
    fijos: number;
    variables: number;
    total: number;
    insight: string;
  };
  acciones: Array<{ texto: string; pill: string; color: string }>;
  transacciones: Array<{
    fecha: string;
    comercio: string;
    categoria: string;
    monto: number;
    moneda: string;
    tipo: string;
    metodo_pago: string;
  }>;
  gastosUsd: {
    total: number;
    totalPen: number;
    tcPromedio: number;
    detalle: Array<{
      comercio: string;
      monto: number;
      montoPen: number;
      tc: number;
    }>;
  };
  mesesDisponibles: Array<{ mes: number; anio: number; label: string }>;
  insightMes: { texto: string; tipo: string };
}
