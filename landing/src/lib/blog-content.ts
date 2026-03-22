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
};
