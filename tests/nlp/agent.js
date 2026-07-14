#!/usr/bin/env node
/**
 * NLP Test Agent — Neto WhatsApp Bot
 *
 * Runs real OpenAI API calls against a sampled set of test cases
 * to verify NLP intent classification accuracy.
 *
 * Usage:
 *   npm run test:nlp-agent              # uses current git commit as seed
 *   npm run test:nlp-agent -- --seed abc123
 *   npm run test:nlp-agent -- --count 150
 *   npm run test:nlp-agent -- --full    # run all 500 cases
 *
 * Requires: OPENAI_API_KEY in environment (or .env)
 */

require('dotenv').config();

const { openai } = require('../../lib/ai');
const { NETO_TOOLS, mapToolToIntent } = require('../../handlers/neto-tools');
const { hoyPeru } = require('../../lib/dates');
const pool = require('./pool');
const { sample } = require('./sampler');
const { execSync } = require('child_process');

// ─── Config ─────────────────────────────────────────────────────────────────

const CONCURRENCY = 3; // parallel API calls (keep under rate limits)
const RETRY_LIMIT = 3;
const args = process.argv.slice(2);

function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const FULL_MODE = args.includes('--full');
const COUNT = FULL_MODE ? pool.length : parseInt(getArg('--count', '300'), 10);
const SEED = getArg('--seed', null) || getGitHash();

function getGitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return Date.now().toString(36);
  }
}

// ─── NLP system prompt (mirrors message-processor.js) ───────────────────────

function buildSystemPrompt() {
  const mE = ['', 'Enero', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const hoy = hoyPeru();
  const parts = hoy.split('-');
  const mes = parseInt(parts[1], 10);
  const anio = parseInt(parts[0], 10);

  return (
    'Eres NETO, asistente financiero por WhatsApp para peruanos. '
    + 'El mes actual es ' + mE[mes] + ' ' + anio + '. Hoy es ' + hoy + '. '
    + 'El usuario se llama Test (plan: free).\n\n'
    + 'Analiza el mensaje del usuario y usa la herramienta mas adecuada. '
    + 'Si el mensaje es conversacional (saludo, agradecimiento, queja, etc), usa social_response. '
    + 'Si el usuario quiere registrar un gasto o ingreso nuevo, usa register_transaction y extrae monto, moneda, comercio, categoria. '
    + 'Si menciona dividir un gasto con personas (ej: "pague la cena de 100 con Annie y Diego"), usa manage_debts con action=split_group. '
    + 'Si dice "debo X a Y" o "Y me debe X", usa manage_debts con action=register. '
    + 'Si quiere recategorizar un gasto, usa manage_transaction con action=recategorize. '
    + 'Si quiere ELIMINAR un gasto (action=delete), DEBES extraer el monto exacto que mencione el usuario (y el comercio si aparece). El usuario suele referenciar con "el de S/18.70" o "el gasto de 41": en ambos casos pasa monto=18.70 o monto=41. Si solo hay comercio sin monto, pasa comercio; nunca inventes montos. '
    + 'Si dice "deshacer", "deshazlo", "deshacer último", "ctrl z", "cancela lo último", "revierte", usa manage_transaction con action=undo. '
    + 'Si dice "restaura", "restablece", "devuélvemelo", "trae de vuelta el gasto", "recupera el gasto", usa manage_transaction con action=restore (NO delete, NO undo). Extrae monto/comercio si los menciona. '
    + 'NUNCA uses action=delete, action=undo ni action=restore si el mensaje termina en signo de pregunta ("?"): eso es una consulta, no una orden — usa social_response o financial_query. '
    + 'Si responde con "si", "no", "dale", "ok" a algo que preguntaste antes, usa social_response con action=greeting (se manejara como continuacion). '
    + 'Extrae montos, fechas, comercios y categorias del lenguaje natural del usuario. '
    + 'Para fechas relativas: "ayer" = restar 1 dia a hoy, "el lunes" = calcular fecha correcta.\n'
    + 'REGLAS EXTRA:\n'
    + '- "Soy Pro o Free", "que plan tengo", "soy premium" = manage_account action=account_status (NO view_premium).\n'
    + '- "Me clavaron", "me bajaron", "me cobraron", "me descuadre" + monto = gasto → register_transaction.\n'
    + '- "Me cayeron", "me pagaron", "gane", "recibi" + monto = ingreso → register_transaction con es_ingreso=true.\n'
    + '- "Le pague X a Y ya esta limpio/saldado/quedamos a mano" = manage_debts action=mark_paid (NO register).\n'
    + '- "Ya le pague TODO a [X]", "le pague todo lo que le debia a [X]" = manage_debts action=settle_all. SOLO settle_all cuando hay verbo de pago + "todo" + persona. "Junta/consolida/agrupa todas las deudas con [X]" = action=consolidate (NO settle_all).\n'
    + '- "Cuanto va el mes" (sin categoria) = query_expenses action=total.\n'
    + '- "Cuanto me queda este mes", "cuanto me sobra", "cuanto tengo disponible", "supere mi presupuesto?" = manage_budget action=balance (NO query_expenses).\n'
    + '- "Como estuvo [mes] vs [mes]", "[mes] vs el anterior", "comparar [mes] con [mes]" = query_analytics action=compare_months.\n'
    + '- "Cuanto pago/gasto en suscripciones (al mes)", "mis suscripciones", "ver suscripciones", "cuanto me cuestan mis pagos recurrentes" = query_analytics action=subscriptions. El detector de fugas (spending_alerts action=view) es SOLO para "en que se me va la plata", "detecta fugas", "donde estoy botando/perdiendo plata", alertas o anomalias de gasto — NUNCA para consultar cuanto paga en suscripciones.\n'
    + '- "Mandame el resumen de [mes]", "reporte de [mes]" = generate_report action=report (NO share_summary).\n'
    + '- "Es viable ahorrar X en Y meses/tiempo", "puedo ahorrar X en Y" = manage_goals action=viability.\n'
    + '- "Saca el gasto de X", "borra el de X", "quita el de X", "gasto duplicado" = manage_transaction action=delete.\n'
    + '- "causa" en mensajes = jerga peruana para "porque/ya que", no cambia el intent. Ej: "elimina ese gasto causa estaba mal" = manage_transaction action=delete.\n'
    + '- "Eran X no Y", "son X no Y", "fueron X no Y" = correccion de monto → manage_transaction action=edit_amount (NO register_transaction).\n'
    + '- "Cambialo/ponlo a X soles" sin mencion de cambio de moneda = manage_transaction action=edit_amount (NO edit_amount_currency). Solo edit_amount_currency cuando hay cambio explicito de moneda ("fueron dolares no soles").\n'
    + '- "El gasto de [X] ponlo en [Y]", "el gasto de [X] va en [Y]", "pon lo de [X] en [Y]", "mueve el de [X] a [Y]" = manage_transaction action=recategorize (cambiar categoria de transaccion especifica, NO set_category_rule).\n'
    + '- "Cambia todos los de [X] a [Y]", "todos los de [X] pasalos a [Y]", "los [X] cambia a [Y]" = manage_transaction action=batch_recategorize (NO set_category_rule).\n'
    + '- "Asocia [X] a [Y]", "siempre que vaya a [X] ponlo en [Y]" = manage_transaction action=set_category_rule (regla permanente para comercio).\n'
    + '- "Sugiere donde recortar gastos", "en que puedo recortar", "que recorto para ahorrar" = manage_goals action=suggest_cuts.\n'
    + '- "me preste" en mensajes = jerga peruana para "pague/gaste" (ej: "me preste 30 taxi" = gaste 30 en taxi) → register_transaction.\n'
    + '- "[Gasto] fue [fecha]", "fue ayer no hoy", "fue el viernes", "fue antier" = manage_transaction action=edit_date.\n'
    + '- "Cambia eso a dolares", "fueron X dolares no soles" = manage_transaction action=edit_amount_currency.\n'
    + '- "El comercio es X", "ponle comercio X" = manage_transaction action=edit_store.\n'
    + '- "Le pague X a Y de lo que le debia", "le di X a Y de lo que debo" = manage_debts action=pay (abonar deuda, NO registrar nueva).\n'
    + '- "Que gastos puedo eliminar para llegar a mi meta" = manage_goals action=view (NO financial_query).\n'
    + '- "Que incluye el plan", "cuanto cuesta Pro" = manage_account action=view_premium.\n'
    + '- "Comparte mi resumen" = generate_report action=share_summary.\n'
    + 'IMPORTANTE: Siempre usa una herramienta. Nunca respondas sin llamar una herramienta.\n'
    + 'CATEGORIAS VALIDAS: Alimentacion, Transporte, Vivienda, Salud, Entretenimiento, Compras, Educacion, Finanzas, Trabajo_Negocio, Otros.\n'
    + 'SUBCATEGORIAS: delivery, restaurante, supermercado, mercado, cafeteria, snacks, uber_cabify, taxi, bus_micro, gasolina, farmacia, medico, streaming, suscripciones, cine, ropa, electronico, hogar, belleza, prestamo, tarjeta_credito, herramientas, publicidad, sin_categoria.'
  );
}

// ─── Classify a single message ──────────────────────────────────────────────

async function classify(msg, retries = 0) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: msg },
      ],
      tools: NETO_TOOLS,
      tool_choice: 'auto',
      temperature: 0,
    });

    const choice = res.choices[0];

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      const tc = choice.message.tool_calls[0];
      let toolArgs = {};
      try { toolArgs = JSON.parse(tc.function.arguments); } catch {}
      const mapped = mapToolToIntent(tc.function.name, toolArgs);
      return { intent: mapped.intencion, datos: mapped.datos, raw: tc.function.name };
    }

    // GPT responded with text instead of tool call
    return { intent: '_text_response', datos: {}, raw: choice.message.content?.substring(0, 80) };
  } catch (err) {
    const retryable = err.status === 429 || err.status >= 500
      || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
      || err.code === 'ECONNABORTED' || err.code === 'UND_ERR_CONNECT_TIMEOUT'
      || err.message?.includes('timeout') || err.message?.includes('ECONNRESET');
    if (retries < RETRY_LIMIT && retryable) {
      const wait = err.status === 429
        ? Math.min(5000 * Math.pow(2, retries), 30000) // 429: backoff agresivo
        : Math.min(2000 * Math.pow(2, retries), 15000);
      await sleep(wait);
      return classify(msg, retries + 1);
    }
    return { intent: '_error', datos: {}, raw: (err.status || '') + ' ' + err.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Run batch with concurrency ─────────────────────────────────────────────

async function runBatch(cases) {
  const results = new Array(cases.length);
  let idx = 0;

  async function worker() {
    while (idx < cases.length) {
      const i = idx++;
      const c = cases[i];
      if (i > 0) await sleep(150); // small delay to avoid rate limits
      const result = await classify(c.msg);
      const pass = result.intent === c.intent;
      results[i] = { ...c, got: result.intent, pass, raw: result.raw };

      // Progress indicator every 25 cases
      const done = results.filter(Boolean).length;
      if (done % 25 === 0) {
        const passed = results.filter(r => r && r.pass).length;
        process.stdout.write(`  ${done}/${cases.length} (${passed} ok)\r`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printReport(results, meta, durationMs) {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  const pct = ((passed / results.length) * 100).toFixed(1);

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  NLP Test Agent — Neto');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Fecha:     ${hoyPeru()}`);
  console.log(`  Seed:      ${meta.seed}`);
  console.log(`  Pool:      ${meta.poolSize} casos`);
  console.log(`  Corridos:  ${meta.total}`);
  console.log(`  Duracion:  ${(durationMs / 1000).toFixed(1)}s`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`  RESULTADO: ${passed}/${results.length} (${pct}%) ${pct >= 95 ? '✅' : pct >= 85 ? '⚠️' : '❌'}`);
  console.log('═══════════════════════════════════════════════════════');

  if (failed.length > 0) {
    console.log('\n❌ FALLOS (' + failed.length + '):\n');
    // Group by category
    const byCat = {};
    for (const f of failed) {
      if (!byCat[f.cat]) byCat[f.cat] = [];
      byCat[f.cat].push(f);
    }
    for (const [cat, items] of Object.entries(byCat)) {
      console.log(`  [${cat}]`);
      for (const f of items) {
        console.log(`    "${f.msg}"`);
        console.log(`      esperado: ${f.intent}  →  obtenido: ${f.got}`);
      }
    }
  }

  // Category breakdown
  console.log('\n📊 POR CATEGORÍA:\n');
  const catStats = {};
  for (const r of results) {
    if (!catStats[r.cat]) catStats[r.cat] = { total: 0, passed: 0 };
    catStats[r.cat].total++;
    if (r.pass) catStats[r.cat].passed++;
  }
  const sorted = Object.entries(catStats).sort((a, b) => {
    const pctA = a[1].passed / a[1].total;
    const pctB = b[1].passed / b[1].total;
    return pctA - pctB; // worst first
  });
  for (const [cat, s] of sorted) {
    const p = ((s.passed / s.total) * 100).toFixed(0);
    const bar = p >= 95 ? '✅' : p >= 80 ? '⚠️' : '❌';
    console.log(`  ${bar} ${cat.padEnd(20)} ${s.passed}/${s.total} (${p}%)`);
  }

  console.log('\n───────────────────────────────────────────────────────');

  // Exit code: 0 if >=90%, 1 if <90% (for CI/CD)
  return { exitCode: pct >= 90 ? 0 : 1, pct, passed, failed, total: results.length, durationMs };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY no configurada. Skipping NLP agent.');
    process.exit(0);
  }

  console.log('\n🤖 NLP Test Agent — Neto');
  console.log(`   Seed: ${SEED} | Casos: ${COUNT} de ${pool.length}\n`);

  // Sample or use full pool
  let cases, meta;
  if (FULL_MODE) {
    cases = pool;
    meta = { seed: 'FULL', total: pool.length, poolSize: pool.length, distribution: {} };
  } else {
    const sampled = sample(pool, SEED, COUNT);
    cases = sampled.cases;
    meta = sampled.meta;
  }

  console.log('   Distribución por categoría:');
  const catCounts = {};
  cases.forEach(c => { catCounts[c.cat] = (catCounts[c.cat] || 0) + 1; });
  for (const [cat, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cat}: ${n}`);
  }
  console.log('\n   Clasificando...\n');

  const t0 = Date.now();
  const results = await runBatch(cases);
  const duration = Date.now() - t0;

  const report = printReport(results, meta, duration);

  // ─── WhatsApp notification ─────────────────────────────────────────────
  await notifyWhatsApp(report, meta);

  process.exit(report.exitCode);
}

async function notifyWhatsApp(report, meta) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  const adminNum = process.env.ADMIN_WHATSAPP;

  if (!phoneId || !token || !adminNum || token === 'test') return;

  const icon = report.pct >= 95 ? '✅' : report.pct >= 85 ? '⚠️' : '❌';
  const durSec = (report.durationMs / 1000).toFixed(1);

  let msg = icon + ' *NLP Agent — ' + report.pct + '%*\n\n'
    + '🎯 ' + report.passed + '/' + report.total + ' correctos\n'
    + '⏱ ' + durSec + 's | Seed: ' + meta.seed + '\n';

  if (report.failed.length > 0) {
    msg += '\n❌ *' + report.failed.length + ' fallos:*\n';
    // Top 10 failures max (WhatsApp message size limit)
    const top = report.failed.slice(0, 10);
    for (const f of top) {
      msg += '• "' + f.msg.substring(0, 40) + '"\n  ' + f.intent + ' → ' + f.got + '\n';
    }
    if (report.failed.length > 10) {
      msg += '... y ' + (report.failed.length - 10) + ' más';
    }
  }

  try {
    const dest = adminNum.replace(/^\+/, '');
    const res = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: dest, type: 'text', text: { body: msg } }),
    });
    const data = await res.json();
    if (data.messages && data.messages[0]) {
      console.log('\n📱 Notificación WhatsApp enviada al admin');
    } else {
      console.log('\n⚠️ WhatsApp notify failed:', JSON.stringify(data));
    }
  } catch (err) {
    console.log('\n⚠️ WhatsApp notify error:', err.message);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { classify, buildSystemPrompt };
