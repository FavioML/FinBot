// neto-tools.js — OpenAI function calling tool definitions for Neto WhatsApp bot
// Collapses 79 intents across 12 handler files into ~17 tools

const NETO_TOOLS = [
  // ─── 1. Social / Conversational ───────────────────────────────────────
  {
    type: "function",
    function: {
      name: "social_response",
      description:
        "Respuestas sociales y conversacionales. Usa cuando el usuario saluda, pide ayuda, agradece, se queja, pide un chiste, quiere saber como empezar a usar Neto, o quiere dar feedback.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "greeting",
              "help",
              "thanks",
              "complaint",
              "joke",
              "onboarding",
              "feedback",
            ],
            description:
              "Tipo de interaccion social: greeting=saludo, help=ayuda, thanks=agradecimiento, complaint=queja, joke=chiste financiero, onboarding=como empezar, feedback=opinion del usuario",
          },
          message: {
            type: "string",
            description:
              "Mensaje original del usuario (para feedback o quejas)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 2. Premium / Account Status ─────────────────────────────────────
  {
    type: "function",
    function: {
      name: "manage_account",
      description:
        "Gestiona la cuenta del usuario: ver plan premium, referidos, estado de cuenta, cambiar nombre, silenciar/reactivar notificaciones, hablar con soporte, desconectar cuenta o cargar un Excel.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "view_premium",
              "view_referrals",
              "account_status",
              "change_name",
              "mute",
              "unmute",
              "talk_to_human",
              "disconnect",
              "upload_excel",
            ],
            description:
              "Accion sobre la cuenta: view_premium=ver plan, view_referrals=ver referidos, account_status=estado de cuenta, change_name=cambiar nombre, mute=silenciar, unmute=reactivar recordatorios, talk_to_human=hablar con humano, disconnect=desconectar, upload_excel=cargar Excel",
          },
          new_name: {
            type: "string",
            description: "Nuevo nombre del usuario (solo para change_name)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 3. Register Transaction ──────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "register_transaction",
      description:
        "Registra un nuevo gasto o ingreso. Usa cuando el usuario dice que gasto o pago algo, o que recibio dinero. Ejemplos: 'Pague 50 soles en almuerzo', 'Me pagaron 3000', 'Gaste 20 en taxi'. TAMBIEN cubre fraseos largos o hablados (notas de voz), como 'Hola, registro por favor un gasto de diez soles en taxi' o 'quiero anotar que gaste veinte lucas en el mercado'. REGLA: si el mensaje menciona un MONTO de un gasto/pago/ingreso puntual, SIEMPRE es register_transaction, aunque el usuario use el verbo 'registrar'/'anotar' o el fraseo sea largo. NUNCA lo trates como una regla de categoria (set_category_rule).",
      parameters: {
        type: "object",
        properties: {
          monto: {
            type: "number",
            description: "Monto de la transaccion",
          },
          moneda: {
            type: "string",
            enum: ["PEN", "USD"],
            description: "Moneda (default PEN)",
          },
          categoria: {
            type: "string",
            description:
              "Categoria del gasto (alimentacion, transporte, entretenimiento, salud, educacion, servicios, compras, otros)",
          },
          comercio: {
            type: "string",
            description:
              "Nombre del comercio o lugar (ej: Starbucks, Wong, Uber)",
          },
          descripcion: {
            type: "string",
            description: "Descripcion breve del gasto",
          },
          es_ingreso: {
            type: "boolean",
            description:
              "true si es un ingreso (sueldo, pago recibido), false si es gasto",
          },
          fecha: {
            type: "string",
            description:
              "Fecha de la transaccion en formato YYYY-MM-DD (default hoy)",
          },
        },
        required: ["monto"],
        additionalProperties: false,
      },
    },
  },

  // ─── 4. Manage Transaction (edit/delete/undo) ─────────────────────────
  {
    type: "function",
    function: {
      name: "manage_transaction",
      description:
        "Edita, corrige, elimina, restaura o manipula una transaccion existente. Usa para: recategorizar, cambiar monto/moneda, cambiar fecha, cambiar comercio, eliminar un gasto especifico, restaurar un gasto que se borro por error, deshacer el ultimo registro recien hecho, marcar como ingreso, duplicar, dividir entre personas, o crear regla de categoria para un comercio. IMPORTANTE: Cuando el usuario pida eliminar un gasto (action=delete), SIEMPRE extrae el monto, comercio y/o fecha exactos que el usuario mencione para que el borrado sea preciso. Si el usuario pregunta algo (mensaje termina en '?'), NO uses 'undo' ni 'delete' — usa social_response o financial_query. 'restablecer', 'restaurar', 'devolver', 'trae de vuelta' = action=restore (NO es undo ni delete). CRITICO: NO uses esta tool para registrar un gasto nuevo. Si el mensaje menciona un MONTO de una compra/pago/ingreso ('gaste 10 en taxi', 'registra un gasto de diez soles en taxi'), es register_transaction, NO manage_transaction. set_category_rule es SOLO para reglas generales SIN monto, del tipo 'todo lo de Rappi siempre va en Delivery' o 'clasifica Uber como Transporte'.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "recategorize",
              "batch_recategorize",
              "edit_amount_currency",
              "delete",
              "restore",
              "edit_amount",
              "edit_date",
              "edit_store",
              "set_category_rule",
              "undo",
              "mark_income",
              "split",
              "duplicate",
            ],
            description:
              "Accion: recategorize=cambiar categoria, batch_recategorize=corregir varias, edit_amount_currency=corregir monto y moneda, delete=eliminar gasto existente, restore=restaurar un gasto eliminado por error, edit_amount=editar monto, edit_date=editar fecha, edit_store=editar comercio, set_category_rule=asignar categoria fija a un comercio mediante una regla general SIN monto (ej: 'todo lo de Rappi va en Delivery'); NO usar si hay un monto de gasto puntual, undo=deshacer ultimo registro recien creado, mark_income=marcar como ingreso, split=dividir gasto, duplicate=duplicar",
          },
          comercio: {
            type: "string",
            description: "Nombre del comercio del gasto a eliminar o restaurar (para delete/restore). Ej: 'PedidosYa', 'Starbucks'.",
          },
          monto: {
            type: "number",
            description: "Monto exacto del gasto a eliminar o restaurar (para delete/restore). OBLIGATORIO extraerlo cuando el usuario lo mencione para evitar borrar el gasto equivocado.",
          },
          fecha: {
            type: "string",
            description: "Fecha del gasto a eliminar o restaurar YYYY-MM-DD (para delete/restore).",
          },
          transaction_id: {
            type: "string",
            description: "ID de la transaccion a modificar",
          },
          nueva_categoria: {
            type: "string",
            description: "Nueva categoria (para recategorize/set_category_rule)",
          },
          nuevo_monto: {
            type: "number",
            description: "Nuevo monto (para edit_amount o edit_amount_currency)",
          },
          nueva_moneda: {
            type: "string",
            enum: ["PEN", "USD"],
            description: "Nueva moneda (para edit_amount_currency)",
          },
          nueva_fecha: {
            type: "string",
            description: "Nueva fecha YYYY-MM-DD (para edit_date)",
          },
          nuevo_comercio: {
            type: "string",
            description: "Nuevo nombre de comercio (para edit_store)",
          },
          shared_with: {
            type: "array",
            items: { type: "string" },
            description:
              "Nombres de personas con quienes dividir (para split)",
          },
          partes: {
            type: "integer",
            description:
              "Numero de partes en que dividir el gasto (para split)",
          },
          categorias: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                categoria: { type: "string" },
              },
              required: ["id", "categoria"],
              additionalProperties: false,
            },
            description:
              "Lista de {id, categoria} para batch_recategorize",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 5. Query Expenses ────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_expenses",
      description:
        "Consulta y lista gastos del usuario. Usa cuando pregunta por sus gastos del mes, semana, dia, por categoria, en un rango de fechas, fin de semana, gastos hormiga (pequenos y frecuentes), total gastado, o busca un gasto especifico.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "month",
              "week",
              "day",
              "category",
              "range",
              "weekend",
              "ant_expenses",
              "total",
              "search",
              "frequency",
            ],
            description:
              "Tipo de consulta: month=mes, week=semana, day=dia, category=por categoria, range=rango fechas, weekend=fin de semana, ant_expenses=gastos hormiga, total=total gastado, search=buscar gasto, frequency=frecuencia en comercio",
          },
          categoria: {
            type: "string",
            description: "Categoria a filtrar (para action=category)",
          },
          fecha_inicio: {
            type: "string",
            description:
              "Fecha inicio YYYY-MM-DD (para action=range)",
          },
          fecha_fin: {
            type: "string",
            description: "Fecha fin YYYY-MM-DD (para action=range)",
          },
          mes: {
            type: "integer",
            description: "Mes (1-12), default mes actual",
          },
          anio: {
            type: "integer",
            description: "Anio (ej: 2026), default anio actual",
          },
          query: {
            type: "string",
            description:
              "Texto de busqueda (para action=search, ej: 'starbucks', 'taxi')",
          },
          comercio: {
            type: "string",
            description:
              "Nombre del comercio (para action=frequency)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 6. Manage Budget ─────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "manage_budget",
      description:
        "Gestiona presupuestos mensuales. Usa cuando el usuario quiere ver, crear, eliminar presupuestos, ver su balance (cuanto le queda), o ver las categorias disponibles.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["view", "set", "delete", "balance", "categories"],
            description:
              "Accion: view=ver presupuesto, set=configurar presupuesto, delete=eliminar presupuesto, balance=ver balance, categories=ver categorias",
          },
          categoria: {
            type: "string",
            description:
              "Categoria del presupuesto (para set/delete)",
          },
          monto: {
            type: "number",
            description: "Monto del presupuesto (para set)",
          },
          mes: {
            type: "integer",
            description: "Mes (1-12), default mes actual",
          },
          anio: {
            type: "integer",
            description: "Anio, default anio actual",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 7. Manage Goals ──────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "manage_goals",
      description:
        "Gestiona planes de ahorro (metas). Usa cuando el usuario quiere ver, crear, editar, eliminar, abonar a un plan, compartir progreso, ver viabilidad, abandonar un plan o pedir sugerencias de recorte.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["view", "create", "edit", "delete", "deposit", "share", "viability", "abandon", "suggest_cuts"],
            description:
              "Accion: view=ver planes, create=crear plan, edit=editar, delete=eliminar, deposit=abonar, share=compartir, viability=analisis viabilidad, abandon=abandonar plan, suggest_cuts=sugerir recortes de gasto",
          },
          nombre: {
            type: "string",
            description: "Nombre de la meta",
          },
          monto_objetivo: {
            type: "number",
            description: "Monto objetivo de la meta (para create/edit)",
          },
          monto_abono: {
            type: "number",
            description: "Monto a abonar (para deposit)",
          },
          fecha_limite: {
            type: "string",
            description: "Fecha limite YYYY-MM-DD (para create/edit)",
          },
          meta_id: {
            type: "string",
            description: "ID de la meta (para edit/delete/deposit/share)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 8. Manage Debts ──────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "manage_debts",
      description:
        "Gestiona deudas y prestamos. Usa cuando el usuario registra que debe o le deben dinero, quiere ver deudas, abonar, marcar como pagada, consolidar deudas con alguien, saldar todo con una persona, o dividir un gasto grupal.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "register",
              "view",
              "pay",
              "mark_paid",
              "consolidate",
              "settle_all",
              "split_group",
            ],
            description:
              "Accion: register=registrar deuda, view=ver deudas, pay=abonar, mark_paid=marcar pagada, consolidate=consolidar, settle_all=saldar todo con contraparte, split_group=dividir gasto grupal",
          },
          contraparte: {
            type: "string",
            description:
              "Nombre de la persona (a quien debo / quien me debe)",
          },
          monto: {
            type: "number",
            description: "Monto de la deuda o abono",
          },
          descripcion: {
            type: "string",
            description: "Descripcion de la deuda (ej: 'cena del viernes')",
          },
          yo_debo: {
            type: "boolean",
            description:
              "true = YO le debo a alguien (ej: 'debo 100 a Juan', 'me prestaron 50'). false = alguien ME debe a MI (ej: 'Juan me debe 100', 'le presté 200 a Ana', 'mi tía me debe'). Si el usuario dice 'X me debe' o 'le presté a X' siempre es false.",
          },
          deuda_id: {
            type: "string",
            description:
              "ID de la deuda (para pay/mark_paid)",
          },
          shared_with: {
            type: "array",
            items: { type: "string" },
            description:
              "Nombres de personas con quienes dividir el gasto grupal (para split_group). Ej: ['Annie', 'Diego']",
          },
          monto_total: {
            type: "number",
            description:
              "Monto total a dividir (para split_group)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 9. Gmail Integration ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "manage_gmail",
      description:
        "Gestiona la integracion con Gmail para escanear recibos y boletas. Usa cuando el usuario quiere escanear su correo, agregar/cambiar su Gmail, o cambiar preferencias de reporte.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "scan",
              "add_email",
              "change_email",
              "report_preference",
            ],
            description:
              "Accion: scan=escanear Gmail, add_email=agregar Gmail, change_email=cambiar Gmail, report_preference=preferencia de reporte",
          },
          email: {
            type: "string",
            description: "Direccion de correo Gmail (para add_email/change_email)",
          },
          preferencia: {
            type: "string",
            description:
              "Preferencia de reporte Gmail (para report_preference)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 10. Reports ──────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "generate_report",
      description:
        "Genera reportes financieros. Usa cuando el usuario pide su reporte, dashboard, exportar datos, compartir resumen o pide recomendaciones financieras personalizadas.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "report",
              "dashboard",
              "export",
              "share_summary",
              "recommendations",
            ],
            description:
              "Tipo de reporte: report=reporte mensual, dashboard=dashboard visual, export=exportar datos, share_summary=compartir resumen, recommendations=recomendaciones",
          },
          mes: {
            type: "integer",
            description: "Mes (1-12), default mes actual",
          },
          anio: {
            type: "integer",
            description: "Anio, default anio actual",
          },
          formato: {
            type: "string",
            enum: ["csv", "pdf", "excel"],
            description: "Formato de exportacion (para export)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 11. Analytics ────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_analytics",
      description:
        "Consultas analiticas avanzadas. Usa cuando el usuario pregunta por su gasto mayor, menor, promedio diario, historial de cambios, ingresos totales, cuanto paga en suscripciones o pagos recurrentes al mes (action=subscriptions), o quiere comparar meses.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "highest_expense",
              "lowest_expense",
              "daily_average",
              "change_history",
              "last_movement",
              "income",
              "subscriptions",
              "compare_months",
            ],
            description:
              "Tipo de analisis: highest_expense=gasto mayor, lowest_expense=gasto menor, daily_average=promedio diario, change_history=historial de cambios, last_movement=ver la ULTIMA transaccion/movimiento registrado (solo mostrar, NO borrar), income=ingresos, subscriptions=suscripciones, compare_months=comparar meses",
          },
          mes: {
            type: "integer",
            description: "Mes (1-12), default mes actual",
          },
          anio: {
            type: "integer",
            description: "Anio, default anio actual",
          },
          mes_comparar: {
            type: "integer",
            description:
              "Segundo mes para comparar (para compare_months)",
          },
          anio_comparar: {
            type: "integer",
            description:
              "Anio del segundo mes (para compare_months)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 12. Currency Tools ───────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "currency_tools",
      description:
        "Herramientas de tipo de cambio y conversion monetaria. Usa cuando el usuario pregunta el tipo de cambio, quiere convertir montos entre soles y dolares, o calcular cuotas de un prestamo.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["exchange_rate", "convert", "calculate_installments"],
            description:
              "Accion: exchange_rate=ver tipo de cambio, convert=convertir moneda, calculate_installments=calcular cuotas",
          },
          monto: {
            type: "number",
            description: "Monto a convertir o monto del prestamo",
          },
          de: {
            type: "string",
            enum: ["PEN", "USD"],
            description: "Moneda origen (para convert)",
          },
          a: {
            type: "string",
            enum: ["PEN", "USD"],
            description: "Moneda destino (para convert)",
          },
          cuotas: {
            type: "integer",
            description: "Numero de cuotas (para calculate_installments)",
          },
          tasa: {
            type: "number",
            description:
              "Tasa de interes anual en % (para calculate_installments)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 13. Financial Query ──────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "financial_query",
      description:
        "Consulta financiera general. Usa cuando el usuario hace una pregunta sobre finanzas personales, inversiones, ahorro, impuestos, etc. que no encaja en las otras herramientas. Ejemplo: 'Como puedo ahorrar mas?', 'Que es una AFP?', 'Conviene comprar dolares?'.",
      parameters: {
        type: "object",
        properties: {
          pregunta: {
            type: "string",
            description: "La pregunta financiera del usuario",
          },
        },
        required: ["pregunta"],
        additionalProperties: false,
      },
    },
  },

  // ─── 14. Payment Reminder ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "payment_reminder",
      description:
        "Crea o gestiona recordatorios de pago. Usa cuando el usuario quiere que le recuerden pagar algo en cierta fecha.",
      parameters: {
        type: "object",
        properties: {
          descripcion: {
            type: "string",
            description:
              "Descripcion del pago a recordar (ej: 'pagar luz', 'pagar tarjeta')",
          },
          fecha: {
            type: "string",
            description: "Fecha del recordatorio YYYY-MM-DD",
          },
          monto: {
            type: "number",
            description: "Monto del pago (opcional)",
          },
          recurrente: {
            type: "boolean",
            description: "Si el recordatorio es mensual recurrente",
          },
        },
        required: ["descripcion"],
        additionalProperties: false,
      },
    },
  },

  // ─── 15. Neto Score ──────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "neto_score",
      description:
        "Consulta el Neto Score (salud financiera 0-100). Usa cuando el usuario pregunta por su score, puntaje, nota financiera, salud financiera, o quiere tips para mejorar.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["view", "tips", "history"],
            description:
              "Accion: view=ver score actual, tips=consejos para mejorar, history=evolucion del score",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 16. Spending Alerts (Detector de Fugas) ─────────────────────────
  {
    type: "function",
    function: {
      name: "spending_alerts",
      description:
        "Detector de fugas y alertas de gasto. Usa cuando el usuario pregunta por fugas, alertas de gasto, donde se le va/pierde la plata, gastos anomalos o disparados este mes, o quiere poner un limite a una categoria. NO uses para consultar cuanto paga en suscripciones o pagos recurrentes al mes (eso es query_analytics action=subscriptions).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["view", "set_limit"],
            description:
              "Accion: view=ver fugas detectadas, set_limit=poner limite de gasto a una categoria",
          },
          categoria: {
            type: "string",
            description: "Categoria a limitar (para set_limit)",
          },
          monto_limite: {
            type: "number",
            description: "Monto limite mensual (para set_limit)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },

  // ─── 17. Shared Finances (Finanzas Compartidas) ───────────────────────
  {
    type: "function",
    function: {
      name: "shared_finances",
      description:
        "Gestiona finanzas compartidas (espacios para pareja, roommates, amigos). Usa cuando el usuario quiere crear un espacio compartido, registrar un gasto compartido, ver el balance del espacio, liquidar cuentas, invitar a alguien o unirse a un espacio.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create_space", "view_spaces", "register_expense", "view_balance", "settle", "invite", "join"],
            description:
              "Accion: create_space=crear espacio, view_spaces=ver mis espacios, register_expense=registrar gasto compartido, view_balance=ver balance y deudas, settle=liquidar/pagar deuda, invite=invitar a alguien, join=unirse a un espacio",
          },
          nombre: {
            type: "string",
            description: "Nombre del espacio (para create_space)",
          },
          tipo: {
            type: "string",
            enum: ["pareja", "roommates", "custom"],
            description: "Tipo de espacio (para create_space)",
          },
          nombre_espacio: {
            type: "string",
            description: "Nombre del espacio existente (para register_expense, view_balance, settle, invite)",
          },
          monto: {
            type: "number",
            description: "Monto del gasto compartido o pago (para register_expense, settle)",
          },
          descripcion: {
            type: "string",
            description: "Descripcion del gasto (para register_expense)",
          },
          categoria: {
            type: "string",
            description: "Categoria del gasto (para register_expense)",
          },
          contraparte: {
            type: "string",
            description: "Nombre de la persona a quien pagas (para settle)",
          },
          codigo: {
            type: "string",
            description: "Codigo de invitacion (para join)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

// ─── Intent Mapping ────────────────────────────────────────────────────────
// Maps each tool + action combination back to the exact intent name
// that our handler registry expects.

const TOOL_INTENT_MAP = {
  // social_response
  social_response: {
    greeting: "saludo",
    help: "ayuda",
    thanks: "agradecimiento",
    complaint: "queja",
    joke: "chiste_finanzas",
    onboarding: "como_empezar",
    feedback: "feedback",
  },

  // manage_account (premium + moderacion + utilidades.cambiar_nombre)
  manage_account: {
    view_premium: "ver_premium",
    view_referrals: "ver_referidos",
    account_status: "estado_cuenta",
    change_name: "cambiar_nombre",
    mute: "silenciar",
    unmute: "reactivar_recordatorios",
    talk_to_human: "hablar_con_humano",
    disconnect: "desconectar_cuenta",
    upload_excel: "cargar_excel",
  },

  // register_transaction
  register_transaction: "registrar_manual",

  // manage_transaction
  manage_transaction: {
    recategorize: "corregir_categoria",
    batch_recategorize: "corregir_multiple",
    edit_amount_currency: "corregir_monto_moneda",
    delete: "eliminar_transaccion",
    restore: "restaurar_eliminado",
    edit_amount: "editar_monto",
    edit_date: "editar_fecha",
    edit_store: "editar_comercio",
    set_category_rule: "editar_categoria_comercio",
    undo: "deshacer_ultimo",
    mark_income: "marcar_como_ingreso",
    split: "dividir_gasto",
    duplicate: "duplicar_gasto",
  },

  // query_expenses
  query_expenses: {
    month: "listar_gastos_mes",
    week: "listar_gastos_semana",
    day: "listar_gastos_dia",
    category: "listar_gastos_categoria",
    total: "ver_total_gastado",
    range: "ver_gastos_rango_fecha",
    weekend: "ver_gastos_fin_de_semana",
    ant_expenses: "gastos_hormiga",
    search: "buscar_gasto",
    frequency: "ver_frecuencia_comercio",
  },

  // manage_budget
  manage_budget: {
    view: "ver_presupuesto",
    set: "configurar_presupuesto",
    delete: "eliminar_presupuesto",
    balance: "ver_balance",
    categories: "ver_categorias",
  },

  // manage_goals
  manage_goals: {
    view: "ver_metas",
    create: "crear_meta",
    edit: "editar_meta",
    delete: "eliminar_meta",
    deposit: "abonar_meta",
    share: "compartir_meta",
    viability: "viabilidad_plan",
    abandon: "abandonar_plan",
    suggest_cuts: "sugerir_recortes",
  },

  // manage_debts
  manage_debts: {
    register: "registrar_deuda",
    view: "ver_deudas",
    pay: "abonar_deuda",
    mark_paid: "marcar_deuda_pagada",
    consolidate: "consolidar_deudas",
    settle_all: "saldar_todo_contraparte",
    split_group: "dividir_gasto_grupal",
  },

  // manage_gmail
  manage_gmail: {
    scan: "escanear_gmail",
    add_email: "agregar_gmail",
    change_email: "cambiar_gmail",
    report_preference: "preferencia_reporte_gmail",
  },

  // generate_report
  generate_report: {
    report: "ver_reporte",
    dashboard: "ver_dashboard",
    export: "exportar_datos",
    share_summary: "compartir_resumen",
    recommendations: "ver_recomendaciones",
  },

  // query_analytics
  query_analytics: {
    highest_expense: "ver_gasto_mayor",
    lowest_expense: "ver_gasto_menor",
    daily_average: "ver_promedio_diario",
    change_history: "ver_historial_cambios",
    last_movement: "ver_ultima_transaccion",
    income: "ver_ingresos",
    subscriptions: "ver_suscripciones",
    compare_months: "comparar_meses",
  },

  // currency_tools
  currency_tools: {
    exchange_rate: "ver_tipo_cambio",
    convert: "convertir_moneda",
    calculate_installments: "calcular_cuotas",
  },

  // financial_query
  financial_query: "consulta_financiera",

  // payment_reminder
  payment_reminder: "recordatorio_pago",

  // neto_score
  neto_score: {
    view: "ver_neto_score",
    tips: "tips_neto_score",
    history: "historial_neto_score",
  },

  // spending_alerts
  spending_alerts: {
    view: "ver_fugas",
    set_limit: "poner_limite_gasto",
  },

  // shared_finances
  shared_finances: {
    create_space: "crear_espacio",
    view_spaces: "ver_espacios",
    register_expense: "registrar_gasto_espacio",
    view_balance: "ver_balance_espacio",
    settle: "liquidar_espacio",
    invite: "invitar_espacio",
    join: "unirse_espacio",
  },
};

/**
 * Converts an OpenAI tool call (name + arguments) into the
 * { intencion, datos } format that our handler registry expects.
 *
 * @param {string} toolName - The function name from the tool call
 * @param {object} args - The parsed arguments object
 * @returns {{ intencion: string, datos: object }}
 */
// Remap tool argument names to handler-expected property names.
// Each key is "toolName.action" or just "toolName" for direct mappings.
// Values are { toolProp: handlerProp } rename maps.
const PROPERTY_REMAP = {
  "manage_transaction.recategorize": { nueva_categoria: "categoria_nueva" },
  "manage_transaction.edit_amount_currency": { nuevo_monto: "monto", nueva_moneda: "moneda" },
  "manage_transaction.edit_amount": { nuevo_monto: "monto_nuevo" },
  "manage_transaction.edit_date": { nueva_fecha: "fecha_nueva" },
  "manage_transaction.edit_store": { nuevo_comercio: "comercio_nuevo" },
  "manage_transaction.set_category_rule": { nueva_categoria: "categoria" },
  "manage_account.change_name": { new_name: "nombre_nuevo" },
  "manage_debts.register": { yo_debo: "_yo_debo" }, // handler reads datos.tipo
  "manage_debts.pay": {},
  "currency_tools.convert": { de: "moneda_origen", a: "moneda_destino" },
  "query_analytics.compare_months": { mes: "mes1", anio: "anio1", mes_comparar: "mes2", anio_comparar: "anio2" },
  "manage_goals.create": { monto_objetivo: "monto" },
  "manage_goals.deposit": { monto_abono: "monto", meta_id: "nombre_meta" },
  "manage_goals.edit": { monto_objetivo: "monto_nuevo", fecha_limite: "fecha_nueva" },
  "manage_gmail.report_preference": { preferencia: "modo" },
};

function mapToolToIntent(toolName, args) {
  const mapping = TOOL_INTENT_MAP[toolName];

  if (!mapping) {
    return { intencion: toolName, datos: args };
  }

  // Direct mapping (no action parameter) — e.g. register_transaction, financial_query, payment_reminder
  if (typeof mapping === "string") {
    return { intencion: mapping, datos: args };
  }

  // Action-based mapping
  const { action, ...datos } = args;
  const intencion = mapping[action];

  if (!intencion) {
    return { intencion: `${toolName}_${action}`, datos };
  }

  // Remap property names to match handler expectations
  const remapKey = `${toolName}.${action}`;
  const remap = PROPERTY_REMAP[remapKey];
  if (remap) {
    for (const [from, to] of Object.entries(remap)) {
      if (datos[from] !== undefined) {
        datos[to] = datos[from];
        delete datos[from];
      }
    }
  }

  // Special case: manage_debts.register — convert yo_debo boolean to tipo string
  if (toolName === "manage_debts" && action === "register") {
    if (datos._yo_debo !== undefined) {
      datos.tipo = datos._yo_debo ? "debo" : "me_deben";
      delete datos._yo_debo;
    }
  }

  return { intencion, datos };
}

module.exports = { NETO_TOOLS, mapToolToIntent };
