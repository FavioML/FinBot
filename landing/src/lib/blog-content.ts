/**
 * Blog article HTML content, keyed by slug.
 * Keeping content in a TS file keeps the static export simple
 * and avoids MDX/remark dependencies.
 */

export const articleContent: Record<string, string> = {
  "gastos-hormiga-peru": `
<h2>Qué son los gastos hormiga</h2>
<p>
  Los gastos hormiga son esos gastos pequeños, casi invisibles, que haces todos los
  días sin pensarlo mucho. Un café de S/8 aquí, un taxi de S/12 allá, el delivery
  del almuerzo, la Coca-Cola de la tarde. Cada uno parece insignificante. Pero
  cuando los sumas al final del mes, el resultado duele.
</p>
<p>
  Se llaman "hormiga" justamente por eso: son pequeños, pasan desapercibidos y
  trabajan en silencio. Pero juntos, <strong>pueden comerse entre S/200 y S/500
  de tu sueldo cada mes</strong> sin que te des cuenta.
</p>

<h2>Cuánto dinero pierdes realmente</h2>
<p>Hagamos cuentas con un ejemplo típico de un limeño:</p>
<ul>
  <li><strong>Café diario:</strong> S/8 × 22 días = S/176 al mes</li>
  <li><strong>Delivery (2x por semana):</strong> S/25 × 8 = S/200 al mes</li>
  <li><strong>Taxi/Uber "porque estoy cansado":</strong> S/15 × 10 = S/150 al mes</li>
  <li><strong>Antojos y snacks:</strong> S/5 × 20 = S/100 al mes</li>
</ul>
<p>
  <strong>Total: S/626 al mes. S/7,512 al año.</strong>
</p>
<p>
  Eso es más que un sueldo mínimo completo. Y la mayoría de personas en Perú
  no tiene idea de que está gastando tanto en estas cosas. ¿Por qué? Porque
  nadie las está contando.
</p>

<h2>Por qué son tan difíciles de detectar</h2>
<p>
  Los gastos hormiga tienen tres superpoderes que los hacen invisibles:
</p>
<ol>
  <li><strong>Son pequeños:</strong> S/8 no parece nada. Tu cerebro los descarta como irrelevantes.</li>
  <li><strong>Son frecuentes:</strong> Como los haces todos los días, se vuelven rutina. Dejan de ser "decisiones" y se convierten en hábitos automáticos.</li>
  <li><strong>No los registras:</strong> ¿Quién anota el café de la mañana en un Excel? Nadie. Por eso pasan por debajo del radar.</li>
</ol>
<p>
  El problema no es que sean "malos" — todo el mundo merece un café. El problema
  es que <strong>no sabes cuánto suman</strong>. Y si no lo sabes, no puedes decidir
  conscientemente si vale la pena.
</p>

<h2>Los 5 gastos hormiga más comunes en Perú</h2>
<p>Basados en patrones reales de usuarios peruanos:</p>
<ol>
  <li><strong>Delivery (Rappi, PedidosYa):</strong> El más silencioso. Un almuerzo de S/25 con delivery fee no parece mucho, pero 8 veces al mes son S/200.</li>
  <li><strong>Café de cadena:</strong> Starbucks, Juan Valdez. Si tu café cuesta más de S/10, estás pagando una membresía de gym solo en café.</li>
  <li><strong>Taxi/Uber corto:</strong> Trayectos de S/8-15 que podrías hacer en combi o caminando. Se acumulan rápido.</li>
  <li><strong>Suscripciones olvidadas:</strong> Netflix + Spotify + Disney+ + HBO + YouTube Premium. ¿Realmente usas todas? Probablemente no.</li>
  <li><strong>Antojos de tienda:</strong> La galleta, la gaseosa, el chocolate. S/3-5 cada vez, varias veces por semana.</li>
</ol>

<h2>Cómo controlar tus gastos hormiga</h2>
<h3>Paso 1: Hacerlos visibles</h3>
<p>
  El primer paso — y el más importante — es <strong>ver</strong> a dónde se va tu plata.
  No puedes controlar lo que no mides. La mayoría de apps de finanzas te piden
  ingresar cada gasto manualmente. Eso funciona 3 días y luego lo abandonas.
</p>
<p>
  Una alternativa más realista: dejar que la tecnología haga el trabajo.
  <a href="/">Neto</a> lee automáticamente las notificaciones que tu banco ya te
  envía por correo (BCP, BBVA, Interbank, Scotiabank, Yape, Plin) y te muestra
  exactamente en qué estás gastando. Sin ingresar nada manualmente.
</p>

<h3>Paso 2: Identificar patrones</h3>
<p>
  Una vez que ves tus gastos organizados por categoría, los patrones saltan a la
  vista: "Gasto S/300 al mes en delivery" o "Mi café me cuesta S/200 mensuales".
  Con esa información, puedes tomar decisiones conscientes.
</p>

<h3>Paso 3: Decidir, no eliminar</h3>
<p>
  No se trata de dejar el café para siempre. Se trata de <strong>decidir con
  información</strong>. Tal vez el café diario vale la pena para ti, pero el delivery
  3 veces por semana no. O viceversa. El punto es que sea tu decisión, no un
  accidente.
</p>

<h3>Paso 4: Poner un presupuesto</h3>
<p>
  Define un tope mensual para tus categorías de gastos hormiga. Por ejemplo:
  "Máximo S/150 en delivery este mes". Cuando te acercas al límite, ajustas.
  Simple.
</p>

<h2>La matemática del ahorro</h2>
<p>
  Si reduces tus gastos hormiga en solo <strong>S/200 al mes</strong>:
</p>
<ul>
  <li>En 6 meses: S/1,200 (un fondo de emergencia básico)</li>
  <li>En 1 año: S/2,400 (unas vacaciones)</li>
  <li>En 3 años: S/7,200 (la inicial de algo importante)</li>
</ul>
<p>
  Y lo mejor: no cambiaste tu estilo de vida. Solo dejaste de gastar en cosas
  que no te importaban tanto.
</p>

<h2>Empieza hoy</h2>
<p>
  El primer paso es saber a dónde se va tu plata. <a href="/">Neto</a> lo hace
  automáticamente por WhatsApp: lee tus correos del banco, categoriza con IA
  y te manda un resumen. Sin apps. Sin contraseñas bancarias. Gratis para empezar.
</p>
<p>
  <a href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B">Escríbele a Neto por WhatsApp</a>
  y empieza a ver a dónde se va tu plata.
</p>
`,

  "como-controlar-gastos-personales-peru": `
<h2>Por qué es tan difícil controlar los gastos en Perú</h2>
<p>
  La mayoría de peruanos no tiene un sistema para controlar sus gastos. No porque
  no quieran, sino porque las herramientas disponibles no se adaptan a cómo
  realmente manejamos la plata aquí.
</p>
<p>
  Usamos Yape para el almuerzo, tarjeta para el supermercado, efectivo para el taxi,
  Plin para la comida del fin de semana. <strong>Todo está fragmentado en 3-5 medios
  de pago diferentes</strong>. Ninguna app te muestra todo junto.
</p>
<p>
  Resultado: llegas a fin de mes sin saber exactamente en qué se fue tu sueldo.
  Suena familiar, ¿verdad?
</p>

<h2>Método 1: La regla 50/30/20 adaptada a Perú</h2>
<p>
  Este método divide tu sueldo en tres categorías:
</p>
<ul>
  <li><strong>50% — Necesidades:</strong> alquiler, servicios (luz, agua, internet), comida del día, transporte al trabajo.</li>
  <li><strong>30% — Gustos:</strong> salidas, delivery, ropa, suscripciones, entretenimiento.</li>
  <li><strong>20% — Ahorro y deudas:</strong> fondo de emergencia, cuotas de préstamos, ahorro para metas.</li>
</ul>
<p>
  <strong>Ejemplo con un sueldo de S/3,000:</strong>
</p>
<ul>
  <li>Necesidades: S/1,500 (alquiler S/800 + comida S/400 + servicios S/200 + transporte S/100)</li>
  <li>Gustos: S/900 (salidas, delivery, ropa, Netflix)</li>
  <li>Ahorro: S/600 (fondo de emergencia + cuota de deuda)</li>
</ul>
<p>
  El primer paso para saber si cumples esta regla es <strong>ver cuánto gastas
  realmente en cada categoría</strong>. Sin esa información, estás adivinando.
</p>

<h2>Método 2: Control por categoría (el más efectivo)</h2>
<p>
  En vez de rastrear cada sol, agrupa tus gastos en categorías y pon un tope
  mensual a cada una:
</p>
<ul>
  <li><strong>Comida y delivery:</strong> S/___</li>
  <li><strong>Transporte:</strong> S/___</li>
  <li><strong>Entretenimiento:</strong> S/___</li>
  <li><strong>Suscripciones:</strong> S/___</li>
  <li><strong>Compras varias:</strong> S/___</li>
</ul>
<p>
  Cuando te acercas al tope de una categoría, ajustas. Simple. Pero para que
  funcione, necesitas que alguien <strong>categorice tus gastos automáticamente</strong>.
  Ahí es donde la tecnología ayuda.
</p>

<h2>Método 3: El "no gasto" (eliminación quirúrgica)</h2>
<p>
  Revisa tu estado de cuenta del último mes. Identifica 3 gastos recurrentes
  que realmente no necesitas. Elimínalos. Solo 3.
</p>
<p>
  Ejemplos comunes en Perú:
</p>
<ol>
  <li><strong>Suscripción que no usas:</strong> ¿Realmente ves HBO y Disney+ además de Netflix? Elige una.</li>
  <li><strong>Delivery innecesario:</strong> ¿2 deliverys por semana podrían ser 1? Eso son S/100/mes.</li>
  <li><strong>Café premium diario:</strong> ¿Puedes llevar tu café de casa 3 de 5 días? S/120/mes ahorrados.</li>
</ol>

<h2>Por qué las apps de finanzas no funcionan (y qué sí funciona)</h2>
<p>
  Las apps tradicionales fallan por una razón: <strong>te piden ingresar cada gasto
  a mano</strong>. Funciona 3 días, máximo una semana, y después abandonas. Es
  naturaleza humana.
</p>
<p>
  Lo que sí funciona es un sistema que <strong>trabaje solo</strong>. Que lea tus
  gastos automáticamente y te muestre el resumen sin que hagas nada.
</p>
<p>
  <a href="/">Neto</a> hace exactamente eso: lee las notificaciones que tu banco
  ya te envía por correo (BCP, BBVA, Interbank, Scotiabank, Yape, Plin),
  categoriza todo con IA, y te manda un resumen por WhatsApp.
</p>

<h2>Plan de acción: empieza hoy</h2>
<ol>
  <li><strong>Hoy:</strong> Conecta <a href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B">Neto</a> (2 minutos, gratis)</li>
  <li><strong>Esta semana:</strong> Revisa tu primer resumen de gastos por categoría</li>
  <li><strong>Este mes:</strong> Identifica tus 3 gastos a eliminar y pon topes por categoría</li>
  <li><strong>Mes 2:</strong> Compara cuánto gastaste vs el mes anterior</li>
</ol>
<p>
  El control financiero no es privarse de todo. Es <strong>saber a dónde va tu plata
  para decidir conscientemente</strong> en qué vale la pena gastar.
</p>
`,

  "en-que-gasto-mi-plata": `
<h2>El problema: no sabes a dónde va tu sueldo</h2>
<p>
  Cobras el 15 o el 30. Pagas alquiler, servicios, alguna deuda. Y de repente
  es día 20 y ya no tienes plata. ¿En qué se fue? No tienes idea.
</p>
<p>
  No eres el único. La mayoría de peruanos no puede responder con exactitud
  "¿en qué gasté mi plata este mes?". Y no es por falta de interés — es porque
  <strong>no existe una forma fácil de saberlo</strong>.
</p>

<h2>Por qué es tan difícil rastrear tus gastos</h2>
<ul>
  <li><strong>Múltiples medios de pago:</strong> Yape, tarjeta de débito, tarjeta de crédito, Plin, efectivo. Tu plata está fragmentada.</li>
  <li><strong>Nadie anota cada gasto:</strong> Las apps que te piden ingresar cada compra manualmente se abandonan en 3 días.</li>
  <li><strong>Los bancos no te ayudan:</strong> Tu estado de cuenta muestra transacciones, no categorías. "POS WONG 12345" no te dice nada útil.</li>
</ul>

<h2>La solución: que la tecnología lo haga por ti</h2>
<p>
  Tu banco ya te envía un correo cada vez que haces una transacción. Yape y
  Plin hacen lo mismo. El problema no es la falta de datos — es que
  <strong>nadie los está organizando por ti</strong>.
</p>
<p>
  <a href="/">Neto</a> lee esos correos automáticamente, los categoriza con IA
  (comida, transporte, entretenimiento, servicios...) y te manda un resumen
  organizado por WhatsApp. Sin descargar apps, sin anotar nada.
</p>

<h2>Cómo funciona en 3 pasos</h2>
<ol>
  <li><strong>Escríbele a Neto por WhatsApp</strong> — un mensaje de "Hola" al +51 933 014 505.</li>
  <li><strong>Conecta tu Gmail con un clic</strong> — Neto solo lee los correos de notificaciones bancarias, nunca tus correos personales.</li>
  <li><strong>Recibe tu resumen</strong> — Neto te manda por WhatsApp tus gastos organizados por categoría, con montos y porcentajes.</li>
</ol>

<h2>¿Qué ves exactamente?</h2>
<p>Un resumen típico de Neto se ve así:</p>
<blockquote>
  "Esta semana gastaste S/847. Tu top 3: Comida S/380 (45%), Transporte S/220 (26%),
  Entretenimiento S/150 (18%). Te quedan S/403 de tu presupuesto. Tip: Comida subió
  20% vs la semana pasada."
</blockquote>
<p>
  Con esa información puedes tomar decisiones reales. No adivinanzas, no
  estimaciones — <strong>datos exactos de tu propia plata</strong>.
</p>

<h2>¿Es seguro?</h2>
<p>
  Neto <strong>nunca accede a tu banca en línea</strong>. No te pide usuario ni
  contraseña bancaria. Solo lee los correos de notificación que tu banco ya
  te envía — los mismos que llegarían aunque no usaras Neto.
</p>
<p>
  Puedes desconectar el acceso en cualquier momento desde tu Gmail.
</p>

<h2>Empieza ahora (gratis, 2 minutos)</h2>
<p>
  <a href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B">Escríbele a Neto por WhatsApp</a>
  y en 2 minutos vas a saber exactamente a dónde se va tu plata.
</p>
`,

  "bancos-peru-rastrear-sin-contrasena": `
<h2>¿Cómo puedes rastrear tu banco sin dar tu contraseña?</h2>
<p>
  La pregunta más común que recibimos es: "¿Cómo leen mi banco sin mi
  contraseña?". La respuesta es simple: <strong>no leemos tu banco. Leemos tu
  correo.</strong>
</p>
<p>
  Cada vez que haces una compra con tarjeta, recibes un correo de tu banco.
  Cada vez que recibes una transferencia por Yape, llega un correo. Cada vez
  que pagas un servicio, tu banco te notifica por email.
</p>
<p>
  Neto lee esas notificaciones automáticamente, extrae el monto, el comercio
  y la fecha, y las categoriza con IA. Eso es todo. <strong>Cero acceso a tu
  banca en línea, cero contraseñas bancarias.</strong>
</p>

<h2>Los 11 bancos y billeteras compatibles</h2>

<h3>Bancos principales</h3>
<ol>
  <li><strong>BCP (Banco de Crédito del Perú)</strong> — Cuenta de ahorros, cuenta corriente, tarjeta de crédito. Las notificaciones de compra, transferencias y pagos de servicios se leen automáticamente.</li>
  <li><strong>BBVA Perú</strong> — Cuenta y tarjetas. Detecta compras, retiros, transferencias y pagos recurrentes.</li>
  <li><strong>Interbank</strong> — Cuenta y tarjetas. Compatible con notificaciones de compra y transferencias.</li>
  <li><strong>Scotiabank Perú</strong> — Cuenta y tarjetas. Lee compras, transferencias y pagos de servicios.</li>
</ol>

<h3>Billeteras digitales</h3>
<ol start="5">
  <li><strong>Yape</strong> — La billetera más usada del Perú. Neto detecta cada Yapeo que recibes y cada pago que haces.</li>
  <li><strong>Plin</strong> — Transferencias entre bancos. Neto lee los correos de confirmación de Plin.</li>
</ol>

<h3>Otros bancos</h3>
<ol start="7">
  <li><strong>BanBif</strong> — Cuenta y tarjeta. Notificaciones de transacciones.</li>
  <li><strong>Banco Pichincha</strong> — Cuenta. Notificaciones de movimientos.</li>
  <li><strong>Banco Falabella</strong> — Tarjeta CMR. Compras y pagos de cuota.</li>
  <li><strong>Banco Ripley</strong> — Tarjeta Ripley. Compras y estados de cuenta.</li>
  <li><strong>MiBanco</strong> — Cuenta. Notificaciones de depósitos y retiros.</li>
</ol>

<h2>¿Tu banco no está en la lista?</h2>
<p>
  Escríbenos a <a href="mailto:hola@neto.pe">hola@neto.pe</a> con el nombre de
  tu banco y lo activamos. Solo necesitamos una muestra del correo de
  notificación que tu banco envía para configurar el parser.
</p>

<h2>¿Qué información NO puede ver Neto?</h2>
<ul>
  <li>Tu saldo bancario — no tenemos acceso</li>
  <li>Tu contraseña — nunca la pedimos</li>
  <li>Tus correos personales — solo leemos correos de remitentes bancarios</li>
  <li>Tu token de Yape/Plin — solo leemos las confirmaciones por email</li>
</ul>

<h2>¿Cómo se conecta?</h2>
<p>
  Conectas tu Gmail con un clic (OAuth de Google, el mismo sistema que usan
  apps como Notion o Slack). Neto recibe permiso de <strong>solo lectura</strong>
  sobre correos de remitentes bancarios específicos. Puedes revocar el acceso
  en cualquier momento desde tu configuración de Google.
</p>

<h2>Empieza gratis</h2>
<p>
  <a href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B">Conecta tu banco en 2 minutos por WhatsApp</a>.
  Sin contraseñas. Sin riesgo.
</p>
`,

  "asistente-financiero-whatsapp-peru": `
<h2>¿Qué es un asistente financiero por WhatsApp?</h2>
<p>
  Es exactamente lo que suena: un asistente que te ayuda con tu plata y vive
  en WhatsApp. Le escribes, te responde. Le preguntas cuánto gastaste, te
  dice. Le pides un resumen de la semana, te lo manda.
</p>
<p>
  No es una app que descargas. No es un Excel que llenas. No es un curso de
  finanzas. Es <strong>una conversación por WhatsApp que te ayuda a ordenar
  tu plata</strong>.
</p>

<h2>¿Por qué WhatsApp y no una app?</h2>
<p>
  En Perú, WhatsApp es la app más usada. Más que Facebook, más que Instagram,
  más que cualquier otra. <strong>95% de los peruanos con smartphone usan
  WhatsApp todos los días.</strong>
</p>
<p>
  Entonces, ¿por qué obligarte a descargar otra app? Neto va donde ya estás.
  Sin ocupar espacio en tu celular, sin recordar otra contraseña, sin aprender
  otra interfaz.
</p>

<h2>Cómo funciona Neto</h2>
<h3>1. Se conecta a tu correo (una sola vez)</h3>
<p>
  Conectas tu Gmail con un clic. Neto lee solo las notificaciones que tu banco
  ya te envía (BCP, BBVA, Interbank, Scotiabank, Yape, Plin y 5 bancos más).
  No accede a tu banca en línea ni te pide contraseñas bancarias.
</p>

<h3>2. Lee y categoriza automáticamente</h3>
<p>
  Cada vez que llega un correo de tu banco, Neto lo procesa con IA: extrae
  el monto, identifica el comercio y asigna una categoría (comida, transporte,
  entretenimiento, servicios, etc.). Tú no haces absolutamente nada.
</p>

<h3>3. Te manda resúmenes por WhatsApp</h3>
<p>
  Recibes resúmenes automáticos con tus gastos organizados. También puedes
  escribirle cuando quieras para preguntarle cosas como:
</p>
<ul>
  <li>"¿Cuánto gasté esta semana?"</li>
  <li>"¿En qué más gasté este mes?"</li>
  <li>"¿Cuánto llevo en delivery?"</li>
  <li>"Dame mi resumen del mes"</li>
</ul>

<h2>¿Qué puede hacer Neto?</h2>
<ul>
  <li><strong>Resumen semanal y mensual</strong> — Gastos totales, por categoría, con porcentajes y comparación vs períodos anteriores.</li>
  <li><strong>Alertas de presupuesto</strong> — Configura un tope mensual y Neto te avisa cuando te acercas.</li>
  <li><strong>Categorización automática</strong> — IA que aprende tus patrones y categoriza con más del 90% de precisión.</li>
  <li><strong>Score de salud financiera</strong> — Una puntuación de 0 a 100 que te dice qué tan bien vas.</li>
  <li><strong>Dashboard web</strong> — Además del WhatsApp, tienes un <a href="/mi-reporte">dashboard visual</a> con gráficos y detalles.</li>
</ul>

<h2>¿Cuánto cuesta?</h2>
<p>
  Empezar es gratis. El plan gratuito incluye resúmenes y categorización
  básica. El plan Pro (con presupuestos, alertas y score) se paga con
  <strong>Yape</strong> — sin tarjeta de crédito requerida.
</p>
<p>
  Consulta los <a href="/#precios">precios actualizados aquí</a>.
</p>

<h2>¿Es seguro?</h2>
<p>
  Neto nunca accede a tu banca en línea. Solo lee correos de notificación.
  Puedes revocar el acceso en cualquier momento. Tus datos están encriptados
  y nunca se comparten con terceros. <a href="/privacidad">Lee nuestra política
  de privacidad completa</a>.
</p>

<h2>Empieza en 2 minutos</h2>
<p>
  <a href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B">Escríbele "Hola" a Neto por WhatsApp</a>
  y conecta tu banco en 2 minutos. Gratis, sin contraseñas, sin apps.
</p>
`,
};
