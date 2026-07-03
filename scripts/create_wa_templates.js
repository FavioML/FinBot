/**
 * Crea (y envía a aprobación de Meta) los templates UTILITY de recordatorios de Neto.
 *
 * Ejecutar una vez:  node scripts/create_wa_templates.js
 *
 * Requiere en el entorno:
 *   META_ACCESS_TOKEN   (el mismo que usa el backend para enviar)
 *   META_WABA_ID        (opcional; default = WABA de Neto)
 *
 * El token debe tener el permiso `whatsapp_business_management`. Si no lo tiene, Meta
 * responde un error de permisos y hay que crear los templates a mano (ver docs/whatsapp-templates.md).
 *
 * Costo: crear/aprobar templates es GRATIS. Solo se cobra el ENVÍO a usuarios fuera de la
 * ventana de 24h. Utility es la categoría más barata (y gratis si el usuario está en ventana).
 */

const GRAPH = 'https://graph.facebook.com/v19.0';
const WABA_ID = process.env.META_WABA_ID || '2080787612777795';
const TOKEN = process.env.META_ACCESS_TOKEN;

// Los {{n}} son variables posicionales. `example` es obligatorio para que Meta apruebe.
const TEMPLATES = [
  {
    name: 'deuda_por_vencer',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}} 👋 Recordatorio de Neto: {{2}} por {{3}} vence {{4}}. Entra a Neto para gestionarlo.',
        example: { body_text: [['Favio', 'tu deuda con Juan', 'S/ 120.00', 'en 3 días']] },
      },
    ],
  },
  {
    name: 'plan_pro_por_vencer',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}} 👋 Tu plan NETO Pro vence {{2}}. Renuévalo desde Neto para no perder tu historial y las funciones Pro.',
        example: { body_text: [['Favio', 'en 3 días (2026-07-06)']] },
      },
    ],
  },
];

async function crearTemplate(t) {
  const res = await fetch(GRAPH + '/' + WABA_ID + '/message_templates', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  const data = await res.json();
  if (res.ok && data.id) {
    console.log('✅ ' + t.name + ' → creado (id ' + data.id + ', status ' + (data.status || 'PENDING') + ')');
    return true;
  }
  const err = data.error || {};
  // 100 / 2388023 suele ser "template ya existe"; 200/10 = falta permiso whatsapp_business_management
  if (err.code === 100 && /already exists/i.test(err.error_user_msg || err.message || '')) {
    console.log('ℹ️  ' + t.name + ' → ya existe (ok)');
    return true;
  }
  console.error('❌ ' + t.name + ' → error: ' + (err.error_user_msg || err.message || JSON.stringify(data)));
  if (err.code === 200 || err.code === 10) {
    console.error('   (El token no tiene permiso whatsapp_business_management. Créalos a mano: docs/whatsapp-templates.md)');
  }
  return false;
}

async function main() {
  if (!TOKEN) {
    console.error('Falta META_ACCESS_TOKEN en el entorno.');
    process.exit(1);
  }
  console.log('Creando templates en WABA ' + WABA_ID + ' ...\n');
  let ok = 0;
  for (const t of TEMPLATES) {
    try { if (await crearTemplate(t)) ok++; }
    catch (e) { console.error('❌ ' + t.name + ' → excepción: ' + e.message); }
  }
  console.log('\n' + ok + '/' + TEMPLATES.length + ' templates enviados a aprobación.');
  console.log('Revisa el estado en WhatsApp Manager → Plantillas (aprobación ~24-48h).');
  console.log('Cuando estén APPROVED, setea WA_TEMPLATES_ENABLED=true en Railway.');
}

main().catch(e => { console.error(e); process.exit(1); });
