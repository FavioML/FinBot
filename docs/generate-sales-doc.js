const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, Tab, TabStopType,
  TableBorders, convertInchesToTwip, PageNumber, NumberFormat,
  Header, Footer,
} = require('docx');
const fs = require('fs');

// Brand colors
const NETO_GREEN = '1D9E75';
const DARK_BG = '0E0E0C';
const ACCENT = '68dbae';
const AMBER = 'EF9F27';

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 400 : 200, after: 120 },
    children: [new TextRun({ text, bold: true, color: level === HeadingLevel.HEADING_1 ? NETO_GREEN : '333333', font: 'Calibri', size: level === HeadingLevel.HEADING_1 ? 32 : 26 })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 160, after: 80 },
    children: [new TextRun({ text, bold: true, color: '444444', font: 'Calibri', size: 22 })],
  });
}

function body(text) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text, font: 'Calibri', size: 20, color: '333333' })],
  });
}

function bullet(text, bold_prefix = '') {
  const children = [];
  if (bold_prefix) {
    children.push(new TextRun({ text: bold_prefix, bold: true, font: 'Calibri', size: 20, color: '333333' }));
  }
  children.push(new TextRun({ text, font: 'Calibri', size: 20, color: '555555' }));
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children,
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 200 }, children: [] });
}

function greenLine() {
  return new Paragraph({
    spacing: { before: 100, after: 100 },
    border: { bottom: { color: NETO_GREEN, space: 1, size: 6, style: BorderStyle.SINGLE } },
    children: [],
  });
}

function makeTable(headers, rows) {
  const headerCells = headers.map(h => new TableCell({
    shading: { type: ShadingType.SOLID, color: NETO_GREEN },
    width: { size: Math.floor(100 / headers.length), type: WidthType.PERCENTAGE },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', font: 'Calibri', size: 18 })] })],
  }));
  const dataRows = rows.map((row, i) => new TableRow({
    children: row.map(cell => new TableCell({
      shading: i % 2 === 0 ? { type: ShadingType.SOLID, color: 'F5F5F5' } : undefined,
      children: [new Paragraph({ children: [new TextRun({ text: String(cell), font: 'Calibri', size: 18, color: '333333' })] })],
    })),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: headerCells }), ...dataRows],
  });
}

// ─── BUILD DOCUMENT ───

const doc = new Document({
  creator: 'Neto - Asistente Financiero',
  title: 'NETO - Presentación de Ventas',
  description: 'Documento de ventas y bitácora de evolución de Neto',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20, color: '333333' } },
    },
  },
  sections: [
    // ═══════════════════════════════════════
    // COVER PAGE
    // ═══════════════════════════════════════
    {
      properties: { page: { margin: { top: convertInchesToTwip(1.5), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.2), right: convertInchesToTwip(1.2) } } },
      children: [
        new Paragraph({ spacing: { before: 2000 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: 'NETO', bold: true, color: NETO_GREEN, font: 'Calibri', size: 72 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [new TextRun({ text: 'Asistente Financiero Inteligente por WhatsApp', font: 'Calibri', size: 28, color: '555555' })],
        }),
        greenLine(),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 100 },
          children: [new TextRun({ text: '"Ordena tu plata sin mover un dedo"', italics: true, font: 'Calibri', size: 24, color: NETO_GREEN })],
        }),
        new Paragraph({ spacing: { before: 600 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Documento de Ventas y Evolución del Producto', font: 'Calibri', size: 22, color: '888888' })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100 },
          children: [new TextRun({ text: 'Marzo 2026', font: 'Calibri', size: 22, color: '888888' })],
        }),
        new Paragraph({ spacing: { before: 600 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'neto.pe', color: NETO_GREEN, font: 'Calibri', size: 20 }),
            new TextRun({ text: '  |  ', color: '999999', font: 'Calibri', size: 20 }),
            new TextRun({ text: 'app.neto.pe', color: NETO_GREEN, font: 'Calibri', size: 20 }),
            new TextRun({ text: '  |  ', color: '999999', font: 'Calibri', size: 20 }),
            new TextRun({ text: '+51 933 014 505', color: NETO_GREEN, font: 'Calibri', size: 20 }),
          ],
        }),
      ],
    },

    // ═══════════════════════════════════════
    // TABLE OF CONTENTS
    // ═══════════════════════════════════════
    {
      properties: { page: { margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.2), right: convertInchesToTwip(1.2) } } },
      children: [
        heading('Contenido'),
        greenLine(),
        body('1. El Problema'),
        body('2. La Solución: NETO'),
        body('3. Cómo Funciona'),
        body('4. Bancos Soportados'),
        body('5. Funcionalidades WhatsApp'),
        body('6. Dashboard Web (app.neto.pe)'),
        body('7. Inteligencia Artificial'),
        body('8. Score Financiero'),
        body('9. Modelo de Negocio'),
        body('10. Seguridad'),
        body('11. Stack Tecnológico'),
        body('12. Resultados'),
        body('13. Métricas Clave'),
        body('14. Roadmap'),
        body('15. Competencia'),
        body('16. La Oportunidad'),
        body('17. Bitácora de Evolución'),
      ],
    },

    // ═══════════════════════════════════════
    // MAIN CONTENT
    // ═══════════════════════════════════════
    {
      properties: {
        page: { margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.2), right: convertInchesToTwip(1.2) } },
      },
      children: [
        // 1. EL PROBLEMA
        heading('1. El Problema que Nadie Resuelve'),
        greenLine(),
        body('El mercado financiero personal en Perú tiene una brecha enorme entre las herramientas disponibles y las necesidades reales de las personas.'),
        spacer(),
        bullet('78% de peruanos no lleva un registro de gastos.', '78% — '),
        bullet('Las apps financieras requieren anotar manualmente cada gasto — el 90% las abandona en 30 días.', 'Fricción — '),
        bullet('Los bancos envían correos de notificación de gastos, pero nadie los organiza.', 'Oportunidad desperdiciada — '),
        bullet('No existe ninguna herramienta financiera pensada para WhatsApp.', 'Canal ignorado — '),
        spacer(),
        new Paragraph({
          spacing: { before: 100, after: 200 },
          shading: { type: ShadingType.SOLID, color: 'F0FFF8' },
          children: [
            new TextRun({ text: '💡 Insight clave: ', bold: true, font: 'Calibri', size: 20, color: NETO_GREEN }),
            new TextRun({ text: 'El peruano promedio revisa WhatsApp 85 veces al día, pero su app bancaria solo 3 veces al mes.', italics: true, font: 'Calibri', size: 20, color: '555555' }),
          ],
        }),

        // 2. LA SOLUCIÓN
        heading('2. La Solución: NETO'),
        greenLine(),
        body('NETO es el primer asistente financiero inteligente que vive donde ya estás: WhatsApp. Combina lectura automática de correos bancarios, inteligencia artificial y un dashboard web completo para darte control total de tus finanzas sin esfuerzo.'),
        spacer(),
        h3('Tres pilares fundamentales:'),
        bullet('Lee tus correos bancarios automáticamente de 11 bancos peruanos', '1. Lectura automática: '),
        bullet('Te resume todo por WhatsApp sin que hagas absolutamente nada', '2. Resúmenes inteligentes: '),
        bullet('Dashboard web completo con gráficos, metas, presupuestos y reportes PDF', '3. Dashboard completo: '),
        spacer(),
        new Paragraph({
          spacing: { after: 200 },
          children: [new TextRun({ text: 'Sin contraseñas bancarias. Sin anotar nada. Solo resultados.', bold: true, italics: true, font: 'Calibri', size: 22, color: NETO_GREEN })],
        }),

        // 3. CÓMO FUNCIONA
        heading('3. Cómo Funciona — Setup en 2 Minutos'),
        greenLine(),
        spacer(),
        bullet('Escríbele a Neto al +51 933 014 505. La conversación inicia el onboarding.', 'Paso 1: '),
        bullet('Conecta tu Gmail donde llegan las alertas del banco (BCP, BBVA, Interbank, etc.)', 'Paso 2: '),
        bullet('Neto lee, clasifica y organiza automáticamente todos tus gastos e ingresos.', 'Paso 3: '),
        bullet('Revisa tu dashboard completo en app.neto.pe con gráficos, metas y reportes.', 'Paso 4: '),
        spacer(),
        body('Todo el proceso toma menos de 2 minutos. No necesitas descargar ninguna app, crear ninguna cuenta manual, ni recordar ninguna contraseña.'),

        // 4. BANCOS
        heading('4. Bancos Soportados'),
        greenLine(),
        body('NETO lee automáticamente los correos de notificación de gastos e ingresos de los siguientes bancos:'),
        spacer(),
        makeTable(
          ['Banco', 'Tipo', 'Detección'],
          [
            ['BCP', 'Banco comercial', 'Gastos, ingresos, transferencias'],
            ['BBVA', 'Banco comercial', 'Gastos, ingresos, transferencias'],
            ['Interbank', 'Banco comercial', 'Gastos, ingresos, transferencias'],
            ['Scotiabank', 'Banco comercial', 'Gastos, ingresos'],
            ['Yape', 'Billetera digital', 'Pagos, cobros'],
            ['Plin', 'Billetera digital', 'Pagos, cobros'],
            ['Falabella', 'Banco retail', 'Gastos tarjeta'],
            ['Ripley', 'Banco retail', 'Gastos tarjeta'],
            ['BanBif', 'Banco comercial', 'Gastos, ingresos'],
            ['Mibanco', 'Microfinanzas', 'Gastos, ingresos'],
            ['CMAC', 'Caja municipal', 'Gastos, ingresos'],
          ]
        ),

        // 5. FUNCIONALIDADES WHATSAPP
        heading('5. Funcionalidades WhatsApp'),
        greenLine(),
        body('WhatsApp es el centro de control de Neto. Todas estas funcionalidades están disponibles directamente desde la conversación:'),
        spacer(),
        bullet('Detecta automáticamente gastos e ingresos desde correos bancarios.', '1. Registro automático: '),
        bullet('GPT-4o-mini con 25 intenciones NLP reconocidas. Entiende español peruano.', '2. Clasificación IA: '),
        bullet('Escribe "gasté 50 en almuerzo" y Neto lo registra al instante.', '3. Registro manual por texto: '),
        bullet('Envía una captura de pantalla de Yape o Plin y Neto extrae monto, comercio y fecha.', '4. Lectura de imágenes (Vision AI): '),
        bullet('Cada día a las 8pm recibe un resumen de tus gastos del día.', '5. Resumen diario automático: '),
        bullet('Comparativa con la semana anterior + insights de IA personalizados.', '6. Resumen semanal con IA: '),
        bullet('Reporte completo del mes anterior, enviado el 1ro de cada mes.', '7. Resumen mensual automático: '),
        bullet('Si superas el 80% de un presupuesto, Neto te avisa inmediatamente.', '8. Alertas de presupuesto: '),
        bullet('A las 8pm te recuerda registrar tus gastos (configurable con /silenciar).', '9. Recordatorios diarios: '),

        // 6. DASHBOARD WEB
        heading('6. Dashboard Web — app.neto.pe'),
        greenLine(),
        body('El dashboard web complementa la experiencia de WhatsApp con visualizaciones avanzadas, gestión detallada y exportación de datos.'),
        spacer(),
        h3('8 secciones completas:'),
        bullet('KPIs en tiempo real, donut de categorías, trend chart, score financiero, tipo de cambio USD/PEN, top comercios, métodos de pago.', 'Overview: '),
        bullet('CRUD completo, filtros por tipo/categoría/banco/método de pago, búsqueda por texto, paginación con números, vista mensual y anual.', 'Transacciones: '),
        bullet('Agrupados por categoría, sub-presupuestos, barras de progreso, alertas al 80%, sugerencias basadas en promedio histórico.', 'Presupuestos: '),
        bullet('Progreso visual con barra, deadlines, emoji de estado, CRUD completo.', 'Metas de ahorro: '),
        bullet('Detección automática de 50+ servicios digitales (Netflix, Spotify, etc.), vista anual.', 'Suscripciones: '),
        bullet('Score financiero clickeable con desglose, KPIs, gráficos, top merchants, gasto diario. PDF descargable.', 'Reportes PDF: '),
        bullet('Vista mensual interactiva con todos los gastos e ingresos del día.', 'Calendario financiero: '),
        bullet('Perfil, plan free/premium, referidos, cuentas conectadas, notificaciones, export CSV/JSON.', 'Configuración: '),
        spacer(),
        h3('Características UX destacadas:'),
        bullet('Tema oscuro OLED "Nocturnal Precision" con glassmorphism.'),
        bullet('Botón flotante Quick Add (gasto/ingreso rápido).'),
        bullet('Búsqueda global Ctrl+K (páginas + transacciones).'),
        bullet('Lazy loading con shimmer skeletons.'),
        bullet('PWA instalable (manifest.json + Apple Web App).'),
        bullet('Responsive: desktop, tablet y mobile optimizado.'),

        // 7. IA
        heading('7. Inteligencia Artificial'),
        greenLine(),
        bullet('GPT-4o-mini clasifica cada mensaje en 25 intenciones distintas. Entiende jerga peruana, montos en soles y dólares, y contexto conversacional.', 'Clasificación NLP: '),
        bullet('10 categorías raíz con subcategorías personalizables. El usuario puede crear las suyas desde el dashboard o WhatsApp.', 'Categorías custom: '),
        bullet('Recomendaciones financieras personalizadas basadas en patrones de gasto, generadas por GPT-4o-mini.', 'Consejos diarios: '),
        bullet('GPT-4o Vision lee capturas de Yape y Plin, extrayendo monto, comercio y fecha automáticamente.', 'Vision AI: '),
        bullet('Neto recuerda comercios frecuentes y aplica la categoría correcta automáticamente (fuzzy match).', 'Aprendizaje por comercio: '),

        // 8. SCORE
        heading('8. Score Financiero Inteligente'),
        greenLine(),
        body('Cada usuario tiene un score financiero calculado en tiempo real que le indica cómo están sus finanzas:'),
        spacer(),
        bullet('Todos inician con 75 puntos.', 'Base: 75 puntos — '),
        bullet('Hasta +15 puntos si ahorra más del 20% de sus ingresos.', 'Bonus ahorro: '),
        bullet('Hasta -25 puntos si supera presupuestos recurrentemente.', 'Penalidades: '),
        spacer(),
        body('El score se presenta con un gauge SVG clickeable que muestra el desglose detallado. Incluye tendencia de los últimos 4 meses y recomendaciones específicas para mejorar.'),

        // 9. MODELO DE NEGOCIO
        heading('9. Modelo de Negocio — Freemium'),
        greenLine(),
        spacer(),
        makeTable(
          ['Característica', 'Free (S/0)', 'Pro (S/10/mes)'],
          [
            ['Registro manual WhatsApp', '✅', '✅'],
            ['Dashboard mes actual', '✅', '✅ Historial completo'],
            ['Presupuestos', '3 máximo', '✅ Ilimitados'],
            ['Metas de ahorro', '1 máximo', '✅ Ilimitadas'],
            ['Imágenes Yape/Plin', '5/mes', '✅ Ilimitadas'],
            ['Resumen semanal', 'Básico', '✅ Con insights IA'],
            ['Lectura automática Gmail', '❌', '✅ 11 bancos'],
            ['Resúmenes diarios', '❌', '✅'],
            ['Consejos IA personalizados', '❌', '✅'],
            ['Reportes PDF', '❌', '✅'],
            ['Calendario financiero', '❌', '✅'],
            ['Heatmap de gastos', '❌', '✅'],
            ['Export CSV/JSON', '❌', '✅'],
          ]
        ),
        spacer(),
        body('Plan anual: S/99/año (equivale a 2 meses gratis). Precio fundador — cancela cuando quieras.'),
        body('Pago vía Yape directo. Sin intermediarios, sin comisiones de pasarela.'),

        // 10. SEGURIDAD
        heading('10. Seguridad de Nivel Empresarial'),
        greenLine(),
        bullet('Solo lee correos de notificación. Nunca accede a tu banca online ni solicita credenciales bancarias.', 'Sin contraseñas bancarias: '),
        bullet('Row Level Security en todas las tablas de Supabase. Cada usuario solo puede ver sus propios datos.', 'RLS en todas las tablas: '),
        bullet('300 req/min global, 10/min para admin. Protección contra abuso automatizado.', 'Rate limiting: '),
        bullet('Firma criptográfica HMAC en cada webhook de WhatsApp.', 'Webhook HMAC: '),
        bullet('TLS en tránsito, cifrado en reposo. Logging con Pino y redacción automática de secrets.', 'Datos encriptados: '),
        bullet('7 áreas auditadas, 0 vulnerabilidades críticas encontradas.', 'Auditoría completada: '),

        // 11. STACK
        heading('11. Stack Tecnológico'),
        greenLine(),
        makeTable(
          ['Capa', 'Tecnología'],
          [
            ['Frontend (webapp)', 'Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + Magic UI'],
            ['Backend (WhatsApp)', 'Node.js + Express + Railway'],
            ['Base de datos', 'Supabase PostgreSQL + Row Level Security (11 tablas)'],
            ['Inteligencia Artificial', 'OpenAI GPT-4o-mini (NLP) + GPT-4o Vision (imágenes)'],
            ['Mensajería', 'Meta Cloud API (WhatsApp Business)'],
            ['Hosting', 'Vercel (webapp) + Railway (backend) + Cloudflare Pages (landing)'],
            ['CI/CD', 'GitHub Actions (tests en push/PR) + Dependabot (seguridad)'],
            ['Tests', '56 tests unitarios automatizados (Vitest)'],
            ['Monitoreo', 'Pino logging + Error monitor + Admin notifications WhatsApp'],
            ['Analytics', 'Google Analytics 4 + Google Ads + Meta Pixel'],
          ]
        ),

        // 12. RESULTADOS
        heading('12. Resultados'),
        greenLine(),
        spacer(),
        makeTable(
          ['Usuario', 'Resultado', 'Ciudad'],
          [
            ['Carlos M. — Analista', 'S/2,400 ahorrados en 3 meses', 'Lima'],
            ['Valeria R. — Diseñadora', '+32% mejor control de gastos', 'Arequipa'],
            ['Diego P. — Emprendedor', 'Setup en 2 minutos, cero fricción', 'Lima'],
            ['Lucía F. — Contadora', '-40% en gastos hormiga', 'Trujillo'],
          ]
        ),

        // 13. MÉTRICAS
        heading('13. Métricas Clave'),
        greenLine(),
        makeTable(
          ['Métrica', 'Valor'],
          [
            ['Usuarios beta', '6'],
            ['Transacciones procesadas', '283+'],
            ['Bancos soportados', '11'],
            ['Funcionalidades completas', '19+'],
            ['Tests automatizados', '56'],
            ['Vulnerabilidades críticas', '0'],
            ['Setup promedio', '2 minutos'],
            ['Intenciones NLP', '25'],
            ['Servicios detectados (suscripciones)', '50+'],
            ['Páginas dashboard', '8'],
          ]
        ),

        // 14. ROADMAP
        heading('14. Roadmap'),
        greenLine(),
        h3('Q2 2026'),
        bullet('Verificación Meta Business (límite 250→ilimitado conversaciones/día)'),
        bullet('Modularización backend (parsers, NLP, webhook)'),
        bullet('Video demo 60 segundos'),
        h3('Q3 2026'),
        bullet('App móvil nativa (React Native)'),
        bullet('Más bancos regionales'),
        bullet('Marketplace de plugins'),
        h3('Q4 2026'),
        bullet('Expansión regional: Colombia y México'),
        bullet('API pública para desarrolladores'),
        h3('2027'),
        bullet('B2B: Neto para empresas (bienestar financiero de empleados)'),
        bullet('White-label para fintechs'),
        bullet('Integraciones ERP'),

        // 15. COMPETENCIA
        heading('15. Análisis Competitivo'),
        greenLine(),
        makeTable(
          ['Feature', 'Neto', 'Monefy', 'App del Banco', 'Excel'],
          [
            ['WhatsApp nativo', '✅ Sí', '❌ No', '❌ No', '❌ No'],
            ['Lectura automática', '✅ Sí', '❌ No', '⚠️ Parcial', '❌ No'],
            ['IA personalizada', '✅ Sí', '❌ No', '❌ No', '❌ No'],
            ['Dashboard web', '✅ Sí', '✅ Sí', '✅ Sí', '⚠️ Manual'],
            ['Gratis para empezar', '✅ Sí', '⚠️ Freemium', '✅ Sí', '✅ Sí'],
            ['Mercado peruano', '✅ Sí', '❌ No', '✅ Sí', '❌ No'],
            ['Registro por voz/imagen', '✅ Sí', '❌ No', '❌ No', '❌ No'],
            ['Reportes PDF', '✅ Sí', '❌ No', '⚠️ Básico', '⚠️ Manual'],
          ]
        ),

        // 16. OPORTUNIDAD
        heading('16. La Oportunidad'),
        greenLine(),
        h3('Para empresas'),
        body('Integra Neto como beneficio para tus empleados. Bienestar financiero que se mide y que impacta directamente en la productividad y retención de talento.'),
        spacer(),
        h3('Para inversores'),
        body('Mercado de 33 millones de peruanos, donde el 85% usa WhatsApp como canal principal de comunicación. Neto es el primer asistente financiero WhatsApp-first del mercado.'),
        spacer(),
        h3('Propuesta comercial'),
        bullet('Licencia corporativa para empresas (bienestar financiero)'),
        bullet('White-label para fintechs y bancos digitales'),
        bullet('API pública para integraciones personalizadas'),
        bullet('Expansión a mercados hispanohablantes (Colombia, México, Argentina)'),

        // ═══════════════════════════════════════
        // BITÁCORA DE EVOLUCIÓN
        // ═══════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading('17. Bitácora de Evolución'),
        greenLine(),
        body('Registro cronológico de la evolución de Neto desde su concepción hasta su estado actual.'),
        spacer(),

        h3('Fase 1 — Backend WhatsApp (Enero-Febrero 2026)'),
        bullet('Webhook WhatsApp con Meta Cloud API'),
        bullet('Onboarding conversacional de 4 pasos'),
        bullet('Registro manual de gastos por texto natural'),
        bullet('Clasificación IA con GPT-4o-mini (primeras 10 intenciones)'),
        bullet('Integración Supabase PostgreSQL'),
        bullet('Primer banco: BCP'),

        h3('Fase 2 — Multi-banco + IA (Febrero 2026)'),
        bullet('OAuth2 Gmail para lectura de correos bancarios'),
        bullet('Parsers para 11 bancos peruanos'),
        bullet('Clasificación expandida a 23 intenciones NLP'),
        bullet('Categorías y subcategorías personalizables (10 raíces canónicas)'),
        bullet('Presupuestos por categoría con alertas al 80%'),
        bullet('Multimoneda USD/PEN con tipo de cambio en tiempo real'),
        bullet('Lectura de imágenes Yape/Plin (GPT-4o Vision)'),

        h3('Fase 3 — Infraestructura + Seguridad (Marzo 2026)'),
        bullet('Separación landing/backend: neto.pe → Cloudflare Pages, api.neto.pe → Railway'),
        bullet('RLS en todas las tablas Supabase'),
        bullet('Rate limiting: 300 req/min global, 10/min admin'),
        bullet('Webhook HMAC verification'),
        bullet('Logging Pino con redacción de secrets'),
        bullet('56 tests unitarios (Vitest) + CI/CD GitHub Actions'),
        bullet('Backup semanal automatizado a GitHub Gist'),
        bullet('Dependabot para seguridad de dependencias'),

        h3('Fase 4 — Webapp app.neto.pe (Marzo 2026)'),
        bullet('Next.js 16 + React 19 + TypeScript + Tailwind v4 + shadcn/ui'),
        bullet('Google OAuth con Supabase Auth'),
        bullet('Tema "Nocturnal Precision" — dark only, OLED-friendly, glassmorphism'),
        bullet('Dashboard overview: KPIs, donut, trend chart, widgets'),
        bullet('Transacciones: CRUD completo, filtros, búsqueda, paginación'),
        bullet('Presupuestos: agrupados por categoría, sub-presupuestos, sugerencias IA'),
        bullet('Metas de ahorro: CRUD, progreso visual, deadlines'),
        bullet('Suscripciones: detección automática de 50+ servicios'),
        bullet('Reportes PDF: score financiero, gráficos, descarga'),
        bullet('Calendario financiero: vista mensual interactiva'),
        bullet('Configuración: perfil, plan, referidos, notificaciones, export'),

        h3('Fase 5 — UX Polish (20 rondas de mejoras)'),
        bullet('FAB button, bulk delete, global search Ctrl+K'),
        bullet('Sparklines en KPIs, shimmer skeletons, lazy loading'),
        bullet('Widget tipo de cambio, top comercios, métodos de pago'),
        bullet('Spending heatmap, gasto del día vs promedio'),
        bullet('Score trend chart (4 meses), consejo IA diario'),
        bullet('PWA manifest + Apple Web App meta tags'),
        bullet('Responsive optimizado: desktop, tablet, mobile'),
        bullet('20 rondas de mejoras iterativas (38+ cambios)'),

        h3('Fase 6 — Marketing + Landing (Marzo 2026)'),
        bullet('Landing page completa con 11 bancos, 8 features, pricing, CTAs'),
        bullet('SEO: meta tags, JSON-LD (Organization, WebSite, FAQPage, BreadcrumbList)'),
        bullet('Google Search Console verificado + sitemap'),
        bullet('Google Ads (AW-8115117081) + Meta Pixel + GA4'),
        bullet('Blog SEO con 5 artículos + cross-linking'),
        bullet('Brand Voice Guidelines documentadas'),
        bullet('Marketing Audit completo (score 53/100 con plan de mejora)'),

        h3('Fase 7 — Admin + Monitoreo (Marzo 2026)'),
        bullet('Portal admin en /admin: usuarios, planes, NLP errors'),
        bullet('Acciones admin: cambiar plan, extender premium, desactivar, eliminar'),
        bullet('NLP error logging: mensajes no clasificados registrados para mejora'),
        bullet('Filtros de errores NLP por usuario, tipo, búsqueda de texto'),
        bullet('Auditoría WhatsApp ↔ Webapp: categorías, subcategorías, vinculación'),

        spacer(),
        new Paragraph({
          spacing: { before: 200, after: 200 },
          shading: { type: ShadingType.SOLID, color: 'F0FFF8' },
          children: [
            new TextRun({ text: 'Estado actual: ', bold: true, font: 'Calibri', size: 20, color: NETO_GREEN }),
            new TextRun({ text: '19+ funcionalidades completas, 11 bancos, 56 tests, 0 vulnerabilidades, 8 páginas dashboard, desplegado en producción en neto.pe + app.neto.pe + api.neto.pe.', font: 'Calibri', size: 20, color: '555555' }),
          ],
        }),

        // CIERRE
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ spacing: { before: 2000 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'NETO', bold: true, color: NETO_GREEN, font: 'Calibri', size: 56 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200 },
          children: [new TextRun({ text: 'Ordena tu plata sin mover un dedo', italics: true, font: 'Calibri', size: 26, color: '666666' })],
        }),
        greenLine(),
        spacer(),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '🌐 neto.pe', font: 'Calibri', size: 22, color: NETO_GREEN })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '📊 app.neto.pe', font: 'Calibri', size: 22, color: NETO_GREEN })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '💬 +51 933 014 505', font: 'Calibri', size: 22, color: NETO_GREEN })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '✉️ hola@neto.pe', font: 'Calibri', size: 22, color: NETO_GREEN })] }),
        spacer(),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 400 },
          children: [new TextRun({ text: 'Gracias.', font: 'Calibri', size: 28, color: '999999' })],
        }),
      ],
    },
  ],
});

(async () => {
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync('C:/Neto.pe/docs/NETO-Presentacion-Ventas.docx', buffer);
  console.log('DOCX created: C:/Neto.pe/docs/NETO-Presentacion-Ventas.docx');
})();
