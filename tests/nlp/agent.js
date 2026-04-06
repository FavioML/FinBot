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

const CONCURRENCY = 5; // parallel API calls (avoid rate limits)
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
    + 'Si dice "restaura", "restablece", "devuélvemelo", "trae de vuelta el gasto", usa manage_transaction con action=restore (NO delete, NO undo). Extrae monto/comercio si los menciona. '
    + 'NUNCA uses action=delete, action=undo ni action=restore si el mensaje termina en signo de pregunta ("?"): eso es una consulta, no una orden — usa social_response o financial_query. '
    + 'Si responde con "si", "no", "dale", "ok" a algo que preguntaste antes, usa social_response con action=greeting (se manejara como continuacion). '
    + 'Extrae montos, fechas, comercios y categorias del lenguaje natural del usuario. '
    + 'Para fechas relativas: "ayer" = restar 1 dia a hoy, "el lunes" = calcular fecha correcta.\n'
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
    if (retries < RETRY_LIMIT && (err.status === 429 || err.status >= 500 || err.code === 'ECONNRESET')) {
      const wait = Math.min(2000 * Math.pow(2, retries), 15000);
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

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
