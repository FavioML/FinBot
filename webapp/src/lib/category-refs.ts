/**
 * TODO lugar del esquema donde vive el NOMBRE de una categoría, y qué se hace con
 * cada uno cuando el usuario renombra o borra la suya.
 *
 * POR QUÉ ES UNA DECLARACIÓN Y NO UNA LISTA SUELTA. La taxonomía se referencia por
 * NOMBRE, no por FK: no hay `on update cascade` que nos salve, así que cada tabla que
 * copia el nombre es un consumidor que hay que reetiquetar a mano. Antes esto era
 * `NAME_REF_TABLES = ['transacciones','presupuestos','reglas_comercio']` dentro del
 * endpoint — una lista sin forma de saber si estaba completa, y no lo estaba.
 *
 * LA REGLA AL AGREGAR UNA TABLA (o una columna) QUE GUARDE UN NOMBRE DE CATEGORÍA:
 * entra acá, en CASCADE_REFS o en EXEMPT_REFS. No hay tercera opción, y no es honor
 * system — dos guards lo exigen:
 *
 *   · `category-refs.test.ts` (hermético, cada push): que el código REETIQUETE de
 *     verdad cada entrada de CASCADE_REFS. Declararla sin cablearla no alcanza.
 *   · `qa-e2e/qa-categorias-cascade-schema.mjs` (contra prod): que no exista en la DB
 *     una columna de categoría que este archivo no nombre. Ese es el que cierra la
 *     clase: una tabla nueva aparece en el esquema y el guard se pone rojo.
 *
 * LÍMITE CONOCIDO Y NO CERRADO: el match es case-INSENSITIVE (la NLP y las listas
 * hardcodeadas guardan el casing de forma inconsistente, así que tiene que serlo),
 * pero el índice único de raíces de la migración 067 es case-SENSITIVE a propósito y
 * en prod hay un par que difiere solo en mayúsculas ("transporte"/"Transporte", ver
 * `route.ts` en el manejo del 23505). O sea que borrar "Transporte" también se lleva
 * los consumidores de "transporte", que sigue activa en el árbol. Es anterior a esta
 * declaración y no lo empeora de forma nueva; se cierra unificando las dos grafías, no
 * volviendo el cascade case-sensitive (eso rompería el caso para el que existe).
 *
 * OJO CON EL BARRIDO POR NOMBRE DE COLUMNA. Buscar `column_name ilike '%categor%'`
 * encuentra seis columnas y **se pierde las que guardan el nombre ADENTRO de un
 * jsonb** — `shared_spaces.split_rules[].category` es una de ellas, y es la que mueve
 * plata. Por eso EXEMPT_REFS también nombra jsonb, y el harness exige clasificar
 * TODA columna jsonb, no solo las que se llaman "categoria".
 */

/** Una tabla cuyo nombre de categoría se reetiqueta junto con el del árbol. */
export interface CascadeRef {
  /** Tabla en Postgres. */
  table: string;
  /** Columna que apunta al usuario dueño de la fila. */
  owner: string;
  /** Columna con el nombre de la categoría RAÍZ. */
  cat: string;
  /** Columna con el nombre de la SUBcategoría, o null si la tabla no tiene. */
  sub: string | null;
  /**
   * Qué le pasa a la fila cuando la categoría RAÍZ se borra.
   * `detach` = soltar el nombre (cat → null; y si hay `sub`, al centinela
   * `sin_categoria`, que es lo que enciende "Por revisar").
   * `delete` = borrar la fila.
   */
  onRootDelete: 'detach' | 'delete';
  /**
   * Qué le pasa cuando se borra una SUBcategoría. Solo aplica si `sub` no es null.
   * `detach` = la fila se queda con la categoría padre (sub → null).
   */
  onSubDelete: 'detach' | 'delete' | null;
  /** Por qué esta tabla sigue el rename personal del usuario. */
  why: string;
}

/**
 * EL ORDEN IMPORTA, y `reglas_comercio` va PRIMERA a propósito. Las escrituras no son
 * atómicas: si el proceso muere a la mitad, el peor estado posible es haber
 * desetiquetado las transacciones con la regla del comercio todavía viva, porque el
 * próximo gasto de ese comercio recrea la categoría (`syncCategoriasUsuario`) y el
 * borrado no pega. Es la única de las cinco cuya ausencia DESHACE el trabajo de las
 * otras, así que se hace antes que nada.
 */
export const CASCADE_REFS: readonly CascadeRef[] = [
  {
    table: 'reglas_comercio',
    owner: 'usuario_id',
    cat: 'categoria',
    sub: 'subcategoria',
    // Una regla a una categoría inexistente es PEOR que ninguna: el POST de
    // /api/transactions la aplicaría al próximo gasto de ese comercio y
    // syncCategoriasUsuario recrearía la categoría, o sea que el borrado no pegaría.
    onRootDelete: 'delete',
    onSubDelete: 'detach',
    why: 'comercio→categoría del usuario. Es la puerta que PISA lo que dedujo el clasificador (hallazgo B30), así que un nombre viejo acá se reescribe solo sobre los gastos que vengan.',
  },
  {
    table: 'transacciones',
    owner: 'usuario_id',
    cat: 'categoria',
    sub: 'subcategoria',
    onRootDelete: 'detach',
    onSubDelete: 'detach',
    why: 'el gasto del usuario. Es la tabla que el donut, los reportes y el score agrupan por nombre.',
  },
  {
    table: 'presupuestos',
    owner: 'usuario_id',
    cat: 'categoria',
    sub: 'subcategoria',
    // Un presupuesto sobre una categoría borrada no vuelve a matchear gasto nunca, y
    // el carry-forward del GET de /api/budgets lo copia a cada mes nuevo: un zombie
    // que se auto-propaga. Por eso `delete` y no `detach`.
    onRootDelete: 'delete',
    // Se BORRA en vez de nulear la sub: un presupuesto de "Comida > Restaurantes" que
    // pasara a "Comida" ensancharía su scope en silencio (y chocaría con el unique
    // constraint si ya hay uno de la categoría). Los de nivel categoría no se tocan.
    onSubDelete: 'delete',
    why: 'el límite mensual del usuario, matcheado por nombre contra el gasto.',
  },
  {
    table: 'gastos_compartidos',
    owner: 'creador_id',
    cat: 'categoria',
    sub: null,
    onRootDelete: 'detach',
    onSubDelete: null,
    why:
      'el gasto que el usuario divide con otros, colgado de SU `creador_id` y de su árbol personal. ' +
      'Al 2026-08-12 la tabla tiene 0 filas. `POST /api/split` SÍ persiste `categoria` desde el body ' +
      '(route.ts:53 y :111), pero ningún productor lo manda: ni la UI de /dashboard/deudas ni el ' +
      'intent de WhatsApp incluyen el campo. O sea que cascadearla es hoy puramente preventivo — y ' +
      'entra igual, porque el día que la UI ofrezca elegir categoría la va a tomar del árbol del creador.',
  },
  {
    table: 'spending_alerts',
    owner: 'user_id',
    cat: 'category',
    sub: null,
    // Una alerta sobre una categoría que ya no existe no se puede accionar: el botón
    // "ponle un límite" abriría un presupuesto sobre un nombre fantasma. Y el `message`
    // está congelado, así que tampoco se puede corregir el texto.
    //
    // Se borra TODO el histórico de esa categoría, no solo el mes en curso, y el motivo
    // no es el de la webapp: /api/alerts filtra por mes (route.ts:61) pero
    // `obtenerHistorialAlertas` (services/spending-alerts.js) NO, y es lo que contesta
    // "mis fugas" por WhatsApp. Acotarlo al mes dejaría ese canal mostrando una
    // categoría borrada. Es la decisión más destructiva de la tabla —y sin rastro, que
    // el trigger de la migración 055 solo cubre transacciones/deudas/abonos—, pero es
    // dato DERIVADO: el cron Pro de los miércoles lo regenera desde `transacciones`.
    onRootDelete: 'delete',
    onSubDelete: null,
    why:
      'el detector de fugas. `category` NO es decorativo: es la clave de dedup de /api/alerts ' +
      '(`${type}:${category}`) y el argumento del botón "ponle un límite", que crea un presupuesto ' +
      'con ese nombre. Sin reetiquetar, un rename a mitad de mes lista el MISMO spike dos veces ' +
      '(una por cada grafía) y el botón fabrica un presupuesto sobre una categoría que no existe.',
  },
];

/**
 * Referencias a un nombre de categoría que a propósito NO siguen el rename personal.
 * Cada una tiene que decir POR QUÉ, porque el default correcto es cascadear.
 */
export interface ExemptRef {
  /** `tabla.columna`, tal como la publica el esquema. */
  ref: string;
  reason: string;
}

export const EXEMPT_REFS: readonly ExemptRef[] = [
  {
    ref: 'space_expenses.category',
    reason:
      'NO es del árbol personal de nadie: el selector de /dashboard/espacios lo llena con la ' +
      'constante `CATEGORIAS` (fija y compartida), no con `categorias_usuario`. Cascadear el ' +
      'rename de UN miembro desincronizaría sus gastos de los del resto del espacio y de ' +
      '`shared_spaces.split_rules`, que matchea por `===` exacto. La plata no se mueve (el ' +
      'reparto se congela en `split_snapshot`), pero el agrupado del espacio se rompe para todos.',
  },
  {
    ref: 'shared_spaces.split_rules',
    reason:
      'jsonb `[{category, splits}]`, INVISIBLE a un barrido por nombre de columna. Vocabulario ' +
      'compartido del espacio, mismo argumento que `space_expenses.category` — y acá pesa más: ' +
      '`resolveSplitPlan` matchea `r.category === category` exacto, así que reescribir la regla ' +
      'por el rename de un miembro dejaría de matchear los gastos FUTUROS del resto y el espacio ' +
      'caería al reparto por defecto en silencio. Eso sí es plata.',
  },
  {
    ref: 'shared_spaces.budgets',
    reason:
      'jsonb `[{category, limit}]`. Mismo caso: límite conjunto del espacio sobre el vocabulario ' +
      'compartido, no sobre el árbol de quien renombra.',
  },
  {
    ref: 'transacciones_eliminadas.snapshot',
    reason:
      'jsonb con la FILA ENTERA borrada (incluye `categoria`/`subcategoria`), para restaurarla tal ' +
      'cual. Es una foto, no un dato vivo: reescribirla la vuelve una foto de algo que no pasó. ' +
      'Residual conocido y aceptado: deshacer un borrado DESPUÉS de un rename restaura la fila con ' +
      'el nombre viejo, o sea una fila huérfana. Son 15 filas en prod al 2026-08-12 y el usuario la ' +
      've en "Por revisar"; corregirlo pide `jsonb_set` vía RPC, desproporcionado para el tamaño.',
  },
  {
    ref: 'admin_costs.category',
    reason:
      'no es taxonomía de usuario: es el enum `public.admin_cost_category` de la contabilidad ' +
      'interna de Vortik (infra, APIs). Ningún usuario puede renombrarla.',
  },
  // Las jsonb restantes del esquema, declaradas para que el harness contra prod pueda
  // exigir que TODA jsonb esté clasificada en vez de mirar solo las que se llaman
  // "categoria". Si alguna empieza a guardar un nombre de categoría, se muda arriba.
  { ref: 'deudas.recordatorios_enviados', reason: 'ledger de fechas de recordatorio. Sin nombres de categoría.' },
  { ref: 'space_expenses.split_snapshot', reason: 'partes en centavos por user_id. Sin nombres de categoría.' },
  { ref: 'usuarios.bancos_seleccionados', reason: 'text[] de bancos para el barrido de Gmail. Sin nombres de categoría.' },
  { ref: 'logros.datos', reason: 'payload del logro (contadores, hitos). Sin nombres de categoría.' },
  { ref: 'survey_events.response_data', reason: 'respuestas de NPS/encuesta. Sin nombres de categoría.' },
  { ref: 'admin_costs.paid_history', reason: 'historial de pagos de un costo interno. Sin nombres de categoría.' },
  { ref: 'notificaciones.datos', reason: 'deeplink y metadatos de la campana in-app. Sin nombres de categoría.' },
  { ref: 'borrados_auditoria.fila', reason: 'caja negra de borrados duros (migración 055). Es evidencia forense: reescribirla la invalida.' },
  { ref: 'borrados_auditoria.contexto', reason: 'quién y desde dónde se hizo el borrado duro. Misma evidencia forense que `fila`: se conserva tal como quedó.' },
];

/** El centinela de subcategoría que enciende "Por revisar" en la webapp. */
export const SUB_SENTINEL_REVISAR = 'sin_categoria';
