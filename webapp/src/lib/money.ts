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
  const crudo = typeof valor === 'number' ? valor : parseFloat(String(valor));
  if (isNaN(crudo) || !isFinite(crudo) || crudo > MAX_MONTO) return null;
  // Se redondea ANTES de mirar el signo. Al revés, `0.001` pasaba el `> 0` y salía
  // redondeado a **0**: la función devolvía el valor que su contrato rechaza, y
  // `POST /api/transactions {"monto": 0.001}` insertaba una transacción de S/0.
  // Espejo exacto de `validarMonto` en lib/validators.js — si se toca uno, el otro.
  const redondeado = Math.round(crudo * 100) / 100;
  // `-0.001` redondea a `-0`: se normaliza para tener una sola representación del cero.
  const n = redondeado === 0 ? 0 : redondeado;
  if (allowZero ? n < 0 : n <= 0) return null;
  return n;
}
