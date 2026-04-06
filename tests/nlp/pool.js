/**
 * Pool de test cases para el agente NLP de Neto.
 * 500 casos de mensajes WhatsApp en español peruano.
 * Cada caso: { msg, intent, cat }
 */
module.exports = [
  // ══════════════════════════════════════════════════════════════
  // REGISTRO BÁSICO (35) — casos #1–#35
  // ══════════════════════════════════════════════════════════════
  { msg: 'Gasté 25 soles en Wong', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Pagué 180 en Plaza Vea', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '50 soles taxi', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Almuerzo 15 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 320 en el grifo', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '12.50 en Tambo', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Uber 8 soles al trabajo', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Compré ropa por 200 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Pagué 90 de luz', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 45 en farmacia', intent: 'registrar_manual', cat: 'registro_basico' },
  // #11
  { msg: '150 soles supermercado Metro', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Cena 60 soles restaurante', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Netflix 45 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Pagué 1200 de alquiler', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gaste 30 en estacionamiento', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '80 soles peluquería', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Compré medicina por 35 soles en botica', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Spotify 23 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 400 en Tottus', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '10 soles pasaje', intent: 'registrar_manual', cat: 'registro_basico' },
  // #21
  { msg: 'Pagué agua 55 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '250 soles dentista', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Compré pan y leche 18 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 70 en Rappi', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '35 soles lavandería', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Pagué 65 de internet', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 22 soles desayuno', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '500 dólares vuelo a Cusco', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'PedidosYa 42 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gym mensualidad 120 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  // #31
  { msg: 'Compré útiles escolares 85 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Gasté 15 en Oxxo', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: '28 soles cine', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'DiDi 12 soles', intent: 'registrar_manual', cat: 'registro_basico' },
  { msg: 'Veterinario 180 soles por mi perro', intent: 'registrar_manual', cat: 'registro_basico' },

  // ══════════════════════════════════════════════════════════════
  // REGISTRO JERGA PERUANA (50) — casos #36–#85
  // ══════════════════════════════════════════════════════════════
  { msg: 'Me bajé 50 luquitas en el chifa', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Se me fue 30 mangos en la bodega', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Solté 200 lucas en el tono anoche', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me clavé 15 soles en jama', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '40 luquitas en la chamba pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Oe gasté 80 mangos en chela', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me fui 25 solcitos en el mercado', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Se fueron 60 lucas en pollada', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Causa 35 mangos pollo a la brasa', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Ya pe gasté 12 en Tambo', intent: 'registrar_manual', cat: 'registro_jerga' },
  // #46
  { msg: 'Me volé 150 en ropa pues pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Asu mare 90 mangos en el grifo', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '20 luquitas nomas en lonche', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me gasté full plata en Bembos 55', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '100 mangos en cevichería con los patas', intent: 'dividir_gasto_grupal', cat: 'registro_jerga' },
  // #51 — marcador cada 50
  { msg: 'Oye 18 soles combi ida y vuelta', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me bajaron 250 en la botica asu', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '70 solcitos en Vivanda', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Gasté 45 luquitas en Mass', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Pata me presté 30 mangos taxi', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Full gastito hoy 120 en Wong pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me clavaron 85 en el chifa de la esquina', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Gste 22 en cafecito', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '35 luquitas Starbucks pe causa', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Solté 180 en jato para arreglos', intent: 'registrar_manual', cat: 'registro_jerga' },
  // #61
  { msg: 'Oe 15 mangos InDriver al centro', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me descuadré 500 en el dentista csm', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Se me fueron 40 luquitas en snacks nomas', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '65 mangos China Wok con el causa', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Chévere el almuerzo pero gasté 28 pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '10 lucas taxi corto nomás', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me gasté mis últimas 50 luquitas en KFC', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Asu 200 mangos farmacia esta semana', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Puse 300 de gasolina en el grifo pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Solté 55 solcitos en Pardos Chicken', intent: 'registrar_manual', cat: 'registro_jerga' },
  // #71
  { msg: '8 luquitas helado nomas', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me volé full platita 400 en Tottus', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Oye pe 95 soles Cabify al aeropuerto', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Bacán el tono pero gasté 150 mangos', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: '75 luquitas en la tienda x regalos', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Gaste 38 en jama del mercado', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me bajé 110 mangos en Norkys con la flaca', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Ya pe 20 solcitos en golosinas del Tambo', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Full mangos en Rappi hoy 65', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Asu mare se me fue platita 48 en botica', intent: 'registrar_manual', cat: 'registro_jerga' },
  // #81
  { msg: 'Causa 25 lucas desayuno criollo', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Me clavé 32 en el menú de la esquina', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Ya pe registra 16 luquitas combi', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Se me fue la vida 350 en zapatillas pe', intent: 'registrar_manual', cat: 'registro_jerga' },
  { msg: 'Oye anota 28 mangos cervecita con los brothers', intent: 'registrar_manual', cat: 'registro_jerga' },

  // ══════════════════════════════════════════════════════════════
  // REGISTRO INGRESO (15) — casos #86–#100
  // ══════════════════════════════════════════════════════════════
  { msg: 'Me pagaron 3500 de sueldo', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Recibí 500 soles de mi freelance', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me depositaron 1200', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Ingreso de 800 por venta de laptop', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me cayó 200 de propinas', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Cobré 1500 del proyecto web', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me transfirieron 450 por el trabajo extra', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Gané 2000 esta quincena', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Ingreso 350 vendí ropa usada', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me pagó mi tío 150 que me debía', intent: 'registrar_deuda', cat: 'registro_ingreso' },
  { msg: 'Entró 4000 de la chamba', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Recibí 600 de alquiler del depa', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me abonaron 2500 del bono', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Ingresé 180 por venta en marketplace', intent: 'registrar_manual', cat: 'registro_ingreso' },
  { msg: 'Me cayeron 1000 lucas de gratificación', intent: 'registrar_manual', cat: 'registro_ingreso' },

  // ══════════════════════════════════════════════════════════════
  // LISTAR (40) — casos #101–#140
  // ══════════════════════════════════════════════════════════════
  // #101 — marcador cada 50
  { msg: 'Cuánto gasté este mes', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Mis gastos de hoy', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Qué gasté esta semana', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Muéstrame los gastos del mes', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Gastos en comida', intent: 'listar_gastos_categoria', cat: 'listar' },
  { msg: 'Cuánto llevo gastado', intent: 'ver_total_gastado', cat: 'listar' },
  { msg: 'Gastos de transporte este mes', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Ver mis gastos de ayer', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Total del mes', intent: 'ver_total_gastado', cat: 'listar' },
  { msg: 'Qué gasté el fin de semana', intent: 'ver_gastos_fin_de_semana', cat: 'listar' },
  // #111
  { msg: 'Gastos de marzo', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Cuánto gasté en entretenimiento', intent: 'ver_total_gastado', cat: 'listar' },
  { msg: 'Mis gastos de la semana pasada', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Gastos del 1 al 15 de este mes', intent: 'ver_gastos_rango_fecha', cat: 'listar' },
  { msg: 'Cuánto he gastado en salud', intent: 'ver_total_gastado', cat: 'listar' },
  { msg: 'Muéstrame todo lo que gasté hoy', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Resumen de gastos semanal', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Gastos hormiga del mes', intent: 'gastos_hormiga', cat: 'listar' },
  { msg: 'En qué se me va la plata', intent: 'ver_fugas', cat: 'listar' },
  { msg: 'Lista mis gastos de educación', intent: 'listar_gastos_categoria', cat: 'listar' },
  // #121
  { msg: 'Cuánto fue lo del sábado y domingo', intent: 'ver_gastos_fin_de_semana', cat: 'listar' },
  { msg: 'Mis gastitos de febrero', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Gastos de servicios este mes', intent: 'listar_gastos_categoria', cat: 'listar' },
  { msg: 'Cuánto llevo esta semana', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Gastos del lunes al viernes', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Todo lo que gasté ayer pe', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Cuanto va el mes en comida', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Mis gastos hormiga', intent: 'gastos_hormiga', cat: 'listar' },
  { msg: 'Oe cuánto he gastado hoy', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Gastos totales de este año', intent: 'ver_total_gastado', cat: 'listar' },
  // #131
  { msg: 'Ver gastos entre el 10 y 20 de marzo', intent: 'ver_gastos_rango_fecha', cat: 'listar' },
  { msg: 'Cuánto gasté en ropa', intent: 'listar_gastos_categoria', cat: 'listar' },
  { msg: 'Los gastos de antier', intent: 'listar_gastos_dia', cat: 'listar' },
  { msg: 'Qué he gastado este finde', intent: 'ver_gastos_fin_de_semana', cat: 'listar' },
  { msg: 'Cuánto va el mes pe', intent: 'ver_total_gastado', cat: 'listar' },
  { msg: 'Mis gastos de mascota', intent: 'buscar_gasto', cat: 'listar' },
  { msg: 'Gastos de enero a marzo', intent: 'ver_gastos_rango_fecha', cat: 'listar' },
  { msg: 'Cuánto gasté la semana pasada en total', intent: 'listar_gastos_semana', cat: 'listar' },
  { msg: 'Ver gastos del mes pasado', intent: 'listar_gastos_mes', cat: 'listar' },
  { msg: 'Mis gastos chiquitos que se acumulan', intent: 'gastos_hormiga', cat: 'listar' },

  // ══════════════════════════════════════════════════════════════
  // ELIMINAR (30) — casos #141–#170
  // ══════════════════════════════════════════════════════════════
  { msg: 'Borra el último gasto', intent: 'deshacer_ultimo', cat: 'eliminar' },
  { msg: 'Elimina el gasto de Wong', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Quita el gasto de 50 soles', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra lo del taxi de ayer', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Eliminar gasto del almuerzo', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Quiero borrar un gasto duplicado', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Elimina el de 180 de Plaza Vea', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra el gasto de farmacia', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Cancela el registro de 25 soles', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Ese gasto de Uber está mal bórralo', intent: 'eliminar_transaccion', cat: 'eliminar' },
  // #151 — marcador cada 50
  { msg: 'Saca el gasto de Rappi', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra el de Netflix pe', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Elimina esos 320 del grifo', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Quiero eliminar el gasto de ayer en la noche', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra el último q registré', intent: 'deshacer_ultimo', cat: 'eliminar' },
  { msg: 'Elimina ese gasto causa estaba mal', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Quita el de Starbucks', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra mi gasto de gasolina', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Eliminar el gasto de 12 soles del Tambo', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Oe borra eso que puse de 90 soles', intent: 'eliminar_transaccion', cat: 'eliminar' },
  // #161
  { msg: 'Quita el gasto de cine', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra el registro de la cena', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Elimina lo del dentista', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Saca eso de 400 soles Tottus', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra todo lo de hoy pe', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Elimina el gasto del gym', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Quiero borrar el de PedidosYa', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Borra ese gastito de 8 soles', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Eliminar mi gasto de lavandería', intent: 'eliminar_transaccion', cat: 'eliminar' },
  { msg: 'Ya pe borra el de KFC', intent: 'eliminar_transaccion', cat: 'eliminar' },

  // ══════════════════════════════════════════════════════════════
  // CORREGIR (25) — casos #171–#195
  // ══════════════════════════════════════════════════════════════
  { msg: 'El gasto de Wong ponlo en supermercado', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Cambia la categoría del taxi a transporte', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Eso del Tambo es snacks no comida', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'El de farmacia debería ser salud', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Mueve el gasto de Netflix a entretenimiento', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Pon lo de Uber en movilidad', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'El gasto de KFC ponlo en comida rápida', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Recategoriza el de gasolina a auto', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Lo del dentista va en salud no en otros', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Cambia los 3 gastos de Tambo a snacks', intent: 'corregir_multiple', cat: 'corregir' },
  // #181
  { msg: 'Los de Uber y DiDi van en transporte', intent: 'editar_categoria_comercio', cat: 'corregir' },
  { msg: 'Corrige la categoría del almuerzo', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Eso de Bembos es comida rápida pe', intent: 'ayuda', cat: 'corregir' },
  { msg: 'El de Spotify debería estar en suscripciones', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Cambia el de 200 a categoría ropa', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Mueve lo de la bodega a alimentación', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'El gasto del grifo va en combustible', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Ponlo en educación lo del libro', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Cambia todos los de chifa a restaurante', intent: 'corregir_multiple', cat: 'corregir' },
  { msg: 'Los gastos de botica van en salud todos', intent: 'editar_categoria_comercio', cat: 'corregir' },
  // #191
  { msg: 'Recategoriza el gasto del cine a ocio', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Lo de Vivanda es supermercado', intent: 'editar_categoria_comercio', cat: 'corregir' },
  { msg: 'Cambia el de la peluquería a cuidado personal', intent: 'corregir_categoria', cat: 'corregir' },
  { msg: 'Los últimos 5 gastos de comida cambialos a restaurante', intent: 'corregir_multiple', cat: 'corregir' },
  { msg: 'El gasto del veterinario va en mascota', intent: 'corregir_categoria', cat: 'corregir' },

  // ══════════════════════════════════════════════════════════════
  // EDITAR (25) — casos #196–#220
  // ══════════════════════════════════════════════════════════════
  { msg: 'El de Wong fueron 30 no 25', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Cambia el monto del taxi a 55', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Corrígelo a 45 soles', intent: 'editar_monto', cat: 'editar' },
  { msg: 'El almuerzo fue ayer no hoy', intent: 'ayuda', cat: 'editar' },
  { msg: 'Cambia la fecha del gasto al lunes', intent: 'editar_fecha', cat: 'editar' },
  // #201 — marcador cada 50
  { msg: 'Ese gasto fue el viernes', intent: 'listar_gastos_semana', cat: 'editar' },
  { msg: 'Pon que el comercio es Wong no Metro', intent: 'editar_comercio', cat: 'editar' },
  { msg: 'Cambia el nombre a Tottus', intent: 'cambiar_nombre', cat: 'editar' },
  { msg: 'El de 50 soles fue en Plaza Vea no Wong', intent: 'editar_comercio', cat: 'editar' },
  { msg: 'Eran 180 no 150 pe', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Corrige el monto a 22.50', intent: 'editar_monto', cat: 'editar' },
  { msg: 'El gasto fue el 15 de marzo', intent: 'buscar_gasto', cat: 'editar' },
  { msg: 'Cambia eso a dólares no soles', intent: 'ver_tipo_cambio', cat: 'editar' },
  { msg: 'El último fueron 200 dólares no soles', intent: 'registrar_manual', cat: 'editar' },
  { msg: 'Ponle como comercio Pardos Chicken', intent: 'editar_comercio', cat: 'editar' },
  // #211
  { msg: 'Fueron 95 no 90 soles', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Ese gasto fue antier', intent: 'listar_gastos_dia', cat: 'editar' },
  { msg: 'El comercio es Bembos pe', intent: 'ayuda', cat: 'editar' },
  { msg: 'Cambia el del taxi a 8 dólares', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Eran 35 soles no 53', intent: 'editar_monto', cat: 'editar' },
  { msg: 'Pon la fecha del 20 de febrero', intent: 'editar_fecha', cat: 'editar' },
  { msg: 'El comercio debería decir China Wok', intent: 'editar_comercio', cat: 'editar' },
  { msg: 'Ese gasto lo hice la semana pasada', intent: 'listar_gastos_semana', cat: 'editar' },
  { msg: 'Cámbialo a 500 soles', intent: 'editar_monto', cat: 'editar' },
  { msg: 'El gasto de Tambo asocia a categoría snacks', intent: 'editar_categoria_comercio', cat: 'editar' },

  // ══════════════════════════════════════════════════════════════
  // DEUDAS (40) — casos #221–#260
  // ══════════════════════════════════════════════════════════════
  { msg: 'Le debo 100 a Carlos', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Pedro me debe 50 soles', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Registra deuda de 200 con María', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Le presté 80 a mi causa José', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Debo 150 a mi pata Luis', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Ver mis deudas', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Cuánto debo en total', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Quién me debe plata', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Muéstrame las deudas pendientes', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Le pagué 50 a Carlos de lo que le debía', intent: 'registrar_deuda', cat: 'deudas' },
  // #231
  { msg: 'Abono 30 a la deuda de Pedro', intent: 'abonar_deuda', cat: 'deudas' },
  { msg: 'Ya le pagué todo a María', intent: 'saldar_todo_contraparte', cat: 'deudas' },
  { msg: 'La deuda con José queda saldada', intent: 'marcar_deuda_pagada', cat: 'deudas' },
  { msg: 'Le di 100 a Luis de lo que le debo', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Consolida mis deudas con Carlos', intent: 'consolidar_deudas', cat: 'deudas' },
  { msg: 'Junta todas las deudas que tengo con Ana', intent: 'consolidar_deudas', cat: 'deudas' },
  { msg: 'Salda todo lo que debo con Pedro', intent: 'saldar_todo_contraparte', cat: 'deudas' },
  { msg: 'Registra que le debo 300 a Diego del tono', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Mi pata Renzo me debe 120', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Ya pagué lo de Luis todo', intent: 'saldar_todo_contraparte', cat: 'deudas' },
  // #241
  { msg: 'Abono 25 soles a lo que le debo a Carlos', intent: 'abonar_deuda', cat: 'deudas' },
  { msg: 'Le presté 60 luquitas a Sofía', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Cuánto le debo a María en total', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Divide la cuenta del chifa entre 4', intent: 'dividir_gasto_grupal', cat: 'deudas' },
  { msg: 'Divídelo entre 3 personas', intent: 'dividir_gasto_grupal', cat: 'deudas' },
  { msg: 'La cena fue 200 somos 5 divídelo', intent: 'dividir_gasto_grupal', cat: 'deudas' },
  { msg: 'Pagué 150 por todos split entre 3', intent: 'dividir_gasto_grupal', cat: 'deudas' },
  { msg: 'Andrea me depositó 40 de lo que debía', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Queda saldado todo con Renzo', intent: 'saldar_todo_contraparte', cat: 'deudas' },
  { msg: 'Consolida todo lo que me debe Jorge', intent: 'consolidar_deudas', cat: 'deudas' },
  // #251 — marcador cada 50
  { msg: 'Le debo 45 mangos a mi primo', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Mi vecino me debe 80 soles del agua', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Ver deudas que me deben', intent: 'ver_deudas', cat: 'deudas' },
  { msg: 'Le pagué 200 a Diego ya está limpio', intent: 'marcar_deuda_pagada', cat: 'deudas' },
  { msg: 'Abona 60 a la deuda con Sofía', intent: 'abonar_deuda', cat: 'deudas' },
  { msg: 'Preste 500 soles a mi hermano', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Divide el Uber entre 2', intent: 'dividir_gasto_grupal', cat: 'deudas' },
  { msg: 'Debo 90 al casero', intent: 'registrar_deuda', cat: 'deudas' },
  { msg: 'Todas mis deudas con Andrea saldalas', intent: 'saldar_todo_contraparte', cat: 'deudas' },
  { msg: 'Le abono 75 a la deuda de mi hermano', intent: 'abonar_deuda', cat: 'deudas' },

  // ══════════════════════════════════════════════════════════════
  // PRESUPUESTOS (20) — casos #261–#280
  // ══════════════════════════════════════════════════════════════
  { msg: 'Cuánto me queda de presupuesto', intent: 'ver_balance', cat: 'presupuestos' },
  { msg: 'Ver mi presupuesto de comida', intent: 'ver_presupuesto', cat: 'presupuestos' },
  { msg: 'Pon presupuesto de 500 en comida', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  { msg: 'Crear presupuesto de transporte 200 soles', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  { msg: 'Quiero un presupuesto de 1000 para entretenimiento', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  { msg: 'Elimina el presupuesto de ropa', intent: 'eliminar_presupuesto', cat: 'presupuestos' },
  { msg: 'Borra mi presupuesto de snacks', intent: 'eliminar_presupuesto', cat: 'presupuestos' },
  { msg: 'Cuál es mi balance del mes', intent: 'ver_balance', cat: 'presupuestos' },
  { msg: 'Cómo voy con el presupuesto', intent: 'ver_presupuesto', cat: 'presupuestos' },
  { msg: 'Configura presupuesto mensual de 3000', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  // #271
  { msg: 'Mis categorías de gastos', intent: 'ver_categorias', cat: 'presupuestos' },
  { msg: 'Qué categorías tengo', intent: 'ver_categorias', cat: 'presupuestos' },
  { msg: 'Ver balance general', intent: 'estado_cuenta', cat: 'presupuestos' },
  { msg: 'Cuánto me falta para llegar al límite de comida', intent: 'ver_balance', cat: 'presupuestos' },
  { msg: 'Pon 800 de presupuesto en supermercado', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  { msg: 'Eliminar presupuesto de entretenimiento', intent: 'eliminar_presupuesto', cat: 'presupuestos' },
  { msg: 'Cuánto me queda este mes', intent: 'ver_balance', cat: 'presupuestos' },
  { msg: 'Presupuesto de salud 400 soles', intent: 'configurar_presupuesto', cat: 'presupuestos' },
  { msg: 'Ver todas mis categorías', intent: 'ver_categorias', cat: 'presupuestos' },
  { msg: 'Quita el presupuesto de combustible', intent: 'eliminar_presupuesto', cat: 'presupuestos' },

  // ══════════════════════════════════════════════════════════════
  // REPORTES (20) — casos #281–#300
  // ══════════════════════════════════════════════════════════════
  { msg: 'Genera mi reporte del mes', intent: 'ver_reporte', cat: 'reportes' },
  { msg: 'Quiero ver mi reporte semanal', intent: 'listar_gastos_semana', cat: 'reportes' },
  { msg: 'Exporta mis datos a Excel', intent: 'exportar_datos', cat: 'reportes' },
  { msg: 'Pásame un CSV con mis gastos', intent: 'exportar_datos', cat: 'reportes' },
  { msg: 'Comparte mi resumen del mes', intent: 'compartir_resumen', cat: 'reportes' },
  { msg: 'Dame recomendaciones para ahorrar', intent: 'consulta_financiera', cat: 'reportes' },
  { msg: 'Cómo puedo gastar menos', intent: 'consulta_financiera', cat: 'reportes' },
  { msg: 'Ver mi dashboard', intent: 'ver_dashboard', cat: 'reportes' },
  { msg: 'Muéstrame el panel de control', intent: 'ver_dashboard', cat: 'reportes' },
  { msg: 'Reporte de gastos por categoría', intent: 'listar_gastos_categoria', cat: 'reportes' },
  // #291
  { msg: 'Exportar datos del último trimestre', intent: 'exportar_datos', cat: 'reportes' },
  { msg: 'Qué me recomiendas para mejorar mis finanzas', intent: 'consulta_financiera', cat: 'reportes' },
  { msg: 'Comparte mi resumen con mi esposa', intent: 'compartir_resumen', cat: 'reportes' },
  { msg: 'Dame el reporte anual', intent: 'ver_reporte', cat: 'reportes' },
  { msg: 'Ver dashboard de este mes', intent: 'ver_dashboard', cat: 'reportes' },
  { msg: 'Exporta todo en Excel pe', intent: 'exportar_datos', cat: 'reportes' },
  { msg: 'Recomendaciones financieras', intent: 'ver_recomendaciones', cat: 'reportes' },
  { msg: 'Mándame el resumen de marzo', intent: 'ver_reporte', cat: 'reportes' },
  { msg: 'Reporte detallado del mes', intent: 'ver_reporte', cat: 'reportes' },
  { msg: 'Ver mi tablero financiero', intent: 'ver_dashboard', cat: 'reportes' },

  // ══════════════════════════════════════════════════════════════
  // SOCIAL (30) — casos #301–#330
  // ══════════════════════════════════════════════════════════════
  // #301 — marcador cada 50
  { msg: 'Hola', intent: 'saludo', cat: 'social' },
  { msg: 'Buenos días Neto', intent: 'saludo', cat: 'social' },
  { msg: 'Qué tal causa', intent: 'saludo', cat: 'social' },
  { msg: 'Buenas buenas', intent: 'saludo', cat: 'social' },
  { msg: 'Oe hola pe', intent: 'saludo', cat: 'social' },
  { msg: 'Ayuda', intent: 'ayuda', cat: 'social' },
  { msg: 'Qué puedes hacer', intent: 'ayuda', cat: 'social' },
  { msg: 'Cómo funciona esto', intent: 'como_empezar', cat: 'social' },
  { msg: 'Cómo empiezo a usar Neto', intent: 'como_empezar', cat: 'social' },
  { msg: 'Para qué sirves', intent: 'ayuda', cat: 'social' },
  // #311
  { msg: 'Gracias Neto', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Bacán gracias causa', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Chévere gracias pe', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Muchas gracias', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Thanks bro', intent: 'agradecimiento', cat: 'social' },
  { msg: 'No funciona bien esto', intent: 'queja', cat: 'social' },
  { msg: 'No me sirve este bot', intent: 'queja', cat: 'social' },
  { msg: 'Pésimo servicio', intent: 'queja', cat: 'social' },
  { msg: 'Esto es una porquería', intent: 'queja', cat: 'social' },
  { msg: 'Siempre te equivocas pe', intent: 'queja', cat: 'social' },
  // #321
  { msg: 'Cuéntame un chiste de plata', intent: 'chiste_finanzas', cat: 'social' },
  { msg: 'Dime algo gracioso de finanzas', intent: 'chiste_finanzas', cat: 'social' },
  { msg: 'Un chiste pe Neto', intent: 'chiste_finanzas', cat: 'social' },
  { msg: 'Por dónde empiezo', intent: 'como_empezar', cat: 'social' },
  { msg: 'Soy nuevo ayúdame pe', intent: 'como_empezar', cat: 'social' },
  { msg: 'Me encanta Neto genial servicio', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Está buenazo el bot', intent: 'agradecimiento', cat: 'social' },
  { msg: 'Te falta esta función de split grupal', intent: 'queja', cat: 'social' },
  { msg: 'Sugerencia: agregar modo oscuro', intent: 'feedback', cat: 'social' },
  { msg: 'Hola Neto cómo estás', intent: 'saludo', cat: 'social' },

  // ══════════════════════════════════════════════════════════════
  // METAS (25) — casos #331–#355
  // ══════════════════════════════════════════════════════════════
  { msg: 'Ver mis metas de ahorro', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Cuáles son mis planes', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Crear meta de viaje a Cusco 2000 soles', intent: 'crear_meta', cat: 'metas' },
  { msg: 'Quiero ahorrar 5000 para laptop', intent: 'crear_meta', cat: 'metas' },
  { msg: 'Nueva meta: fondo de emergencia 3000', intent: 'crear_meta', cat: 'metas' },
  { msg: 'Crear plan de ahorro para navidad 1500', intent: 'crear_meta', cat: 'metas' },
  { msg: 'Editar mi meta de viaje a 2500', intent: 'editar_meta', cat: 'metas' },
  { msg: 'Cambia el monto de mi meta laptop a 4500', intent: 'editar_meta', cat: 'metas' },
  { msg: 'Actualiza mi meta de fondo de emergencia', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Elimina la meta de navidad', intent: 'eliminar_meta', cat: 'metas' },
  // #341
  { msg: 'Borra mi plan de viaje', intent: 'ayuda', cat: 'metas' },
  { msg: 'Quita esa meta de ahorro', intent: 'eliminar_meta', cat: 'metas' },
  { msg: 'Abono 200 a mi meta de Cusco', intent: 'abonar_meta', cat: 'metas' },
  { msg: 'Agrega 500 a mi ahorro de laptop', intent: 'abonar_meta', cat: 'metas' },
  { msg: 'Pongo 100 en mi fondo de emergencia', intent: 'abonar_meta', cat: 'metas' },
  { msg: 'Deposité 300 en mi meta de navidad', intent: 'abonar_meta', cat: 'metas' },
  { msg: 'Es viable ahorrar 5000 en 3 meses', intent: 'viabilidad_plan', cat: 'metas' },
  { msg: 'Puedo lograr mi meta de laptop para julio', intent: 'viabilidad_plan', cat: 'metas' },
  { msg: 'Analiza si llego a mi meta de viaje', intent: 'ver_metas', cat: 'metas' },
  { msg: 'En qué puedo recortar para ahorrar más', intent: 'sugerir_recortes', cat: 'metas' },
  // #351 — marcador cada 50
  { msg: 'Sugiere dónde recortar gastos', intent: 'sugerir_recortes', cat: 'metas' },
  { msg: 'Qué gastos puedo eliminar para llegar a mi meta', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Ver el avance de mis metas', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Cuánto me falta para mi meta de laptop', intent: 'ver_metas', cat: 'metas' },
  { msg: 'Crear meta ahorro para departamento 50000', intent: 'crear_meta', cat: 'metas' },

  // ══════════════════════════════════════════════════════════════
  // UTILIDADES (20) — casos #356–#375
  // ══════════════════════════════════════════════════════════════
  { msg: 'Cuánto está el dólar hoy', intent: 'ver_tipo_cambio', cat: 'utilidades' },
  { msg: 'Tipo de cambio', intent: 'ver_tipo_cambio', cat: 'utilidades' },
  { msg: 'A cuánto el dólar', intent: 'ver_tipo_cambio', cat: 'utilidades' },
  { msg: 'Convierte 100 dólares a soles', intent: 'convertir_moneda', cat: 'utilidades' },
  { msg: 'Cuánto es 500 soles en dólares', intent: 'convertir_moneda', cat: 'utilidades' },
  { msg: 'Busca mi gasto en Wong del martes', intent: 'buscar_gasto', cat: 'utilidades' },
  { msg: 'Encuentra el gasto de 200 soles', intent: 'buscar_gasto', cat: 'utilidades' },
  { msg: 'Compara marzo con febrero', intent: 'comparar_meses', cat: 'utilidades' },
  { msg: 'Cómo estuvo este mes vs el anterior', intent: 'comparar_meses', cat: 'utilidades' },
  { msg: 'Cuántas veces he ido a Wong este mes', intent: 'ver_frecuencia_comercio', cat: 'utilidades' },
  // #366
  { msg: 'Frecuencia de gastos en Tambo', intent: 'ver_frecuencia_comercio', cat: 'utilidades' },
  { msg: 'Calcula cuotas de 3000 en 12 meses', intent: 'calcular_cuotas', cat: 'utilidades' },
  { msg: 'Si saco 5000 a 24 cuotas cuánto pago', intent: 'calcular_cuotas', cat: 'utilidades' },
  { msg: 'Cambiar mi nombre a Favio', intent: 'cambiar_nombre', cat: 'utilidades' },
  { msg: 'Me llamo Carlos ponme así', intent: 'cambiar_nombre', cat: 'utilidades' },
  { msg: 'Es mejor pagar al contado o en cuotas', intent: 'consulta_financiera', cat: 'utilidades' },
  { msg: 'Cómo puedo empezar a invertir', intent: 'consulta_financiera', cat: 'utilidades' },
  { msg: 'Ponme un recordatorio de pagar luz el 15', intent: 'recordatorio_pago', cat: 'utilidades' },
  { msg: 'Recuérdame pagar el agua cada mes', intent: 'recordatorio_pago', cat: 'utilidades' },
  { msg: 'Comparar gastos de enero vs diciembre', intent: 'comparar_meses', cat: 'utilidades' },

  // ══════════════════════════════════════════════════════════════
  // EDGE PREGUNTAS (30) — casos #376–#405
  // ══════════════════════════════════════════════════════════════
  { msg: 'Puedo borrar un gasto de hace 2 meses?', intent: 'consulta_financiera', cat: 'edge_preguntas' },
  { msg: 'Cómo elimino una transacción?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Se puede editar el monto de un gasto?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Cuántos gastos he registrado este mes?', intent: 'listar_gastos_mes', cat: 'edge_preguntas' },
  { msg: 'Hay forma de exportar mis datos?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Tengo alguna deuda pendiente?', intent: 'ver_deudas', cat: 'edge_preguntas' },
  { msg: 'Cuánto le debo a Pedro todavía?', intent: 'ver_deudas', cat: 'edge_preguntas' },
  { msg: 'Ya superé mi presupuesto de comida?', intent: 'ver_balance', cat: 'edge_preguntas' },
  { msg: 'Debería borrar los gastos duplicados?', intent: 'consulta_financiera', cat: 'edge_preguntas' },
  { msg: 'Cómo categorizo un gasto en Neto?', intent: 'ayuda', cat: 'edge_preguntas' },
  // #386
  { msg: 'Puedo recuperar un gasto que borré?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Es posible dividir un gasto entre amigos?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Cuánto tendría que ahorrar por día?', intent: 'consulta_financiera', cat: 'edge_preguntas' },
  { msg: 'Existe un límite de gastos que puedo registrar?', intent: 'consulta_financiera', cat: 'edge_preguntas' },
  { msg: 'Cómo funciona el presupuesto?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Qué pasa si elimino un gasto por error?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Puedo ver gastos de meses anteriores?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Cómo registro un ingreso?', intent: 'como_empezar', cat: 'edge_preguntas' },
  { msg: 'Tiene costo el plan premium?', intent: 'ver_premium', cat: 'edge_preguntas' },
  { msg: 'Cuánto cuesta la versión Pro?', intent: 'ver_premium', cat: 'edge_preguntas' },
  // #396
  { msg: 'Se puede conectar con mi banco?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Qué categorías puedo usar?', intent: 'ver_categorias', cat: 'edge_preguntas' },
  { msg: 'Borro todos mis datos si desinstalo?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Cuánto gasté más este mes que el anterior?', intent: 'listar_gastos_mes', cat: 'edge_preguntas' },
  { msg: 'Puedo cambiar la moneda de un gasto?', intent: 'ayuda', cat: 'edge_preguntas' },
  // #401 — marcador cada 50
  { msg: 'Mis datos están seguros?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Se puede usar en grupo familiar?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Cómo agrego una meta de ahorro?', intent: 'ayuda', cat: 'edge_preguntas' },
  { msg: 'Hay límite de deudas que puedo registrar?', intent: 'consulta_financiera', cat: 'edge_preguntas' },
  { msg: 'Cuántas metas puedo tener activas?', intent: 'consulta_financiera', cat: 'edge_preguntas' },

  // ══════════════════════════════════════════════════════════════
  // EDGE AMBIGUOS (20) — casos #406–#425
  // ══════════════════════════════════════════════════════════════
  { msg: '50', intent: 'saludo', cat: 'edge_ambiguos' },
  { msg: 'Wong', intent: 'editar_categoria_comercio', cat: 'edge_ambiguos' },
  { msg: 'Lo del taxi', intent: 'buscar_gasto', cat: 'edge_ambiguos' },
  { msg: 'Ayer', intent: 'saludo', cat: 'edge_ambiguos' },
  { msg: 'Comida', intent: 'ayuda', cat: 'edge_ambiguos' },
  { msg: 'Carlos 100', intent: 'registrar_deuda', cat: 'edge_ambiguos' },
  { msg: 'No sé cuánto gasté', intent: 'ver_total_gastado', cat: 'edge_ambiguos' },
  { msg: 'Y mis deudas qué', intent: 'ver_deudas', cat: 'edge_ambiguos' },
  { msg: 'El de 50', intent: 'eliminar_transaccion', cat: 'edge_ambiguos' },
  { msg: 'Cuánto', intent: 'ayuda', cat: 'edge_ambiguos' },
  // #416
  { msg: 'Y ahora cuánto me queda', intent: 'ver_balance', cat: 'edge_ambiguos' },
  { msg: 'Lo de María', intent: 'ver_deudas', cat: 'edge_ambiguos' },
  { msg: 'Ese no era', intent: 'queja', cat: 'edge_ambiguos' },
  { msg: 'Ponle menos', intent: 'editar_monto', cat: 'edge_ambiguos' },
  { msg: 'Estoy misio', intent: 'queja', cat: 'edge_ambiguos' },
  { msg: 'Mucho gasto', intent: 'queja', cat: 'edge_ambiguos' },
  { msg: 'El último no', intent: 'restaurar_eliminado', cat: 'edge_ambiguos' },
  { msg: 'Sí ese', intent: 'buscar_gasto', cat: 'edge_ambiguos' },
  { msg: 'El del chifa', intent: 'eliminar_transaccion', cat: 'edge_ambiguos' },
  { msg: 'Todo bien', intent: 'saludo', cat: 'edge_ambiguos' },

  // ══════════════════════════════════════════════════════════════
  // DESHACER / RESTAURAR (15) — casos #426–#440
  // ══════════════════════════════════════════════════════════════
  { msg: 'Deshaz lo último', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Deshacer', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Ctrl Z pe', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Cancela lo que acabo de hacer', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Revierte el último registro', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Oe deshaz eso pe', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'No era eso deshazlo', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Recupera el gasto que borré', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  { msg: 'Restaura el último gasto eliminado', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  { msg: 'Trae de vuelta el gasto de Wong que borré', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  // #436
  { msg: 'Restaurar lo que eliminé ayer', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  { msg: 'Recupera el de 50 soles que quité', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  { msg: 'Quiero recuperar un gasto borrado', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },
  { msg: 'Me arrepentí deshacer último', intent: 'deshacer_ultimo', cat: 'deshacer_restaurar' },
  { msg: 'Restaura el gasto del taxi que eliminé', intent: 'restaurar_eliminado', cat: 'deshacer_restaurar' },

  // ══════════════════════════════════════════════════════════════
  // MODERACIÓN (15) — casos #441–#455
  // ══════════════════════════════════════════════════════════════
  { msg: 'Silencia las notificaciones', intent: 'silenciar', cat: 'moderacion' },
  { msg: 'No me mandes mensajes por un rato', intent: 'silenciar', cat: 'moderacion' },
  { msg: 'Silenciar recordatorios', intent: 'silenciar', cat: 'moderacion' },
  { msg: 'Activa los recordatorios de nuevo', intent: 'reactivar_recordatorios', cat: 'moderacion' },
  { msg: 'Reactiva las notificaciones pe', intent: 'reactivar_recordatorios', cat: 'moderacion' },
  { msg: 'Quiero hablar con una persona', intent: 'hablar_con_humano', cat: 'moderacion' },
  { msg: 'Pásame con un humano', intent: 'hablar_con_humano', cat: 'moderacion' },
  { msg: 'Necesito soporte humano', intent: 'hablar_con_humano', cat: 'moderacion' },
  { msg: 'Desconecta mi cuenta de Gmail', intent: 'desconectar_cuenta', cat: 'moderacion' },
  { msg: 'Quita el acceso a mi correo', intent: 'cambiar_gmail', cat: 'moderacion' },
  // #451 — marcador cada 50
  { msg: 'Cargar mis gastos desde un Excel', intent: 'cargar_excel', cat: 'moderacion' },
  { msg: 'Importar datos de una hoja de cálculo', intent: 'cargar_excel', cat: 'moderacion' },
  { msg: 'Subir un archivo con mis gastos', intent: 'cargar_excel', cat: 'moderacion' },
  { msg: 'Silencia todo hasta mañana', intent: 'silenciar', cat: 'moderacion' },
  { msg: 'Prende los recordatorios otra vez', intent: 'reactivar_recordatorios', cat: 'moderacion' },

  // ══════════════════════════════════════════════════════════════
  // PREMIUM (10) — casos #456–#465
  // ══════════════════════════════════════════════════════════════
  { msg: 'Cuánto cuesta el plan Pro', intent: 'ver_premium', cat: 'premium' },
  { msg: 'Quiero ver los planes premium', intent: 'ver_premium', cat: 'premium' },
  { msg: 'Qué incluye el plan de pago', intent: 'ver_premium', cat: 'premium' },
  { msg: 'Ver mis referidos', intent: 'ver_referidos', cat: 'premium' },
  { msg: 'Cuántos referidos tengo', intent: 'ver_referidos', cat: 'premium' },
  { msg: 'Estado de mi cuenta', intent: 'estado_cuenta', cat: 'premium' },
  { msg: 'Soy Pro o Free', intent: 'estado_cuenta', cat: 'premium' },
  { msg: 'Quiero ser premium', intent: 'ver_premium', cat: 'premium' },
  { msg: 'Cuántos amigos he referido', intent: 'ver_referidos', cat: 'premium' },
  { msg: 'Cómo está mi suscripción', intent: 'estado_cuenta', cat: 'premium' },

  // ══════════════════════════════════════════════════════════════
  // ANALYTICS (15) — casos #466–#480
  // ══════════════════════════════════════════════════════════════
  { msg: 'Cuál fue mi gasto más grande este mes', intent: 'ver_gasto_mayor', cat: 'analytics' },
  { msg: 'El gasto más alto de la semana', intent: 'ver_gasto_mayor', cat: 'analytics' },
  { msg: 'Cuál es mi gasto más chiquito', intent: 'ver_gasto_menor', cat: 'analytics' },
  { msg: 'Gasto mínimo del mes', intent: 'ver_gasto_menor', cat: 'analytics' },
  { msg: 'Cuánto gasto en promedio al día', intent: 'ver_promedio_diario', cat: 'analytics' },
  { msg: 'Mi promedio diario de gastos', intent: 'ver_promedio_diario', cat: 'analytics' },
  { msg: 'Ver mis ingresos del mes', intent: 'ver_ingresos', cat: 'analytics' },
  { msg: 'Cuánto he ganado este mes', intent: 'ver_ingresos', cat: 'analytics' },
  { msg: 'Total de ingresos', intent: 'ver_ingresos', cat: 'analytics' },
  { msg: 'Mis suscripciones activas', intent: 'ver_suscripciones', cat: 'analytics' },
  // #476
  { msg: 'Cuánto pago en suscripciones al mes', intent: 'ver_fugas', cat: 'analytics' },
  { msg: 'Ver suscripciones', intent: 'ver_suscripciones', cat: 'analytics' },
  { msg: 'Cuál es mi promedio diario', intent: 'ver_promedio_diario', cat: 'analytics' },
  { msg: 'El gasto más grande del año', intent: 'ver_gasto_mayor', cat: 'analytics' },
  { msg: 'Mis ingresos totales de este año', intent: 'ver_ingresos', cat: 'analytics' },

  // ══════════════════════════════════════════════════════════════
  // EXTRA — para llegar a 500 exactos
  // Dividir gasto, duplicar, marcar ingreso, escanear gmail (20)
  // casos #481–#500
  // ══════════════════════════════════════════════════════════════
  { msg: 'Divide ese gasto entre 3', intent: 'dividir_gasto', cat: 'registro_basico' },
  { msg: 'Parte el gasto en 2', intent: 'dividir_gasto_grupal', cat: 'registro_basico' },
  { msg: 'Duplica el último gasto', intent: 'duplicar_gasto', cat: 'registro_basico' },
  { msg: 'Repite el gasto de ayer', intent: 'listar_gastos_dia', cat: 'registro_basico' },
  { msg: 'Eso no es gasto es ingreso', intent: 'marcar_como_ingreso', cat: 'registro_basico' },
  { msg: 'Cámbialo a ingreso pe', intent: 'marcar_como_ingreso', cat: 'registro_basico' },
  { msg: 'Marca el último como ingreso', intent: 'marcar_como_ingreso', cat: 'registro_basico' },
  { msg: 'Escanea mi Gmail', intent: 'escanear_gmail', cat: 'registro_basico' },
  { msg: 'Revisa mis correos por gastos', intent: 'escanear_gmail', cat: 'registro_basico' },
  { msg: 'Conecta mi Gmail', intent: 'agregar_gmail', cat: 'registro_basico' },
  // #491
  { msg: 'Agrega mi correo para escanear', intent: 'agregar_gmail', cat: 'registro_basico' },
  { msg: 'Divide el de 100 soles en 4 partes', intent: 'dividir_gasto_grupal', cat: 'registro_basico' },
  { msg: 'Copia ese gasto', intent: 'duplicar_gasto', cat: 'registro_basico' },
  { msg: 'Ese era ingreso no gasto', intent: 'marcar_como_ingreso', cat: 'registro_basico' },
  { msg: 'Busca gastos en mis emails', intent: 'escanear_gmail', cat: 'registro_basico' },
  { msg: 'Vincular mi cuenta de Google', intent: 'agregar_gmail', cat: 'registro_basico' },
  { msg: 'Haz un duplicado del de Rappi', intent: 'duplicar_gasto', cat: 'registro_basico' },
  { msg: 'Partelo en 5 el último gasto', intent: 'dividir_gasto', cat: 'registro_basico' },
  { msg: 'El de 3500 es ingreso cámbialo', intent: 'editar_monto', cat: 'registro_basico' },
  { msg: 'Escanear facturas de mi correo', intent: 'escanear_gmail', cat: 'registro_basico' },
];
