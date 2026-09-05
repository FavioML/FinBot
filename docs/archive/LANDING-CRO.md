# LANDING-CRO.md — Análisis CRO de NETO
**Fecha de análisis:** 24 de marzo de 2026
**Páginas auditadas:** neto.pe (landing) + app.neto.pe (webapp dashboard)
**Objetivo primario:** Aumentar conversión de visitante → usuario registrado → usuario activo → usuario Pro

---

## RESUMEN EJECUTIVO

| Área | Puntuación | Estado |
|---|---|---|
| Mensaje y propuesta de valor | 82/100 | Bueno |
| Flujo de conversión (landing) | 71/100 | Mejorable |
| Experiencia de onboarding (webapp) | 58/100 | Critico |
| Retención y activación (dashboard) | 64/100 | Mejorable |
| Copy y persuasión | 76/100 | Bueno |
| Mobile UX | 67/100 | Mejorable |
| Confianza y credibilidad | 60/100 | Mejorable |

**Score global estimado: 68/100**

**Conversión estimada actual (landing → registro):** 2–4%
**Potencial con fixes prioritarios:** 6–9%

---

## SECCIÓN 1: MENSAJE Y PROPUESTA DE VALOR

### Score: 82/100

### Fortalezas

**Headline principal es excelente.**
"Ordena tu plata sin mover un dedo" cumple los tres requisitos de un buen headline SaaS:
- Usa jerga peruana auténtica ("plata", no "dinero")
- Promete un resultado concreto (orden financiero)
- Implica esfuerzo cero (sin mover un dedo)

**Subheadline elimina objeciones proactivamente.**
"Sin apps. Sin contraseñas bancarias. Solo resultados." ataca directamente los tres mayores miedos del usuario peruano ante fintech:
1. No quiero instalar otra app
2. No confío dando mis claves
3. Quiero resultados, no configuración

**El mock dashboard debajo del fold está bien concebido.**
Mostrar "Esta semana gastaste S/847", "Score 72/100", "Ahorro S/340 +12%" ancla el valor en números concretos antes de que el usuario haga clic.

### Problemas detectados

**P1 — El beneficio principal no está jerarquizado visualmente.**
La subheadline tiene tres claims separados por puntos. El claim más poderoso ("Sin contraseñas bancarias") está enterrado al final. Debería estar primero o ser el elemento más destacado porque elimina el bloqueo psicológico número uno del segmento.

**P2 — "Consultas naturales" es un feature, no un beneficio.**
La sección que describe "hablar con Neto como a un amigo" usa lenguaje de producto. Para el usuario joven peruano, debería decir algo como: "Pregunta '¿cuánto gasté en delivery este mes?' y Neto te responde en segundos."

**P3 — El mock dashboard muestra un score de 72/100.**
72 es "aceptable". El usuario puede pensar "yo probablemente tengo menos". En vez de generar aspiración, puede generar desmotivación. Cambiar a un score de 84/100 con un delta positivo visible aumentaría la aspiracionalidad.

### Recomendaciones

- Reordenar subheadline: "Sin contraseñas bancarias. Sin apps. Solo resultados."
- Reescribir la sección de consultas con ejemplos concretos tipo chat
- Cambiar el score del mock a 84/100 con tendencia ascendente

---

## SECCIÓN 2: FLUJO DE CONVERSIÓN (LANDING → REGISTRO)

### Score: 71/100

### Mapa del funnel actual

```
Visitante
  → Hero (CTA primario: "Empezar gratis →")
  → Scroll: Cómo funciona (3 pasos)
  → Scroll: Features
  → Scroll: Testimonios
  → Scroll: Precios
  → Scroll: CTA final ("¿A dónde se fue tu plata este mes?")
  → Login page (Google OAuth)
  → Dashboard
```

### Fortalezas

- Dos CTAs en hero (primario + secundario) cubre dos tipos de intención: listo para registrarse vs. quiere saber precios primero.
- CTA final con copy emocional ("¿A dónde se fue tu plata este mes?") es excelente — genera curiosidad, culpa leve, y urgencia. El botón amarillo/amber rompe el patrón visual del resto del dark theme, lo que aumenta el click-through.
- "Gratis · Sin tarjeta · Sin contraseña bancaria" como subtexto del CTA final elimina fricción en el momento de decisión.
- La página de precios tiene comparación clara Free vs Pro con tabla de features.

### Problemas detectados

**P4 — Un solo CTA en el hero es insuficiente para mobile.**
En pantallas pequeñas, el botón "Empezar gratis" puede quedar encima del fold pero el usuario hace scroll sin hacer clic. Se necesita un CTA sticky en mobile (barra inferior o botón flotante).

**P5 — Los 3 pasos del "Cómo funciona" son demasiado abstractos.**
"Conectas tu Gmail, Neto trabaja solo, Recibes tu resumen" suena bien pero no muestra cuánto tiempo toma el paso 1. Para un peruano desconfiado con su Gmail bancario, "conectar Gmail" puede sonar a dar acceso total. Agregar micro-copy: "Solo acceso de lectura a correos del banco. No podemos enviar correos ni acceder a tu cuenta."

**P6 — No hay indicador de tiempo al valor.**
El usuario no sabe qué tan rápido verá resultados. Un claim como "En 5 minutos ya sabes cuánto gastaste este mes" en el hero aumentaría la conversión significativamente.

**P7 — El precio S/10/mes aparece muy tarde en el funnel.**
Un usuario que llega al CTA final sin haber visto precios puede abandonar al descubrir que hay un plan de pago. Considerar mencionar el plan Free prominentemente en el hero ("Empieza gratis, siempre") para eliminar esta incertidumbre temprano.

**P8 — La página de login (app.neto.pe) es un dead end para no-Google.**
El login solo ofrece Google OAuth. El link "¿No tienes Google? Escríbenos por WhatsApp" está en texto pequeño al final. Para usuarios con Gmail de trabajo (corporate Google Workspace), el OAuth puede fallar silenciosamente. Esto no está documentado.

### Recomendaciones

- Agregar "En 5 minutos ya sabes en qué gastas" al hero como claim secundario
- Reescribir paso 1 con micro-copy de seguridad sobre acceso de lectura
- Agregar barra sticky en mobile con CTA
- Mostrar "Siempre gratis para empezar" en el hero junto al CTA primario
- En la página de login, hacer el link de WhatsApp más visible (botón outline, no link de texto)

---

## SECCIÓN 3: EXPERIENCIA DE ONBOARDING (WEBAPP)

### Score: 58/100 — CRÍTICO

Esta es el área con mayor impacto en activación y el mayor punto de abandono potencial.

### Problemas críticos

**P9 — El dashboard muestra datos abrumadores sin contexto de onboarding.**
Un usuario nuevo ve: Ingresos S/5,068.80, Gastos S/5,014.69, Score 56, área chart, donut chart, transacciones recientes, suscripciones. Si el usuario aún no ha conectado Gmail, todos estos datos son vacíos o de ejemplo. No hay ningún estado vacío diseñado. Esto es probablemente el mayor abandono post-registro.

**P10 — No existe un flujo de "primer uso" (empty state + setup wizard).**
No hay un paso 0 que guíe al usuario desde "acabo de registrarme" hasta "ya conecté mi Gmail y vi mi primer resumen". El usuario llega al dashboard y está solo. Comparar con Notion (checklist de bienvenida), Linear (setup wizard), o cualquier SaaS moderno.

**P11 — El Score 56/100 con etiqueta "Atención" es desmotivante como primera impresión.**
Si el score real del usuario es bajo, la primera pantalla del reporte dice "Atención" en rojo/naranja. Para un usuario nuevo esto puede generar rechazo inmediato ("este producto me está juzgando"). El score debería revelarse progresivamente, con contexto educativo antes de mostrar el número.

**P12 — El score de salud financiera no tiene explicación en el dashboard principal.**
El KPI "Score 56" aparece en el dashboard sin ningún tooltip ni link de "¿Qué significa esto?" Un usuario nuevo no sabe si 56 es bueno o malo en el contexto de NETO.

**P13 — "Chatea con NETO" en el sidebar abre WhatsApp.**
Esto es un UX break: el usuario está en la web, hace clic en algo que parece in-app, y lo manda a otra app. No hay aviso de que va a salir. En mobile es especialmente disruptivo. Debería tener un tooltip: "Te mandamos a WhatsApp, donde vive NETO."

**P14 — El ahorro de S/54.11 es engañoso como KPI de primer nivel.**
Con ingresos de S/5,068 y gastos de S/5,014, el ahorro es de S/54 (1% de los ingresos). Mostrar esto como un KPI verde puede dar una falsa sensación de que la situación está bajo control. Para un producto de salud financiera, este número debería estar acompañado de contexto ("Tu tasa de ahorro es del 1%. La recomendada es 20%+").

### Recomendaciones

**Quick win:** Agregar estado vacío con checklist de 3 pasos cuando el usuario no tiene datos:
1. "Conecta tu Gmail para importar tus movimientos"
2. "Revisa tus primeras transacciones"
3. "Ve tu Score financiero"

**Quick win:** Agregar tooltip en el KPI "Score" del dashboard: "Tu salud financiera de 0 a 100. Haz clic para ver el desglose."

**Mediano plazo:** Diseñar un modal de bienvenida (una sola vez) que explique en 3 slides qué puede hacer NETO.

**Mediano plazo:** Cambiar el copy del botón WhatsApp en sidebar a "Enviar mensaje a NETO en WhatsApp" para ser explícito sobre el destino.

---

## SECCIÓN 4: RETENCIÓN Y ACTIVACIÓN (DASHBOARD)

### Score: 64/100

### Fortalezas

- El dashboard consolida los KPIs más importantes en una sola pantalla sin scroll excesivo.
- El área chart "Ingresos vs Gastos" es la visualización correcta para el patrón de uso peruano (comparativa mensual).
- La detección de suscripciones (Claude Pro, Netflix, etc.) es un feature wow — el usuario descubre algo que no sabía que NETO podía hacer. Este momento de "aha" debería ser más prominente.
- El PDF descargable con toast notification es un buen detalle de polish.
- El selector de mes inline (no en topbar) reduce fricción para navegar entre meses.

### Problemas detectados

**P15 — Las suscripciones detectadas no tienen ningún CTA.**
Ver que gastas S/X en suscripciones es valioso, pero el producto no te dice qué hacer con eso. Un botón "Ver cuáles puedes cancelar" o "Optimizar suscripciones" aumentaría el engagement y la percepción de valor.

**P16 — La vista de transacciones no tiene "insights" automáticos.**
La tabla de transacciones es funcional pero puramente informativa. Un banner/card de insight encima de la tabla ("Este mes gastaste 40% más en delivery que el mes pasado") convertiría datos en acción, que es la propuesta de valor central de NETO.

**P17 — El reporte no tiene llamada a acción hacia el plan Pro.**
El PDF descargable y el score financiero son features Pro-adjacent. No hay ningún momento en el reporte donde se sugiera al usuario free actualizar a Pro para obtener más insights. El upsell está solo en la página de Configuración, donde el usuario raramente llega orgánicamente.

**P18 — Los métodos de pago no están consolidados.**
"BCP Crédito" y "Crédito" pueden referirse al mismo instrumento. En el donut de métodos de pago del reporte, un usuario podría ver fragmentación artificial de sus propios gastos. Esto reduce la confianza en los datos.

**P19 — No hay notificaciones in-app.**
Toda la notificación ocurre por WhatsApp. Si el usuario está en la webapp, no hay ningún indicador de actividad reciente (nuevas transacciones importadas, alertas de presupuesto, etc.). Un badge en el sidebar o un feed de actividad aumentaría los retornos voluntarios a la app.

### Recomendaciones

- Agregar CTA en la sección de suscripciones: "¿Quieres reducir tus suscripciones? NETO te ayuda a decidir cuáles."
- Implementar consejo IA (ya pendiente en el backlog) como card fija en el dashboard, arriba de transacciones recientes
- Agregar un chip de upsell contextual en el reporte: "Activa Pro para recibir este reporte automáticamente cada mes por WhatsApp"
- Consolidar métodos de pago (ya identificado como pendiente)

---

## SECCIÓN 5: COPY Y PERSUASIÓN

### Score: 76/100

### Análisis del copy por sección

**Hero (8.5/10)**
- "Ordena tu plata" — jerga auténtica, no forzada
- "sin mover un dedo" — beneficio claro, lazy-proof
- Subtexto elimina objeciones en el orden correcto
- Oportunidad: falta urgencia o escasez (no hay razón para registrarse HOY vs mañana)

**Cómo funciona (6/10)**
- Los tres pasos son claros pero demasiado cortos
- Falta el "qué pasa después" (loop de valor: correo llega → NETO lo lee → te manda resumen)
- Ningún paso menciona tiempo ni esfuerzo del usuario

**Testimonios (5.5/10)**
- "Historias reales. Resultados reales." es un buen header
- Solo 2 testimonios es insuficiente para superar escepticismo (recomendado: mínimo 4–6)
- Los testimonios muestran una métrica "+32%" pero no queda claro qué métrica es (+32% de ahorro? +32% de claridad financiera?)
- No hay foto de perfil real ni empleador visible — reduce credibilidad percibida
- Falta un testimonio de alguien que "no era bueno con las finanzas" para que el usuario promedio se identifique

**Precios (7.5/10)**
- La comparación Free vs Pro es clara y honesta
- S/10/mes es un precio psicológicamente bajo para el target (profesional joven Lima)
- S/99/año equivale a S/8.25/mes — el ahorro no está calculado ni destacado ("Ahorra S/21 al año" o "2 meses gratis")
- Falta social proof en precios ("147 usuarios ya son Pro")

**CTA final (9/10)**
- "¿A dónde se fue tu plata este mes?" — pregunta que duele, crea urgencia emocional
- El botón amber/amarillo rompe el patrón visual correctamente
- "Gratis · Sin tarjeta · Sin contraseña bancaria" es el mejor copy de toda la página

### Puntuación de Copy Global: 76/100

### Recomendaciones de copy

| Sección | Copy actual | Copy sugerido |
|---|---|---|
| Hero subheadline | "Sin contraseñas bancarias" al final | Mover al inicio: "Sin contraseñas bancarias. Sin apps..." |
| Paso 1 | "Conectas tu Gmail" | "Conectas tu Gmail (solo lectura, 2 min)" |
| Testimonios métrica | "+32%" | "+32% de ahorro mensual en 3 meses" |
| Precio anual | "S/99/año" | "S/99/año — 2 meses gratis" |
| Score dashboard | "56" sin contexto | "56/100 — Haz clic para mejorar tu score" |
| Suscripciones | Lista sin CTA | "Estás gastando S/X/mes en suscripciones. ¿Optimizamos?" |

---

## SECCIÓN 6: MOBILE UX

### Score: 67/100

### Contexto
El target primario (profesionales jóvenes peruanos, 22–35 años) navega predominantly en mobile. El 70%+ del tráfico en Perú para productos de este tipo llega desde smartphone.

### Fortalezas

- La webapp tiene bottom nav en mobile (correcto para este segmento)
- El diseño dark theme es congruente entre landing y webapp (sin shock visual al hacer login)
- El glassmorphism con `glass-card-glow` se ve bien en pantallas Retina modernas

### Problemas detectados

**P20 — La landing no tiene CTA sticky en mobile.**
En desktop el CTA del hero está siempre visible mientras se hace scroll por el nav. En mobile, después de scrollear 2–3 secciones, no hay forma de convertir sin volver arriba. Un botón flotante "Empezar gratis" o una barra inferior sticky aumentaría conversiones mobile significativamente.

**P21 — El glassmorphism puede tener mal rendimiento en mobile mid-range.**
`backdrop-filter: blur()` tiene un costo de render elevado en dispositivos de gama media (Redmi, Samsung A-series). Si el scroll se siente lento en un Redmi Note, el usuario va a abandonar. Necesita prueba en hardware real de gama media.

**P22 — La tabla de transacciones es problemática en mobile.**
Una tabla con columnas (fecha, descripción, categoría, monto, método, acciones) en mobile requiere scroll horizontal o columns colapsadas. Sin ver el código, es un riesgo alto. Las tablas de transacciones deberían convertirse en cards swipeables en mobile.

**P23 — El donut chart del reporte puede ser ilegible en pantallas pequeñas.**
Los donuts con muchas categorías (8+) tienen leyendas que no entran en mobile. Necesita layout adaptativo o simplificación a top-5 categorías en mobile.

**P24 — El formulario de login en mobile no tiene autofill optimizado.**
Si en el futuro se agrega login por email/password, los campos deben tener atributos correctos (`autocomplete="email"`, `autocomplete="current-password"`). El OAuth de Google en mobile debe abrir en el mismo tab (no popup) para evitar bloqueos en Safari iOS.

### Recomendaciones

- Agregar `position: fixed; bottom: 0` CTA en la landing para mobile (aparece después de 30% de scroll)
- Auditar rendimiento de glassmorphism en Redmi Note 12 o equivalente
- Convertir tabla de transacciones en cards swipeables para viewports < 768px
- Simplificar donuts a top-5 + "Otros" en mobile
- Verificar flujo Google OAuth en Safari iOS (common issue con popups)

---

## SECCIÓN 7: CONFIANZA Y CREDIBILIDAD

### Score: 60/100

### Contexto
El mercado peruano tiene alta desconfianza hacia fintech y apps que "tocan" datos bancarios. La landing lo sabe (elimina la objeción "sin contraseñas bancarias") pero no hace suficiente trabajo de construcción de confianza activa.

### Fortalezas

- La eliminación proactiva de objeciones en el subheadline es el mejor elemento de confianza
- El footer tiene links a Privacidad y Términos (baseline legal visible)
- El número de WhatsApp de producción (+51 933 014 505) da sensación de entidad real y accesible
- Email de contacto hola@neto.pe con dominio propio (no gmail)

### Problemas detectados

**P25 — Solo 2 testimonios, sin verificación visible.**
Dos testimonios de texto con nombres y títulos pero sin foto real, empresa, o enlace verificable. Para un producto financiero, esto genera desconfianza. Los mejores SaaS peruanos de este segmento muestran capturas reales de WhatsApp, fotos de perfil de LinkedIn, o nombres completos verificables.

**P26 — No hay indicadores de seguridad técnica visibles.**
El usuario no sabe que los datos se guardan en Supabase con RLS activo, que el hash de transacciones evita duplicados, ni que NETO no almacena contraseñas bancarias porque literalmente no puede. Un badge "256-bit encryption" o "Datos protegidos · Solo lectura" con un tooltip técnico aumentaría la confianza percibida.

**P27 — No hay número de usuarios ni métrica de tracción.**
"147 usuarios activos" o "Más de 500 transacciones analizadas esta semana" sería social proof poderoso. Si los números reales son pequeños, usar métricas alternativas: "Primeros 200 usuarios en lista de espera" o "Usado por profesionales de BCP, BBVA, Interbank".

**P28 — La política de privacidad no está resumida en lenguaje humano.**
Los usuarios peruanos jóvenes no leen políticas de privacidad. Un accordion de 3 puntos clave ("Qué datos guardamos", "Qué hacemos con ellos", "Cómo los proteges") encima del link formal aumentaría la confianza sin reemplazar el documento legal.

**P29 — El badge de seguridad en la página de login es débil.**
La página de login (app.neto.pe) es el momento de mayor desconfianza. El usuario está a punto de dar acceso a su cuenta Google. No hay ningún mensaje de seguridad visible en esa pantalla. Agregar: "Solo leemos correos de tu banco. Nunca enviamos correos ni accedemos a tus contactos."

**P30 — No hay sello de prensa ni menciones externas.**
Sin un "Como aparecimos en..." (aunque sea un blog, podcast de finanzas personal peruano, o mención en redes), la marca no tiene validación externa. Para un producto nuevo esto es comprensible, pero es una brecha de credibilidad importante.

### Recomendaciones

- Agregar 4–6 testimonios con fotos reales (o screenshots de WhatsApp con datos anonimizados)
- Incluir un badge de seguridad técnica en el hero y en la página de login
- Mostrar una métrica de tracción honesta ("Analizando +1,200 correos bancarios por semana")
- Crear un "¿Es seguro?" accordion en la landing, antes del CTA final
- En la página de login: agregar 1 línea de seguridad debajo del botón de Google

---

## AUDITORIA DE FORMULARIOS

### Formulario de Login (app.neto.pe/login)

| Criterio | Estado | Observación |
|---|---|---|
| Número de campos | Excelente | 0 campos (solo OAuth) — fricción mínima |
| Alternativa no-Google | Deficiente | Link de texto pequeño, difícil de encontrar |
| Mensajes de error | Desconocido | No hay indicación de qué pasa si el OAuth falla |
| Seguridad visible | Deficiente | Sin badge de seguridad ni copy de tranquilización |
| Accesibilidad | Desconocido | Verificar contraste del botón de Google sobre fondo dark |
| Post-login redirect | Desconocido | ¿A dónde va si ya tiene cuenta? ¿Al dashboard correcto? |

### Formulario de Nueva Transacción (webapp/transacciones)

| Criterio | Estado | Observación |
|---|---|---|
| Validación en tiempo real | Desconocido | Verificar que monto no acepta negativos in-line |
| Campos obligatorios | Aceptable | Monto, categoría, fecha deberían ser obligatorios |
| Autocompletado de comercios | Desconocido | Si existe fuzzy match de comercios, debería sugerirse en el form |
| Confirmación post-envío | Implementado | Toast notification presente |
| Cancelar/escape | Desconocido | Verificar que el modal cierra con Escape y clic fuera |

### Formulario de Nuevo Presupuesto

| Criterio | Estado | Observación |
|---|---|---|
| Preview del presupuesto | Ausente | Ver el monto ingresado reflejado inmediatamente en la barra de progreso aumentaría engagement |
| Validación de solapamiento | Desconocido | ¿Puede el usuario crear dos presupuestos para la misma categoría? |

---

## AUDITORIA MOBILE

### Checklist Mobile (basado en observaciones)

| Elemento | Puntuación | Acción requerida |
|---|---|---|
| CTA sticky en landing | 2/5 | Agregar barra sticky o botón flotante |
| Bottom nav en webapp | 5/5 | Correctamente implementado |
| Tabla transacciones en mobile | 2/5 | Convertir a cards swipeables |
| Donuts en mobile | 3/5 | Simplificar a top-5 en viewports pequeños |
| Glassmorphism en gama media | Desconocido | Auditar en hardware real |
| Google OAuth en Safari iOS | Desconocido | Verificar flujo (popups bloqueados en Safari) |
| Font size legible | 4/5 | Dark theme con bajo contraste en texto muted (#8A877D) — revisar en outdoor |
| Touch targets >= 44px | Desconocido | Verificar botones de acciones en tabla de transacciones |
| Scroll performance | Desconocido | Medir con Lighthouse en mobile |

---

## RECOMENDACIONES A/B TEST

### Test 1 — Headline del hero (ALTA PRIORIDAD)
**Control:** "Ordena tu plata sin mover un dedo"
**Variante A:** "Sabe exactamente en qué gastas, sin esfuerzo"
**Variante B:** "Tu resumen financiero llega a WhatsApp solo"
**Métrica:** CTR al botón "Empezar gratis"
**Duración estimada:** 2 semanas con 500+ visitantes

### Test 2 — Posición de seguridad en subheadline (ALTA PRIORIDAD)
**Control:** "Neto lee tus correos... Sin contraseñas bancarias"
**Variante:** "Sin contraseñas bancarias. Sin apps. Neto lee tus correos..."
**Métrica:** Scroll depth + CTR al CTA principal
**Duración estimada:** 2 semanas

### Test 3 — CTA sticky en mobile (ALTA PRIORIDAD)
**Control:** Sin CTA sticky
**Variante:** Barra inferior sticky "Empezar gratis — es gratis" que aparece después del 30% de scroll
**Métrica:** Conversión landing → registro en mobile
**Duración estimada:** 3 semanas

### Test 4 — Score en mock dashboard (MEDIA PRIORIDAD)
**Control:** Score 72/100
**Variante:** Score 84/100 con flecha ascendente y "+12 esta semana"
**Métrica:** Tiempo en página + CTR al CTA
**Duración estimada:** 2 semanas

### Test 5 — Modal de bienvenida en webapp (MEDIA PRIORIDAD)
**Control:** Dashboard directo sin onboarding
**Variante:** Modal de 3 slides "Bienvenido a NETO" → "Conecta tu Gmail" → "Esto es lo que verás"
**Métrica:** Tasa de conexión de Gmail en primeras 24h
**Duración estimada:** 4 semanas

### Test 6 — Copy del precio anual (BAJA PRIORIDAD)
**Control:** "S/99/año"
**Variante:** "S/99/año — 2 meses gratis"
**Métrica:** Conversión Free → Pro (anual)
**Duración estimada:** 4 semanas

---

## LISTA DE FIXES PRIORITIZADOS

### URGENTE — Impacto alto, esfuerzo bajo (esta semana)

| # | Fix | Sección | Esfuerzo | Impacto esperado |
|---|---|---|---|---|
| F1 | Agregar tooltip al KPI "Score" en dashboard | Webapp | 1h | Reduce abandono de nuevos usuarios |
| F2 | Agregar badge de seguridad en página de login | Webapp | 2h | +Confianza en momento crítico |
| F3 | Mover "Sin contraseñas bancarias" al inicio del subheadline | Landing | 15min | Elimina objeción #1 más temprano |
| F4 | Hacer el link de WhatsApp en login un botón outline visible | Webapp | 30min | Reduce dead ends para no-Google |
| F5 | Agregar "2 meses gratis" al precio anual S/99 | Landing | 15min | Aumenta conversión a plan anual |

### IMPORTANTE — Impacto alto, esfuerzo medio (próximas 2 semanas)

| # | Fix | Sección | Esfuerzo | Impacto esperado |
|---|---|---|---|---|
| F6 | Diseñar empty state con checklist para usuarios sin datos | Webapp | 1 día | Elimina mayor punto de abandono post-registro |
| F7 | Agregar CTA sticky/flotante en mobile para landing | Landing | 4h | +25–35% conversión en mobile |
| F8 | Agregar micro-copy de seguridad en paso 1 del "Cómo funciona" | Landing | 1h | Reduce fricción en el paso de conectar Gmail |
| F9 | Implementar consejo IA como card en dashboard (ya en backlog) | Webapp | 2 días | Aumenta percepción de valor e interacción diaria |
| F10 | Consolidar métodos de pago (ya identificado en pendientes) | Webapp | 4h | Aumenta confianza en datos |

### PLANIFICAR — Impacto medio/alto, esfuerzo alto (próximo sprint)

| # | Fix | Sección | Esfuerzo | Impacto esperado |
|---|---|---|---|---|
| F11 | Agregar 4 testimonios adicionales con fotos reales o screenshots WhatsApp | Landing | 3 días | +Credibilidad, +conversión |
| F12 | Diseñar modal de bienvenida (3 slides) para primer login | Webapp | 2 días | +Activación, +conexión Gmail en D1 |
| F13 | Agregar insights automáticos sobre transacciones (banner sobre tabla) | Webapp | 3 días | +Retención, demuestra valor de IA |
| F14 | Agregar upsell contextual en reporte para usuarios free | Webapp | 1 día | +Conversión Free → Pro |
| F15 | Convertir tabla de transacciones en cards en mobile | Webapp | 2 días | +UX mobile, reduce abandono |
| F16 | Agregar "¿Es seguro?" accordion en landing antes del CTA final | Landing | 1 día | +Confianza, reduce objeción final |
| F17 | Agregar CTA en sección de suscripciones detectadas | Webapp | 4h | +Engagement, demuestra valor Pro |

---

## MÉTRICAS A TRACKEAR

Para medir el impacto de estos cambios, instrumentar los siguientes eventos en GA4:

```
landing_cta_hero_click          — Clic en "Empezar gratis" del hero
landing_cta_pricing_click       — Clic en "Ver precios" del hero
landing_cta_final_click         — Clic en el CTA amber final
login_google_click              — Clic en "Continuar con Google"
login_whatsapp_fallback_click   — Clic en el link de WhatsApp de login
onboarding_gmail_connected      — Usuario conectó Gmail (evento de activación)
dashboard_score_tooltip_view    — Usuario vio tooltip del score
report_pdf_download             — Usuario descargó PDF
upgrade_pro_click               — Usuario hizo clic en "Actualizar a Pro"
subscription_cta_click          — Usuario hizo clic en CTA de suscripciones
```

**North Star Metric:** Tasa de usuarios activos en D7 (usuarios que abrieron la webapp o recibieron resumen WhatsApp en los primeros 7 días después del registro).

**Funnel objetivo post-fixes:**
- Visitante → Registro: 6–9% (desde ~2–4% estimado)
- Registro → Gmail conectado: 60% (actualmente desconocido)
- Gmail conectado → D7 activo: 50%
- D7 activo → Pro (90 días): 8–12%

---

*Análisis generado el 2026-03-24 | NETO — app.neto.pe*
