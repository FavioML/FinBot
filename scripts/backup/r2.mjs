#!/usr/bin/env node
/**
 * Cliente minimo de Cloudflare R2 (S3 API) firmado con SigV4.
 *
 * Sin dependencias a proposito: node:crypto ya trae todo lo que necesita SigV4,
 * y un backup no deberia depender de que `npm ci` funcione el dia del desastre.
 * El CRM usa aws4fetch (src/lib/r2-client.ts); aca no, para que este script
 * corra tal cual desde un runner limpio o desde una laptop sin node_modules.
 *
 * Uso:
 *   node r2.mjs put <key> <archivo>
 *   node r2.mjs get <key> <archivo>
 *   node r2.mjs list [prefijo]
 *   node r2.mjs del <key>
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const REGION = 'auto';
const SERVICE = 's3';

function cfg() {
  const c = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  };
  const faltan = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) {
    console.error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    process.exit(2);
  }
  return c;
}

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** Cada segmento del path se codifica, pero las barras se conservan. */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function firmar({ method, host, path, query, payloadHash, headers, creds }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const fecha = amzDate.slice(0, 8);

  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const nombres = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = nombres.map((h) => {
    const real = Object.keys(all).find((k) => k.toLowerCase() === h);
    return `${h}:${String(all[real]).trim()}\n`;
  }).join('');
  const signedHeaders = nombres.join(';');

  const canonicalRequest = [
    method, path, query, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${fecha}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  let k = hmac(`AWS4${creds.secretAccessKey}`, fecha);
  k = hmac(k, REGION);
  k = hmac(k, SERVICE);
  k = hmac(k, 'aws4_request');
  const firma = hmac(k, stringToSign).toString('hex');

  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${firma}`,
  };
}

async function pedir({ method, key = '', query = '', body = null, extraHeaders = {} }) {
  const c = cfg();
  const host = `${c.accountId}.r2.cloudflarestorage.com`;
  const path = `/${c.bucket}${key ? `/${encodeKey(key)}` : ''}`;
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256hex(payload);

  const headers = firmar({
    method, host, path, query, payloadHash, creds: c,
    headers: body
      ? { 'content-length': String(payload.length), 'content-type': 'application/octet-stream', ...extraHeaders }
      : extraHeaders,
  });

  const url = `https://${host}${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { method, headers, body: body ?? undefined });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`R2 ${method} ${key || '(bucket)'} -> ${res.status} ${txt.slice(0, 400)}`);
  }
  return res;
}

export async function put(key, buf) {
  await pedir({ method: 'PUT', key, body: buf });
}

export async function get(key) {
  const res = await pedir({ method: 'GET', key });
  return Buffer.from(await res.arrayBuffer());
}

export async function del(key) {
  await pedir({ method: 'DELETE', key });
}

/** Lista con paginacion; devuelve [{key, size, lastModified}]. */
export async function list(prefix = '') {
  const items = [];
  let token = null;
  do {
    const q = new URLSearchParams({ 'list-type': '2' });
    if (prefix) q.set('prefix', prefix);
    if (token) q.set('continuation-token', token);
    // SigV4 exige los parametros ordenados por nombre.
    const query = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

    const res = await pedir({ method: 'GET', query });
    const xml = await res.text();
    for (const bloque of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      items.push({
        key: bloque.match(/<Key>([^<]+)<\/Key>/)?.[1],
        size: Number(bloque.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        lastModified: bloque.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1],
      });
    }
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null;
  } while (token);
  return items;
}

/**
 * Borra objetos mas viejos que `dias` bajo `prefix`, pero NUNCA deja menos de
 * `pisoMinimo` objetos. El piso importa: si algo hace que el backup deje de
 * subir, sin piso el prune iria borrando los buenos hasta dejar el bucket
 * vacio justo cuando mas se necesita. Preferimos gastar de mas en storage.
 */
export async function prune(prefix, dias, pisoMinimo, deps = {}) {
  const listar = deps.list ?? list;
  const borrar = deps.del ?? del;
  const items = (await listar(prefix)).sort(
    (a, b) => new Date(a.lastModified) - new Date(b.lastModified),
  );
  const corte = Date.now() - dias * 86400000;
  const viejos = items.filter((i) => new Date(i.lastModified).getTime() < corte);
  const borrables = Math.max(0, Math.min(viejos.length, items.length - pisoMinimo));
  const aBorrar = viejos.slice(0, borrables);
  for (const i of aBorrar) await borrar(i.key);
  return {
    total: items.length,
    borrados: aBorrar.map((i) => i.key),
    retenidosPorPiso: viejos.length - aBorrar.length,
  };
}

/**
 * Fija la retencion server-side. Se hace con lifecycle rules y no con un
 * script de prune para que la retencion siga siendo correcta aunque el
 * workflow se rompa, y para no necesitar permiso de borrado en el token.
 */
export async function setLifecycle(reglas) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<LifecycleConfiguration>'
    + reglas.map((r) => `<Rule><ID>${r.id}</ID><Filter><Prefix>${r.prefix}</Prefix></Filter>`
      + `<Status>Enabled</Status><Expiration><Days>${r.days}</Days></Expiration></Rule>`).join('')
    + '</LifecycleConfiguration>';
  const body = Buffer.from(xml, 'utf8');
  await pedir({
    method: 'PUT',
    query: 'lifecycle',
    body,
    extraHeaders: {
      'content-type': 'application/xml',
      'content-length': String(body.length),
      'content-md5': createHash('md5').update(body).digest('base64'),
    },
  });
}

export async function getLifecycle() {
  const res = await pedir({ method: 'GET', query: 'lifecycle' });
  return res.text();
}

// --- CLI ---
if (process.argv[1]?.endsWith('r2.mjs')) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'put') {
      await put(a, readFileSync(b));
      console.log(`OK put ${a} (${readFileSync(b).length} bytes)`);
    } else if (cmd === 'get') {
      writeFileSync(b, await get(a));
      console.log(`OK get ${a} -> ${b}`);
    } else if (cmd === 'del') {
      await del(a);
      console.log(`OK del ${a}`);
    } else if (cmd === 'list') {
      const items = await list(a ?? '');
      for (const i of items) console.log(`${i.lastModified}\t${String(i.size).padStart(10)}\t${i.key}`);
      console.log(`(${items.length} objetos)`);
    } else if (cmd === 'prune') {
      const d = await prune('daily/', Number(process.env.RETENCION_DIARIA || 30), 7);
      const m = await prune('monthly/', Number(process.env.RETENCION_MENSUAL || 365), 3);
      for (const k of [...d.borrados, ...m.borrados]) console.log(`  borrado ${k}`);
      console.log(`daily/: ${d.total - d.borrados.length} quedan (${d.borrados.length} borrados`
        + `${d.retenidosPorPiso ? `, ${d.retenidosPorPiso} retenidos por el piso de 7` : ''})`);
      console.log(`monthly/: ${m.total - m.borrados.length} quedan (${m.borrados.length} borrados)`);
    } else if (cmd === 'set-lifecycle') {
      await setLifecycle([
        { id: 'daily-30d', prefix: 'daily/', days: 30 },
        { id: 'monthly-365d', prefix: 'monthly/', days: 365 },
      ]);
      console.log('OK lifecycle: daily/ 30 dias, monthly/ 365 dias');
    } else if (cmd === 'get-lifecycle') {
      console.log(await getLifecycle());
    } else {
      console.error('Uso: r2.mjs put|get|del|list|set-lifecycle|get-lifecycle ...');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
