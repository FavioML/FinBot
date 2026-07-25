// Validador único de montos de dinero para el webapp. Espejo de `validarMonto`
// del backend (lib/validators.js): rechaza NaN, Infinity, negativos y montos
// sobre el tope de la columna NUMERIC, y redondea a 2 decimales.
//
// Existe para cerrar la deriva POST↔PUT: las rutas de creación inlineaban este
// guard y las de edición se lo saltaron, dejando entrar Infinity (→ null en la
// columna → NaN que envenena recálculos) y montos sin tope. Un solo helper para
// que crear y editar validen idéntico.
//
// `allowZero` sirve para saldos acumulados (ej. monto_actual de una meta, que
// legítimamente arranca en 0); el default exige > 0 (montos de un movimiento).

const MAX_MONTO = 999999.99;

export function parseMontoDinero(
  valor: unknown,
  { allowZero = false }: { allowZero?: boolean } = {}
): number | null {
  const n = typeof valor === 'number' ? valor : parseFloat(String(valor));
  if (isNaN(n) || !isFinite(n) || n > MAX_MONTO) return null;
  if (allowZero ? n < 0 : n <= 0) return null;
  return Math.round(n * 100) / 100;
}
