/**
 * Cambia el "Display Name" (verified_name) del numero WhatsApp Business
 * via Meta Graph API. Submite la peticion para revision por Meta (~24-48h).
 *
 * Uso:
 *   META_ACCESS_TOKEN=xxx META_PHONE_NUMBER_ID=1007751122425272 \
 *     node scripts/change-wa-display-name.js "Neto - Asistente Financiero"
 *
 * O si ya tienes esas vars en .env:
 *   node -r dotenv/config scripts/change-wa-display-name.js "Neto"
 *
 * Tambien acepta override de phone id por arg:
 *   node scripts/change-wa-display-name.js "Neto" 1007751122425272
 */

const NEW_NAME = process.argv[2];
const PHONE_ID = process.argv[3] || process.env.META_PHONE_NUMBER_ID || '1007751122425272';
const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = process.env.META_API_VERSION || 'v22.0';

if (!NEW_NAME) {
  console.error('Falta el nombre. Uso: node scripts/change-wa-display-name.js "Nombre Nuevo"');
  process.exit(1);
}
if (!TOKEN) {
  console.error('Falta META_ACCESS_TOKEN en el entorno.');
  process.exit(1);
}

async function main() {
  console.log('--- Cambio de Display Name WhatsApp ---');
  console.log('Phone Number ID:', PHONE_ID);
  console.log('Nombre nuevo   :', NEW_NAME);
  console.log('API version    :', API_VERSION);
  console.log();

  // 1. Estado actual
  const getUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}?fields=verified_name,display_phone_number,name_status,quality_rating,code_verification_status`;
  const cur = await fetch(getUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const curData = await cur.json();
  console.log('Estado actual:');
  console.log(JSON.stringify(curData, null, 2));
  console.log();

  if (curData.error) {
    console.error('Error consultando estado. Revisa el token y phone_number_id.');
    process.exit(1);
  }

  if (curData.verified_name === NEW_NAME) {
    console.log('El verified_name ya es exactamente "' + NEW_NAME + '". Nada que hacer.');
    return;
  }

  // 2. Submit del cambio
  const postUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}`;
  const body = new URLSearchParams({ verified_name: NEW_NAME });
  const res = await fetch(postUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await res.json();
  console.log('Respuesta de Meta:');
  console.log(JSON.stringify(data, null, 2));
  console.log();

  if (data.error) {
    console.error('Submission fallida.');
    if (data.error.error_subcode || data.error.code) {
      console.error('codigo:', data.error.code, 'subcodigo:', data.error.error_subcode);
    }
    process.exit(1);
  }

  console.log('OK. El cambio queda en revision por Meta. Suele tardar 24-48h.');
  console.log('Verifica el estado con: name_status -> debe pasar de PENDING_REVIEW a APPROVED.');
}

main().catch((e) => {
  console.error('Error inesperado:', e);
  process.exit(1);
});
