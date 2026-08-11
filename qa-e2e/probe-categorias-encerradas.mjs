// MIDE el daño del hallazgo B26 sobre los datos que YA están guardados. No escribe nada.
//
// B26: `detectarCategoriaIA` le pasaba al modelo SOLO el árbol propio del usuario, así que quien
// eligió pocas categorías en el onboarding quedaba encerrado — un taxi caía en "Finanzas" porque
// "Transporte" no estaba en su lista. El fix (commit de la Ola 3+) aplica de acá en adelante;
// este probe responde la otra pregunta: **cuánto histórico quedó mal**.
//
// Decisión de Favio (2026-08-11): medir, NO reclasificar. Tocar 343 transacciones que el usuario
// ya vio —y que quizá corrigió a mano— no tiene vuelta atrás fácil, y reclasificar con el LLM
// costaría una llamada por fila. Así que acá el criterio es DETERMINÍSTICO y auditable: se reusa
// `services/categorizer-keywords.js`, el mismo diccionario de keywords inequívocos que el
// backend ya usa como override post-LLM.
//
// Lo que reporta:
//   1. Cuántos usuarios están encerrados hoy (1-2 raíces propias) y cuántas tx tienen.
//   2. De sus transacciones, cuántas tienen un keyword inequívoco en la descripción que
//      CONTRADICE la categoría guardada — y a qué categoría deberían haber ido.
//   3. El mismo conteo para los usuarios NO encerrados, como control: si la tasa fuera parecida,
//      el encierro no sería la causa y este probe estaría midiendo otra cosa.
//
// Lo que NO puede decir: el keyword solo cubre una parte del vocabulario, así que el número es
// un PISO, no el total. Un "taxi" sin la palabra taxi en la descripción no se ve acá.
//
// Correr:  node qa-e2e/probe-categorias-encerradas.mjs   (desde app/)  → siempre exit 0.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { clienteGuardado } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { categorizarPorKeywords } = require(path.join(appRoot, 'services/categorizer-keywords.js'));
const { normalizarCategoria } = require(path.join(appRoot, 'lib/validators.js'));

// Cliente detrás de la barrera aunque este probe solo lea: las lecturas pasan libres, y el día
// que alguien le agregue un "…y de paso arreglá las filas" la barrera ya está puesta.
const supabase = clienteGuardado(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const UMBRAL_ENCIERRO = 2; // 1-2 raíces propias

async function main() {
  const { data: cats, error: eCats } = await supabase
    .from('categorias_usuario').select('usuario_id, padre_id, activa');
  if (eCats) throw new Error('categorias_usuario: ' + eCats.message);

  const raicesPorUsuario = new Map();
  for (const c of cats || []) {
    if (c.padre_id || c.activa === false) continue;
    raicesPorUsuario.set(c.usuario_id, (raicesPorUsuario.get(c.usuario_id) || 0) + 1);
  }

  const { data: users, error: eU } = await supabase
    .from('usuarios').select('id, is_test_user');
  if (eU) throw new Error('usuarios: ' + eU.message);
  const reales = new Set((users || []).filter(u => !u.is_test_user).map(u => u.id));

  const encerrados = new Set();
  const conArbolAmplio = new Set();
  for (const [uid, n] of raicesPorUsuario) {
    if (!reales.has(uid)) continue;
    if (n <= UMBRAL_ENCIERRO) encerrados.add(uid); else conArbolAmplio.add(uid);
  }

  // Paginado explícito: PostgREST corta en 1000 filas SIN avisar (error queda en null), que es
  // el mismo techo que muerde en `obtenerCategoriasUsuario`. Contar sobre una lista truncada
  // daría un número tranquilizador y falso.
  const tx = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase.from('transacciones')
      .select('id, usuario_id, categoria, descripcion_original, comercio')
      .eq('tipo', 'gasto')
      .order('id', { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error('transacciones: ' + error.message);
    tx.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }

  const contar = (conjunto) => {
    let filas = 0, conKeyword = 0, contradicen = 0;
    const detalle = new Map();
    for (const t of tx) {
      if (!conjunto.has(t.usuario_id)) continue;
      filas++;
      const texto = [t.descripcion_original, t.comercio].filter(Boolean).join(' ');
      const sugerida = categorizarPorKeywords(texto);
      if (!sugerida) continue;
      conKeyword++;
      if (normalizarCategoria(t.categoria) === normalizarCategoria(sugerida)) continue;
      contradicen++;
      const k = normalizarCategoria(t.categoria) + ' → ' + sugerida;
      detalle.set(k, (detalle.get(k) || 0) + 1);
    }
    return { filas, conKeyword, contradicen, detalle };
  };

  const enc = contar(encerrados);
  const amp = contar(conArbolAmplio);
  const tasa = (r) => (r.conKeyword === 0 ? '—' : (100 * r.contradicen / r.conKeyword).toFixed(1) + '%');

  console.log('\n─── B26: usuarios encerrados por su propio árbol de categorías ───\n');
  console.log(`encerrados (1-${UMBRAL_ENCIERRO} raíces propias) : ${encerrados.size} usuarios, ${enc.filas} gastos`);
  console.log(`con árbol amplio (3+)                : ${conArbolAmplio.size} usuarios, ${amp.filas} gastos`);
  console.log('\n─── Gastos con un keyword INEQUÍVOCO que contradice la categoría guardada ───\n');
  console.log(`encerrados     : ${enc.contradicen} de ${enc.conKeyword} con keyword  (${tasa(enc)})`);
  console.log(`árbol amplio   : ${amp.contradicen} de ${amp.conKeyword} con keyword  (${tasa(amp)})   ← control`);

  if (enc.detalle.size) {
    console.log('\ncómo se distribuyen los de los encerrados (guardado → debería):');
    for (const [k, n] of [...enc.detalle.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
  }

  console.log('\nEs un PISO, no el total: el diccionario de keywords cubre solo términos');
  console.log('inequívocos, así que un taxi sin la palabra "taxi" en la descripción no se ve acá.');
  console.log('No se escribió ninguna fila.\n');
}

await main();
