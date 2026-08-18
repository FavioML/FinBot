// ¿El borrado de cuenta borra de verdad?
//
// POR QUÉ ESTE HARNESS Y NO UN TEST. **Un cascade no se puede probar en el mock.** La suite
// usa un doble de Supabase que no ejecuta FKs ni triggers, así que un verde ahí no dice NADA
// sobre qué se lleva puesto un DELETE. Y `qa-guard` tampoco ve las cascadas: valida la fila
// que se toca, no las que Postgres borra detrás — lo dice su propio docblock. La única forma
// de saberlo es contra la Supabase de verdad, con un usuario sembrado a propósito.
//
// Y no es paranoia: al escribir la migración 073, correr el borrado contra un usuario real
// dentro de una transacción revertida encontró DOS cosas que ninguna lectura del código dio:
// que `DELETE FROM usuarios` aborta con 23503 por una deuda espejo (1 de 113 usuarios), y que
// `gmail_cuentas.email` era NOT NULL.
//
// QUÉ SIEMBRA, y por qué justo eso. Dos usuarios QA, no uno. El caso interesante del borrado
// no es la persona sola: es la que compartía cosas con otra, porque ahí `usuarios` ancla datos
// que NO son suyos. Se siembran las dos formas medidas de romperlo:
//
//   · una DEUDA ESPEJO — la deuda de B apunta a la de A por `deuda_vinculada_id`, que es
//     NO ACTION y hace abortar el borrado entero si no se desvincula antes;
//   · un ESPACIO COMPARTIDO con B adentro, que NO debe destruirse (los gastos de B son de B),
//     junto a un espacio SOLO de A, que sí.
//
// LA LISTA DE TABLAS NO SE ESCRIBE ACÁ. El chequeo final la recomputa de `pg_constraint`, así
// que el día que alguien agregue la tabla 31 y no la clasifique, este harness la ve. Una lista
// a mano habría envejecido en el primer commit.
//
// Correr:  node qa-e2e/qa-borrado-cuenta.mjs   (desde app/)
// NO está en el canary: solo se rompe con un commit. Ver qa-e2e/README.md.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { instalarGuard, permitirUsuarioDePrueba, resumenGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => require(path.join(appRoot, m));

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
const { borrarCuenta } = R('services/account-deletion.js');

const MARCA = 'QA_BORRADO_CUENTA';
const BUCKET = 'comprobantes';

const fallos = [];
let creados = { a: null, b: null, authA: null, espacioSolo: null, espacioCompartido: null };

function check(nombre, ok, detalle) {
  if (ok) { console.log('  ok  ' + nombre); return; }
  fallos.push(nombre + (detalle ? ' — ' + detalle : ''));
  console.log('  FALLA  ' + nombre + (detalle ? ' — ' + detalle : ''));
}

// Toda escritura de siembra lee su `{ error }`. supabase-js NO lanza: una siembra que falla en
// silencio produce un harness que después "verifica" que una tabla quedó vacía y pasa en verde
// porque nunca tuvo nada. Es el modo de fallo más caro que puede tener un harness de borrado.
async function sembrar(tabla, fila) {
  const { data, error } = await supabase.from(tabla).insert(fila).select('id').single();
  if (error) throw new Error('no pude sembrar ' + tabla + ': ' + error.message);
  return data?.id;
}

async function contar(tabla, col, valor) {
  const { count, error } = await supabase.from(tabla)
    .select('id', { count: 'exact', head: true }).eq(col, valor);
  if (error) return { n: null, err: error.message };
  return { n: count, err: null };
}

async function main() {
  console.log('\n=== Siembra ===');

  // ── Los dos usuarios ───────────────────────────────────────────────────────
  // `is_test_user: true` no es cosmético: `permitirUsuarioDePrueba` lo verifica contra la DB
  // antes de dejar que la barrera opere sobre este id. Sin eso, no hay harness.
  const suf = crypto.randomBytes(4).toString('hex');
  const waA = '519999' + suf.slice(0, 5);
  const waB = '519998' + suf.slice(0, 5);

  creados.a = await sembrar('usuarios', {
    whatsapp: waA, nombre: MARCA + '_A', email: MARCA.toLowerCase() + '.a.' + suf + '@qa.neto.pe',
    is_test_user: true, plan: 'premium', trial_estado: 'convertido', tipo_plan: 'anual', premium_vence: '2027-03-15',
    onboarding_paso: -1, onboarding_completado: true,
  });
  creados.b = await sembrar('usuarios', {
    whatsapp: waB, nombre: MARCA + '_B', is_test_user: true, plan: 'free',
  });
  await permitirUsuarioDePrueba(creados.a);
  await permitirUsuarioDePrueba(creados.b);
  const A = creados.a, B = creados.b;
  console.log('  usuarios A=' + A.slice(0, 8) + ' B=' + B.slice(0, 8));

  // ── La identidad web (auth.users) ──────────────────────────────────────────
  // Es una de las superficies que el inventario de "las 30 tablas" no ve, y al 17-ago los DOS
  // usuarios ya dados de baja conservaban la suya: podían seguir entrando a app.neto.pe.
  const { data: authData, error: errAuth } = await supabase.auth.admin.createUser({
    email: 'qa.borrado.' + suf + '@qa.neto.pe', password: crypto.randomBytes(16).toString('hex'), email_confirm: true,
  });
  if (errAuth) throw new Error('no pude crear el usuario de auth: ' + errAuth.message);
  creados.authA = authData.user.id;
  await supabase.from('usuarios').update({ supabase_auth_id: creados.authA }).eq('id', A);

  // ── Storage: un comprobante ────────────────────────────────────────────────
  const pathObjeto = A + '/' + MARCA + '.txt';
  const { error: errUp } = await supabase.storage.from(BUCKET)
    .upload(pathObjeto, Buffer.from('comprobante de prueba'), { contentType: 'text/plain', upsert: true });
  if (errUp) throw new Error('no pude subir el comprobante: ' + errUp.message);

  // ── Datos propios de A ─────────────────────────────────────────────────────
  const txId = await sembrar('transacciones', { usuario_id: A, tipo: 'gasto', monto: 12.5, comercio: MARCA, categoria: 'Otros' });
  await sembrar('transacciones', { usuario_id: A, tipo: 'gasto', monto: 30, comercio: MARCA, categoria: 'Otros' });
  await sembrar('transacciones_eliminadas', { usuario_id: A, tx_id: txId, snapshot: { comercio: MARCA, monto: 12.5 } });
  await sembrar('conversaciones', { usuario_id: A, rol: 'user', mensaje: MARCA + ' texto literal de lo que escribio' });
  await sembrar('notificaciones', { usuario_id: A, tipo: 'sistema', titulo: MARCA, mensaje: MARCA });
  await sembrar('presupuestos', { usuario_id: A, categoria: 'Otros', monto_limite: 100, mes: 8, anio: 2026 });
  await sembrar('categorias_usuario', { usuario_id: A, nombre: MARCA });
  await sembrar('reglas_comercio', { usuario_id: A, comercio_pattern: MARCA, categoria: 'Otros' });
  await sembrar('recurrentes_overrides', { usuario_id: A, dominio: 'suscripcion', clave_variante: MARCA });
  await sembrar('logros', { usuario_id: A, tipo: MARCA });
  await sembrar('gmail_excluidos', { usuario_id: A, descripcion_original: MARCA });
  await sembrar('errores', { usuario_id: A, tag: MARCA, mensaje: MARCA, whatsapp: waA });
  await sembrar('tickets_soporte', { usuario_id: A, whatsapp: waA, nombre_usuario: MARCA + '_A' });
  await sembrar('spending_alerts', { user_id: A });
  const metaId = await sembrar('metas_ahorro', { usuario_id: A, nombre: MARCA, monto_objetivo: 500 });
  // `usuario_id` va en NULL, que es la forma REAL: `services/metas.js` y la ruta de la webapp
  // insertan el aporte sin esa columna, y en producción la única fila que existe la tiene en
  // null. Sembrarla con `A` —como estaba— hacía que el predicado `IS DISTINCT FROM` de la
  // migración 073c pasara en verde acá mientras en producción dejaba metas SIN BORRAR. El
  // fixture era más benévolo que la realidad, que es la peor forma de estar en verde.
  await sembrar('meta_aportes', { usuario_id: null, meta_id: metaId, monto: 50 });
  await sembrar('meta_participantes', { usuario_id: A, meta_id: metaId });

  // `nlp_errors` con `usuario_id` en NULL y solo el teléfono: es la forma REAL de la mayoría
  // de esas filas (156 de 185 al 17-ago). Si el borrado solo mirara `usuario_id`, esta fila
  // —que lleva el número Y el texto literal del mensaje— sobreviviría.
  await sembrar('nlp_errors', { usuario_id: null, whatsapp: waA, mensaje: MARCA + ' mensaje crudo' });

  // `webapp_otp` NO tiene FK a `usuarios`: ningún cascade la iba a alcanzar nunca.
  // Sin `id`: la columna es GENERATED ALWAYS AS IDENTITY, y Postgres rechaza un valor
  // explícito. En `information_schema` se ve igual que un NOT NULL sin default.
  await sembrar('webapp_otp', {
    supabase_auth_id: creados.authA, email: MARCA.toLowerCase() + '@qa.neto.pe',
    nombre: MARCA, code: '000000', whatsapp_claimed: waA, whatsapp_verified: waA,
    expires_at: '2027-01-01T00:00:00Z',
  });

  // `pagos` se CONSERVA, pero sin lo que nombra a la persona.
  const pagoId = await sembrar('pagos', {
    usuario_id: A, monto: 10, moneda: 'PEN', tipo_plan: 'mensual', estado: 'aprobado',
    comprobante_url: pathObjeto, notas: MARCA + ' pagó por Yape desde el 999',
  });

  // `gmail_cuentas`: el correo se va, el hash se queda. Se siembra SIN hash a propósito, para
  // ejercitar el backfill que el propio borrado hace justo antes de vaciar el correo.
  await sembrar('gmail_cuentas', { usuario_id: A, email: MARCA.toLowerCase() + '@gmail.com', activa: true });

  // ── Lo compartido con B: las dos formas medidas de romper el borrado ────────
  const deudaA = await sembrar('deudas', { usuario_id: A, tipo: 'me_deben', contraparte: MARCA + '_B', monto_original: 100, monto_pendiente: 100 });
  await sembrar('deuda_abonos', { deuda_id: deudaA, monto: 20 });
  // La deuda de B apunta a la de A. `deuda_vinculada_id` es NO ACTION: sin desvincular, el
  // borrado aborta con 23503. Es el caso que hoy le pasa a 1 de 113 usuarios reales.
  const deudaB = await sembrar('deudas', {
    usuario_id: B, tipo: 'debo', contraparte: MARCA + '_A', monto_original: 100, monto_pendiente: 100,
    deuda_vinculada_id: deudaA,
  });

  creados.espacioSolo = await sembrar('shared_spaces', { name: MARCA + '_solo', invite_code: 'QAS' + suf, created_by: A });
  await sembrar('space_members', { space_id: creados.espacioSolo, user_id: A });

  creados.espacioCompartido = await sembrar('shared_spaces', { name: MARCA + '_compartido', invite_code: 'QAC' + suf, created_by: A });
  await sembrar('space_members', { space_id: creados.espacioCompartido, user_id: A });
  await sembrar('space_members', { space_id: creados.espacioCompartido, user_id: B });
  // `split_snapshot` tiene un CHECK que exige que los `cents` de `shares` sumen exactamente
  // el `amount` (`space_shares_conserve`). Un `{}` pelado no pasa: la plata tiene que cerrar
  // hasta en un fixture de QA.
  const gastoDeB = await sembrar('space_expenses', {
    space_id: creados.espacioCompartido, paid_by: B, amount: 40,
    split_snapshot: { shares: [{ user_id: B, cents: 2000 }, { user_id: A, cents: 2000 }] },
  });

  // ── El rastro de auditoría ─────────────────────────────────────────────────
  // Se genera solo: el trigger de la migración 055 copia cada `transacciones` borrada a
  // `borrados_auditoria`. Acá se fuerza uno ANTES del borrado para probar que la purga se
  // lleva también lo que ya estaba, no solo lo que el propio borrado produce.
  const txExtra = await sembrar('transacciones', { usuario_id: A, tipo: 'gasto', monto: 1, comercio: MARCA, categoria: 'Otros' });
  await supabase.from('transacciones').delete().eq('id', txExtra);
  const auditoriaAntes = await contar('borrados_auditoria', 'usuario_id', A);
  check('el trigger de auditoría dejó rastro ANTES del borrado (si no, la purga no probaría nada)',
    auditoriaAntes.n > 0, 'filas: ' + auditoriaAntes.n);

  console.log('\n=== Borrado ===');
  const { data: filaA } = await supabase.from('usuarios')
    .select('id, nombre, whatsapp, plan, tipo_plan, trial_estado, premium_vence, supabase_auth_id').eq('id', A).single();
  const r = await borrarCuenta(filaA, { origen: 'qa-harness' });
  console.log('  resultado: ' + JSON.stringify({ ok: r.ok, sucio: r.sucio, resumen: r.resumen }));
  check('el borrado reporta éxito', r.ok === true, r.motivo || '');
  if (!r.ok) return;   // sin borrado no hay nada que verificar

  console.log('\n=== Lo que tenía que desaparecer ===');

  // EL CHEQUEO AMPLIO ya lo hizo el RPC: recorre `pg_constraint` y cuenta lo que quedó en
  // cada tabla que apunta a `usuarios`, salvo las seis donde una fila viva es una DECISIÓN
  // (`pagos`, `gmail_cuentas`, y las cuatro de espacios). Se verifica su salida acá en vez de
  // reimplementar la introspección: dos copias de la misma consulta es como empiezan a
  // divergir, y además una copia en el harness no vería lo que ve el código de producción.
  const residual = (r.resumen && r.resumen.residual) || {};
  check('el residual dinámico está vacío (ninguna tabla sin clasificar quedó con filas)',
    Object.keys(residual).length === 0, JSON.stringify(residual));

  // Y aparte, los conteos explícitos de las tablas donde la lógica NO es un simple
  // `delete where usuario_id`: si alguna de estas fallara, el residual también lo diría, pero
  // el nombre del caso es lo que dice QUÉ se rompió.
  for (const [tabla, col] of [
    ['transacciones', 'usuario_id'], ['transacciones_eliminadas', 'usuario_id'],
    ['conversaciones', 'usuario_id'], ['notificaciones', 'usuario_id'],
    ['presupuestos', 'usuario_id'], ['categorias_usuario', 'usuario_id'],
    ['reglas_comercio', 'usuario_id'], ['recurrentes_overrides', 'usuario_id'],
    ['logros', 'usuario_id'], ['gmail_excluidos', 'usuario_id'],
    ['errores', 'usuario_id'], ['tickets_soporte', 'usuario_id'],
    ['metas_ahorro', 'usuario_id'], ['meta_participantes', 'usuario_id'],
    ['spending_alerts', 'user_id'], ['deudas', 'usuario_id'], ['space_members', 'user_id'],
  ]) {
    const { n, err } = await contar(tabla, col, A);
    check(tabla + ' quedó en 0', n === 0, err || ('quedan ' + n));
  }

  // Las que no se alcanzan por `usuario_id`.
  const { count: nlpQuedan } = await supabase.from('nlp_errors')
    .select('id', { count: 'exact', head: true }).eq('whatsapp', waA);
  check('nlp_errors: se borró por TELÉFONO la fila con usuario_id en null', nlpQuedan === 0, 'quedan ' + nlpQuedan);

  const { count: otpQuedan } = await supabase.from('webapp_otp')
    .select('id', { count: 'exact', head: true }).eq('whatsapp_claimed', waA);
  check('webapp_otp: se borró aunque no tenga FK a usuarios', otpQuedan === 0, 'quedan ' + otpQuedan);

  const { count: abonosQuedan } = await supabase.from('deuda_abonos')
    .select('id', { count: 'exact', head: true }).eq('deuda_id', deudaA);
  check('deuda_abonos se fue con su deuda', abonosQuedan === 0, 'quedan ' + abonosQuedan);

  // El aporte NO se borra por `usuario_id` (es null, y además la plata dentro de un contenedor
  // compartido sobrevive): tiene que morir por CASCADE cuando cae la meta. Es la aserción que
  // faltaba y que habría delatado la regresión de la 073c.
  const { count: aportesQuedan } = await supabase.from('meta_aportes')
    .select('id', { count: 'exact', head: true }).eq('meta_id', metaId);
  check('meta_aportes se fue por cascade con su meta (aunque su usuario_id sea null)',
    aportesQuedan === 0, 'quedan ' + aportesQuedan);

  console.log('\n=== El rastro de auditoría ===');
  const auditoriaDespues = await contar('borrados_auditoria', 'usuario_id', A);
  check('borrados_auditoria quedó en 0 (el borrado ya no MUEVE el dato, lo borra)',
    auditoriaDespues.n === 0, 'quedan ' + auditoriaDespues.n);
  const { count: purgas } = await supabase.from('purgas_auditoria')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', A);
  check('la purga quedó REGISTRADA (si no, se debilitó la tabla del incidente del 01-ago)',
    purgas === 1, 'filas de purga: ' + purgas);

  console.log('\n=== Lo que se conserva, sin lo que nombra a la persona ===');
  const { data: pago } = await supabase.from('pagos').select('id, monto, comprobante_url, notas').eq('id', pagoId).maybeSingle();
  check('pagos sigue vivo (obligación contable)', !!pago, 'la fila desapareció');
  check('pagos conserva el monto', pago && Number(pago.monto) === 10, 'monto: ' + pago?.monto);
  check('pagos ya NO tiene comprobante_url ni notas', !!pago && pago.comprobante_url === null && pago.notas === null,
    'comprobante: ' + pago?.comprobante_url + ' notas: ' + pago?.notas);

  const { data: lapida } = await supabase.from('usuarios')
    .select('id, whatsapp, nombre, email, bsuid, ref_code, supabase_auth_id, plan, premium_vence, cuenta_borrada_at, onboarding_paso')
    .eq('id', A).maybeSingle();
  check('la fila de usuarios sigue (ancla dato compartido con B)', !!lapida, 'desapareció');
  check('la lápida no tiene NINGÚN dato personal directo',
    !!lapida && !lapida.whatsapp && !lapida.nombre && !lapida.email && !lapida.bsuid && !lapida.ref_code && !lapida.supabase_auth_id,
    JSON.stringify(lapida));
  // Decisión lockeada: quien pagó conserva su Pro. El borrado NO toca el entitlement.
  check('el plan pagado NO se tocó', !!lapida && lapida.plan === 'premium' && lapida.premium_vence === '2027-03-15',
    'plan: ' + lapida?.plan + ' vence: ' + lapida?.premium_vence);
  check('cuenta_borrada_at quedó escrita', !!lapida && !!lapida.cuenta_borrada_at);
  // El residual del paso -1: el borrado lo saca del menú DENTRO de la misma transacción, así
  // que "borrado exitoso + atascado en paso -1" ya no es un estado alcanzable.
  check('salió del paso -1 en la misma transacción', !!lapida && lapida.onboarding_paso === 0, 'paso: ' + lapida?.onboarding_paso);

  const { data: gmailFila } = await supabase.from('gmail_cuentas')
    .select('email, email_hash, activa, refresh_token').eq('usuario_id', A).maybeSingle();
  check('gmail_cuentas: el correo en claro se fue', !!gmailFila && gmailFila.email === null, 'email: ' + gmailFila?.email);
  // La trampa más cara: sin el hash, esta persona puede volver y quemar otro de los 100 cupos
  // de por vida de Google pagando una sola vez.
  check('gmail_cuentas: el HASH sobrevivió (es lo único que protege el cupo)',
    !!gmailFila && !!gmailFila.email_hash, 'hash: ' + gmailFila?.email_hash);
  check('gmail_cuentas: los tokens se fueron', !!gmailFila && !gmailFila.refresh_token && gmailFila.activa === false);

  console.log('\n=== Las superficies que no son tablas ===');
  const { data: objetos } = await supabase.storage.from(BUCKET).list(A, { limit: 100 });
  check('Storage: no quedan comprobantes', (objetos || []).length === 0, 'quedan ' + (objetos || []).length);
  const { data: authDespues } = await supabase.auth.admin.getUserById(creados.authA);
  check('auth.users: la identidad web se borró', !authDespues?.user, 'sigue viva');

  console.log('\n=== Lo de B sigue intacto (es dato de otra persona) ===');
  const { data: deudaBDespues } = await supabase.from('deudas').select('id, monto_pendiente, deuda_vinculada_id').eq('id', deudaB).maybeSingle();
  check('la deuda de B sigue viva', !!deudaBDespues, 'desapareció');
  check('la deuda de B conserva su monto', !!deudaBDespues && Number(deudaBDespues.monto_pendiente) === 100, 'monto: ' + deudaBDespues?.monto_pendiente);
  check('la deuda de B quedó DESVINCULADA, no borrada', !!deudaBDespues && deudaBDespues.deuda_vinculada_id === null,
    'vinculada a: ' + deudaBDespues?.deuda_vinculada_id);

  const { data: espSolo } = await supabase.from('shared_spaces').select('id').eq('id', creados.espacioSolo).maybeSingle();
  check('el espacio donde A estaba SOLO se borró entero', !espSolo, 'sigue vivo');
  const { data: espComp } = await supabase.from('shared_spaces').select('id, created_by').eq('id', creados.espacioCompartido).maybeSingle();
  check('el espacio COMPARTIDO sobrevive (borrarlo destruiría los gastos de B)', !!espComp, 'se borró');
  const { data: gastoB } = await supabase.from('space_expenses').select('id, amount').eq('id', gastoDeB).maybeSingle();
  check('el gasto que pagó B sigue en su cuenta', !!gastoB && Number(gastoB.amount) === 40, 'desapareció o cambió');
  const { count: miembrosB } = await supabase.from('space_members')
    .select('id', { count: 'exact', head: true }).eq('space_id', creados.espacioCompartido).eq('user_id', B);
  check('B sigue siendo miembro del espacio', miembrosB === 1, 'miembros: ' + miembrosB);
}

// La limpieza corre paso a paso y NINGÚN paso puede tumbar a los siguientes.
//
// Estaba escrita como un try/catch único y en la primera corrida real se pagó: un statement
// mal escrito lo abortó a la mitad, y como Storage y `auth.users` se limpian AL FINAL, quedaron
// huérfanos en producción un objeto del bucket y una identidad de Supabase Auth — justo las
// dos superficies que este harness existe para verificar, y las dos que ningún cascade alcanza.
// Un cleanup que corta al primer fallo tiene el mismo bug que el wipe viejo que vino a probar.
async function paso(nombre, fn) {
  try { await fn(); } catch (e) { console.log('  aviso: falló "' + nombre + '" — ' + ((e && e.message) || String(e))); }
}

async function limpiar() {
  console.log('\n=== Limpieza ===');
  const { a: A, b: B, authA, espacioSolo, espacioCompartido } = creados;
  // Storage y auth PRIMERO, y no al final: son las dos superficies que ningún cascade alcanza
  // y las únicas cuyos huérfanos sobreviven a cualquier limpieza posterior de la DB. Lo que se
  // pierde por ponerlas antes es nada; lo que se ganaba poniéndolas después, tampoco.
  await paso('auth.users', async () => { if (authA) await supabase.auth.admin.deleteUser(authA); });
  await paso('storage', async () => { if (A) await supabase.storage.from(BUCKET).remove([A + '/' + MARCA + '.txt']); });

  // El orden importa igual que en el borrado: las hijas NO ACTION de `shared_spaces` van antes
  // que el espacio, o el DELETE aborta.
  for (const esp of [espacioSolo, espacioCompartido]) {
    if (!esp) continue;
    await paso('space_expenses ' + esp.slice(0, 8), () => supabase.from('space_expenses').delete().eq('space_id', esp));
    await paso('space_members ' + esp.slice(0, 8), () => supabase.from('space_members').delete().eq('space_id', esp));
    await paso('shared_spaces ' + esp.slice(0, 8), () => supabase.from('shared_spaces').delete().eq('id', esp));
  }
  for (const u of [A, B]) {
    if (!u) continue;
    await paso('desvincular deudas ' + u.slice(0, 8), () => supabase.from('deudas').update({ deuda_vinculada_id: null }).eq('usuario_id', u));
  }
  for (const u of [A, B]) {
    if (!u) continue;
    // Un DELETE sobre `usuarios` se lleva por cascade lo que quede: la lápida de A ya está
    // casi vacía y B es un throwaway.
    await paso('usuario ' + u.slice(0, 8), () => supabase.from('usuarios').delete().eq('id', u));
  }

  // El propio borrado y esta limpieza escriben en `borrados_auditoria` vía el trigger de la
  // migración 055. Es rastro de QA sobre usuarios de QA y se DEJA: forzarlo desde acá sería
  // exactamente lo que la 073 se cuidó de no permitir (la única puerta a esa tabla es una
  // baja de cuenta completa, y queda registrada en `purgas_auditoria`).
  console.log('  (queda rastro de QA en borrados_auditoria: es append-only a propósito)');
  console.log('  limpieza terminada');
}

main()
  .then(limpiar, async (e) => { console.error('\nERROR: ' + e.message); fallos.push('excepción: ' + e.message); await limpiar(); })
  .then(() => {
    console.log('\n' + resumenGuard());
    if (fallos.length) {
      console.log('\n' + fallos.length + ' FALLA(S):');
      for (const f of fallos) console.log('  · ' + f);
      process.exit(1);
    }
    console.log('\nTodo verde: el borrado borra, conserva lo declarado, y no toca lo de la otra persona.');
    process.exit(0);
  });
