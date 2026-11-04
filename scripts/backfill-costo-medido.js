/**
 * Carga meses PASADOS de un costo con medidor (Meta, OpenAI) en su `paid_history`.
 *
 * El cron (`checkRecordatoriosCostos`) solo registra desde el `next_due_date` de la fila en
 * adelante. Esto es para lo anterior: el consumo de octubre de Meta, o los meses de OpenAI
 * antes de que existiera la Admin key. Cada fecha es el día 1 en que se registra el mes
 * anterior, igual que en el cron (2026-11-01 = consumo de octubre).
 *
 * Uso (corre contra producción: necesita las llaves de Railway):
 *   railway run node scripts/backfill-costo-medido.js meta_whatsapp 2026-11-01
 *   railway run node scripts/backfill-costo-medido.js openai 2026-05-01 2026-06-01 ... --dry
 *
 * No toca `next_due_date` ni `amount_pen` de la fila: eso es del cron. Saltea la fecha que ya
 * tenga entrada, así que se puede correr dos veces. El tipo de cambio es el de HOY, no el del
 * mes medido: la diferencia es de céntimos y se corrige desde /admin/costs si importa.
 */

require('dotenv').config();
const { supabase } = require('../lib/db');
const { medirCosto, montoPen } = require('../lib/cost-meters');
const { validarMonto } = require('../lib/validators');
const { obtenerTipoCambio } = require('../services/transactions');

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const [meter, ...fechas] = args.filter((a) => a !== '--dry');
  if (!meter || fechas.length === 0 || fechas.some((f) => !/^\d{4}-\d{2}-01$/.test(f))) {
    console.error('Uso: node scripts/backfill-costo-medido.js <meta_whatsapp|openai> <YYYY-MM-01>... [--dry]');
    process.exit(1);
  }

  const { data: fila, error } = await supabase.from('admin_costs')
    .select('id, label, meter, next_due_date, paid_history')
    .eq('meter', meter)
    .maybeSingle();
  if (error) throw new Error('No se pudo leer admin_costs: ' + error.message);
  if (!fila) throw new Error('No hay fila con meter = ' + meter);

  const tc = await obtenerTipoCambio();
  if (tc.fuente === 'fallback') throw new Error('dolar.pe no respondió: no se registra con el tipo inventado');

  const historial = Array.isArray(fila.paid_history) ? [...fila.paid_history] : [];
  for (const fecha of fechas) {
    if (fila.next_due_date && fecha >= fila.next_due_date) {
      console.log(fecha, '— la registra el cron (next_due_date ' + fila.next_due_date + '), se saltea');
      continue;
    }
    if (historial.some((e) => e && e.paid_at === fecha)) {
      console.log(fecha, '— ya tiene entrada, se saltea');
      continue;
    }
    const lectura = await medirCosto({ meter, next_due_date: fecha });
    const amount = validarMonto(montoPen(lectura.usd, lectura.impuesto, tc.venta), { permitirCero: true });
    if (amount === null) throw new Error(fecha + ': monto inválido (' + lectura.usd + ')');
    console.log(fecha, '— ' + lectura.desde.slice(0, 7) + ': $' + (lectura.usd * (1 + lectura.impuesto)).toFixed(2)
      + ' = S/ ' + amount.toFixed(2) + ' (TC ' + tc.venta + ') · ' + lectura.detalle);
    historial.push({ paid_at: fecha, amount_pen: amount, marked_by: 'meter:' + meter });
  }

  historial.sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
  if (dry) {
    console.log('\n--dry: no se escribió nada');
    return;
  }
  const { error: errUpd } = await supabase.from('admin_costs')
    .update({ paid_history: historial })
    .eq('id', fila.id);
  if (errUpd) throw new Error('No se pudo guardar: ' + errUpd.message);
  console.log('\nGuardado en "' + fila.label + '":', historial.length, 'entradas');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
