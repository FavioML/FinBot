const pptxgen = require("pptxgenjs");
const pres = new pptxgen();

pres.layout = "LAYOUT_16x9";
pres.author = "NETO";
pres.title = "NETO — Asistente Financiero Inteligente por WhatsApp";

// Brand colors (no # prefix)
const C = {
  bg: "0E0E0C",
  bgCard: "1A1A18",
  bgLight: "131311",
  green: "1D9E75",
  greenLight: "68dbae",
  amber: "EF9F27",
  red: "D85A30",
  blue: "378ADD",
  white: "F0EFE8",
  gray: "87948C",
  grayLight: "bccac1",
  divider: "2A2A26",
};

const FONT = "Calibri";
const FONT_BOLD = "Calibri";

// Helper: fresh shadow factory
const cardShadow = () => ({ type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.3 });

// ===== SLIDE 1 — PORTADA =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  // Top accent line
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.green } });
  // NETO logo text
  s.addText("NETO", {
    x: 0, y: 1.2, w: 10, h: 1.2,
    fontSize: 72, fontFace: FONT_BOLD, color: C.green,
    bold: true, align: "center", charSpacing: 12,
  });
  // Subtitle
  s.addText("Asistente Financiero Inteligente por WhatsApp", {
    x: 1, y: 2.4, w: 8, h: 0.6,
    fontSize: 20, fontFace: FONT, color: C.white, align: "center",
  });
  // Tagline
  s.addText("Ordena tu plata sin mover un dedo", {
    x: 1.5, y: 3.2, w: 7, h: 0.5,
    fontSize: 16, fontFace: FONT, color: C.grayLight, align: "center", italic: true,
  });
  // Bottom bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.0, w: 10, h: 0.625, fill: { color: C.green, transparency: 10 } });
  s.addText("Marzo 2026  |  neto.pe  |  app.neto.pe", {
    x: 0, y: 5.05, w: 10, h: 0.55,
    fontSize: 12, fontFace: FONT, color: C.white, align: "center",
  });
}

// ===== SLIDE 2 — EL PROBLEMA =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("El problema que nadie resuelve", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const problems = [
    { num: "78%", desc: "de peruanos no lleva un registro de gastos" },
    { num: "0", desc: "apps financieras pensadas para WhatsApp" },
    { num: "85x", desc: "al dia revisa WhatsApp el peruano promedio" },
    { num: "3x", desc: "al mes abre su app bancaria" },
  ];

  problems.forEach((p, i) => {
    const x = 0.6 + (i % 2) * 4.5;
    const y = 1.3 + Math.floor(i / 2) * 1.7;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.0, h: 1.4, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(p.num, { x: x + 0.3, y: y + 0.15, w: 1.5, h: 0.8, fontSize: 36, fontFace: FONT_BOLD, color: C.green, bold: true, valign: "middle" });
    s.addText(p.desc, { x: x + 1.8, y: y + 0.15, w: 2.0, h: 0.8, fontSize: 13, fontFace: FONT, color: C.grayLight, valign: "middle" });
  });

  s.addText("Los bancos envian correos de gastos, pero nadie los organiza. Las apps requieren anotar manualmente cada gasto.", {
    x: 0.6, y: 4.7, w: 8.8, h: 0.5,
    fontSize: 12, fontFace: FONT, color: C.gray, italic: true,
  });
}

// ===== SLIDE 3 — LA SOLUCION =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("NETO: Tu asistente financiero en WhatsApp", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 28, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const pillars = [
    { icon: "1", title: "Lee tus correos bancarios", desc: "Automaticamente detecta gastos e ingresos de 11 bancos peruanos" },
    { icon: "2", title: "Te resume por WhatsApp", desc: "Resumenes diarios, semanales y mensuales sin que hagas nada" },
    { icon: "3", title: "Dashboard web completo", desc: "Graficos, metas, presupuestos, reportes PDF en app.neto.pe" },
  ];

  pillars.forEach((p, i) => {
    const y = 1.3 + i * 1.2;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 8.8, h: 1.0, fill: { color: C.bgCard }, shadow: cardShadow() });
    // Number circle
    s.addShape(pres.shapes.OVAL, { x: 0.9, y: y + 0.2, w: 0.6, h: 0.6, fill: { color: C.green } });
    s.addText(p.icon, { x: 0.9, y: y + 0.2, w: 0.6, h: 0.6, fontSize: 18, fontFace: FONT_BOLD, color: C.bg, bold: true, align: "center", valign: "middle" });
    s.addText(p.title, { x: 1.8, y: y + 0.1, w: 7.0, h: 0.4, fontSize: 16, fontFace: FONT_BOLD, color: C.white, bold: true });
    s.addText(p.desc, { x: 1.8, y: y + 0.5, w: 7.0, h: 0.4, fontSize: 12, fontFace: FONT, color: C.grayLight });
  });

  s.addText("Sin contrasenas bancarias. Sin anotar nada. Solo resultados.", {
    x: 0.6, y: 4.8, w: 8.8, h: 0.5,
    fontSize: 16, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center",
  });
}

// ===== SLIDE 4 — COMO FUNCIONA =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Setup en 2 minutos", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const steps = [
    { num: "01", title: "Escribele a Neto", desc: "Inicia una conversacion por WhatsApp al +51 933 014 505" },
    { num: "02", title: "Conecta tu Gmail", desc: "Donde llegan las alertas de tu banco (BCP, BBVA, etc.)" },
    { num: "03", title: "Neto clasifica todo", desc: "IA lee correos, detecta montos, comercios y categorias" },
    { num: "04", title: "Revisa tu dashboard", desc: "Graficos, metas, reportes PDF en app.neto.pe" },
  ];

  steps.forEach((st, i) => {
    const x = 0.4 + i * 2.35;
    s.addShape(pres.shapes.RECTANGLE, { x, y: 1.3, w: 2.1, h: 3.2, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(st.num, { x, y: 1.5, w: 2.1, h: 0.7, fontSize: 32, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center" });
    s.addShape(pres.shapes.RECTANGLE, { x: x + 0.3, y: 2.3, w: 1.5, h: 0.03, fill: { color: C.green, transparency: 50 } });
    s.addText(st.title, { x: x + 0.15, y: 2.5, w: 1.8, h: 0.5, fontSize: 14, fontFace: FONT_BOLD, color: C.white, bold: true, align: "center" });
    s.addText(st.desc, { x: x + 0.15, y: 3.1, w: 1.8, h: 1.0, fontSize: 11, fontFace: FONT, color: C.grayLight, align: "center" });
  });

  // Arrow connectors
  for (let i = 0; i < 3; i++) {
    const x = 2.55 + i * 2.35;
    s.addText(">", { x, y: 2.6, w: 0.3, h: 0.4, fontSize: 20, fontFace: FONT, color: C.green, align: "center", valign: "middle" });
  }
}

// ===== SLIDE 5 — BANCOS SOPORTADOS =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Compatible con 11 bancos peruanos", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const banks = ["BCP", "BBVA", "Interbank", "Scotiabank", "Yape", "Plin", "Falabella", "Ripley", "BanBif", "Mibanco", "CMAC"];

  banks.forEach((b, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 0.6 + col * 2.3;
    const y = 1.3 + row * 1.2;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.0, h: 0.9, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(b, { x, y, w: 2.0, h: 0.9, fontSize: 15, fontFace: FONT_BOLD, color: C.white, bold: true, align: "center", valign: "middle" });
  });

  s.addText("Lectura automatica de correos de notificacion bancaria — gastos e ingresos", {
    x: 0.6, y: 4.8, w: 8.8, h: 0.5,
    fontSize: 13, fontFace: FONT, color: C.grayLight, align: "center", italic: true,
  });
}

// ===== SLIDE 6 — FUNCIONALIDADES WHATSAPP =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("WhatsApp es tu centro de control", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const features = [
    "Registro automatico de gastos e ingresos",
    "Clasificacion IA (GPT-4o-mini, 25 intenciones NLP)",
    "Registro manual por texto",
    "Lectura de imagenes Yape/Plin (Vision AI)",
    "Resumen diario automatico",
    "Resumen semanal con insights IA",
    "Resumen mensual (1ro de cada mes)",
    "Alertas de presupuesto en tiempo real",
    "Recordatorios diarios (8pm Lima)",
  ];

  features.forEach((f, i) => {
    const col = i < 5 ? 0 : 1;
    const row = i < 5 ? i : i - 5;
    const x = 0.6 + col * 4.7;
    const y = 1.2 + row * 0.75;
    s.addShape(pres.shapes.OVAL, { x, y: y + 0.1, w: 0.25, h: 0.25, fill: { color: C.green } });
    s.addText(f, { x: x + 0.4, y, w: 4.0, h: 0.5, fontSize: 12, fontFace: FONT, color: C.white });
  });

  s.addText("+51 933 014 505", {
    x: 3.0, y: 5.0, w: 4.0, h: 0.4,
    fontSize: 14, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center",
  });
}

// ===== SLIDE 7 — DASHBOARD WEB =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Dashboard completo en app.neto.pe", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const pages = [
    { title: "Overview", desc: "KPIs, donut categorias, trend chart, score" },
    { title: "Transacciones", desc: "CRUD, filtros, busqueda, paginacion" },
    { title: "Presupuestos", desc: "Por categoria, alertas, sugerencias IA" },
    { title: "Metas de Ahorro", desc: "Progreso visual, deadlines, emoji" },
    { title: "Suscripciones", desc: "Deteccion automatica (50+ servicios)" },
    { title: "Reportes PDF", desc: "Score financiero, graficos, descarga" },
    { title: "Calendario", desc: "Vista mensual interactiva" },
    { title: "Configuracion", desc: "Perfil, plan, referidos, export" },
  ];

  pages.forEach((p, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 0.4 + col * 2.35;
    const y = 1.2 + row * 1.9;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.1, h: 1.6, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.1, h: 0.05, fill: { color: C.green } });
    s.addText(p.title, { x: x + 0.15, y: y + 0.2, w: 1.8, h: 0.4, fontSize: 13, fontFace: FONT_BOLD, color: C.green, bold: true });
    s.addText(p.desc, { x: x + 0.15, y: y + 0.7, w: 1.8, h: 0.7, fontSize: 11, fontFace: FONT, color: C.grayLight });
  });
}

// ===== SLIDE 8 — SCORE FINANCIERO =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Score Financiero Inteligente", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  // Big score display
  s.addShape(pres.shapes.OVAL, { x: 1.5, y: 1.3, w: 3.0, h: 3.0, fill: { color: C.bgCard }, shadow: cardShadow() });
  s.addShape(pres.shapes.OVAL, { x: 1.7, y: 1.5, w: 2.6, h: 2.6, line: { color: C.green, width: 4 }, fill: { color: C.bg } });
  s.addText("84", { x: 1.7, y: 1.8, w: 2.6, h: 1.5, fontSize: 56, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center", valign: "middle" });
  s.addText("SCORE", { x: 1.7, y: 3.1, w: 2.6, h: 0.5, fontSize: 12, fontFace: FONT, color: C.gray, align: "center" });

  // Formula
  const formulaParts = [
    { label: "Base", value: "75", color: C.white },
    { label: "+ Ahorro", value: "+15", color: C.green },
    { label: "- Presupuesto", value: "-6", color: C.amber },
    { label: "= Score", value: "84", color: C.green },
  ];

  formulaParts.forEach((fp, i) => {
    const y = 1.5 + i * 0.8;
    s.addText(fp.label, { x: 5.5, y, w: 2.5, h: 0.4, fontSize: 14, fontFace: FONT, color: C.grayLight });
    s.addText(fp.value, { x: 8.0, y, w: 1.2, h: 0.4, fontSize: 18, fontFace: FONT_BOLD, color: fp.color, bold: true, align: "right" });
  });

  s.addText("Cada usuario sabe exactamente como mejorar sus finanzas", {
    x: 0.6, y: 4.8, w: 8.8, h: 0.5,
    fontSize: 14, fontFace: FONT, color: C.grayLight, align: "center", italic: true,
  });
}

// ===== SLIDE 9 — INTELIGENCIA ARTIFICIAL =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("IA que entiende tus finanzas", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const aiFeatures = [
    { title: "Clasificacion NLP", desc: "25 intenciones reconocidas por GPT-4o-mini. Entiende lenguaje natural en espanol peruano." },
    { title: "Categorias Custom", desc: "Categorias y subcategorias personalizables. El sistema aprende de tus correcciones." },
    { title: "Consejos Diarios", desc: "Recomendaciones financieras personalizadas basadas en tus patrones de gasto." },
    { title: "Vision AI", desc: "Lee capturas de Yape y Plin. Extrae monto, comercio y fecha automaticamente." },
  ];

  aiFeatures.forEach((f, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.6 + col * 4.6;
    const y = 1.2 + row * 1.8;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.2, h: 1.5, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(f.title, { x: x + 0.3, y: y + 0.15, w: 3.6, h: 0.4, fontSize: 15, fontFace: FONT_BOLD, color: C.green, bold: true });
    s.addText(f.desc, { x: x + 0.3, y: y + 0.6, w: 3.6, h: 0.7, fontSize: 11, fontFace: FONT, color: C.grayLight });
  });
}

// ===== SLIDE 10 — MODELO DE NEGOCIO =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Freemium que convierte", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  // FREE column
  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 1.1, w: 4.2, h: 3.8, fill: { color: C.bgCard }, shadow: cardShadow() });
  s.addText("FREE", { x: 0.6, y: 1.2, w: 4.2, h: 0.5, fontSize: 20, fontFace: FONT_BOLD, color: C.grayLight, bold: true, align: "center" });
  s.addText("S/ 0", { x: 0.6, y: 1.7, w: 4.2, h: 0.5, fontSize: 28, fontFace: FONT_BOLD, color: C.white, bold: true, align: "center" });
  const freeFeatures = [
    "Registro manual por WhatsApp",
    "Dashboard mes actual",
    "3 presupuestos, 1 meta",
    "5 imagenes/mes",
    "Resumen semanal basico",
  ];
  s.addText(freeFeatures.map((f, i) => ({
    text: f,
    options: { bullet: true, breakLine: i < freeFeatures.length - 1, color: C.grayLight, fontSize: 11 },
  })), { x: 1.0, y: 2.4, w: 3.4, h: 2.2, fontFace: FONT, paraSpaceAfter: 6 });

  // PRO column
  s.addShape(pres.shapes.RECTANGLE, { x: 5.2, y: 1.1, w: 4.2, h: 3.8, fill: { color: C.bgCard }, shadow: cardShadow() });
  s.addShape(pres.shapes.RECTANGLE, { x: 5.2, y: 1.1, w: 4.2, h: 0.05, fill: { color: C.green } });
  s.addText("PRO", { x: 5.2, y: 1.2, w: 4.2, h: 0.5, fontSize: 20, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center" });
  s.addText("S/ 10/mes", { x: 5.2, y: 1.7, w: 4.2, h: 0.5, fontSize: 28, fontFace: FONT_BOLD, color: C.white, bold: true, align: "center" });
  const proFeatures = [
    "Lectura automatica Gmail (11 bancos)",
    "Dashboard historial completo",
    "Presupuestos y metas ilimitados",
    "Imagenes ilimitadas",
    "Resumenes diarios + consejos IA",
    "Reportes PDF + calendario + heatmap",
    "Export CSV/JSON",
  ];
  s.addText(proFeatures.map((f, i) => ({
    text: f,
    options: { bullet: true, breakLine: i < proFeatures.length - 1, color: C.grayLight, fontSize: 11 },
  })), { x: 5.6, y: 2.4, w: 3.4, h: 2.2, fontFace: FONT, paraSpaceAfter: 4 });

  s.addText("Anual: S/ 99/ano (2 meses gratis)  |  Precio fundador — cancela cuando quieras", {
    x: 0.6, y: 5.0, w: 8.8, h: 0.4,
    fontSize: 12, fontFace: FONT, color: C.green, align: "center",
  });
}

// ===== SLIDE 11 — SEGURIDAD =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Seguridad de nivel empresarial", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const secFeatures = [
    { title: "Sin contrasenas bancarias", desc: "Solo lee correos de notificacion. Nunca accede a tu banca online." },
    { title: "RLS en todas las tablas", desc: "Row Level Security en Supabase. Cada usuario solo ve sus datos." },
    { title: "Rate Limiting", desc: "300 req/min global, 10/min admin. Proteccion contra abuso." },
    { title: "HMAC Verification", desc: "Webhook de WhatsApp verificado con firma criptografica." },
    { title: "Datos encriptados", desc: "TLS en transito, cifrado en reposo. Sin PII en logs." },
    { title: "Auditoria completada", desc: "7 areas auditadas. 0 vulnerabilidades criticas encontradas." },
  ];

  secFeatures.forEach((f, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.4 + col * 3.15;
    const y = 1.2 + row * 1.8;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.9, h: 1.5, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(f.title, { x: x + 0.2, y: y + 0.15, w: 2.5, h: 0.4, fontSize: 13, fontFace: FONT_BOLD, color: C.green, bold: true });
    s.addText(f.desc, { x: x + 0.2, y: y + 0.6, w: 2.5, h: 0.7, fontSize: 10, fontFace: FONT, color: C.grayLight });
  });
}

// ===== SLIDE 12 — STACK TECNOLOGICO =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Arquitectura moderna y escalable", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const stack = [
    { area: "Frontend", tech: "Next.js 16 + React 19 + TypeScript + Tailwind + shadcn/ui" },
    { area: "Backend", tech: "Node.js + Express + Railway" },
    { area: "Database", tech: "Supabase PostgreSQL + RLS (11 tablas)" },
    { area: "IA", tech: "OpenAI GPT-4o-mini + GPT-4o Vision" },
    { area: "Messaging", tech: "Meta Cloud API (WhatsApp Business)" },
    { area: "Hosting", tech: "Vercel + Railway + Cloudflare Pages" },
    { area: "CI/CD", tech: "GitHub Actions + Dependabot" },
    { area: "Tests", tech: "56 tests unitarios (Vitest)" },
  ];

  stack.forEach((item, i) => {
    const y = 1.15 + i * 0.52;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 8.8, h: 0.44, fill: { color: i % 2 === 0 ? C.bgCard : C.bgLight } });
    s.addText(item.area, { x: 0.8, y, w: 2.0, h: 0.44, fontSize: 12, fontFace: FONT_BOLD, color: C.green, bold: true, valign: "middle" });
    s.addText(item.tech, { x: 2.8, y, w: 6.4, h: 0.44, fontSize: 12, fontFace: FONT, color: C.grayLight, valign: "middle" });
  });
}

// ===== SLIDE 13 — RESULTADOS =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Resultados que hablan", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const testimonials = [
    { name: "Carlos M.", role: "Analista, Lima", metric: "S/2,400", metricDesc: "ahorrados en 3 meses" },
    { name: "Valeria R.", role: "Disenadora, Arequipa", metric: "+32%", metricDesc: "mejor control de gastos" },
    { name: "Diego P.", role: "Emprendedor, Lima", metric: "2 min", metricDesc: "setup, cero friccion" },
    { name: "Lucia F.", role: "Contadora, Trujillo", metric: "-40%", metricDesc: "en gastos hormiga" },
  ];

  testimonials.forEach((t, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.6 + col * 4.6;
    const y = 1.2 + row * 1.9;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.2, h: 1.6, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(t.metric, { x: x + 0.3, y: y + 0.15, w: 3.6, h: 0.6, fontSize: 28, fontFace: FONT_BOLD, color: C.green, bold: true });
    s.addText(t.metricDesc, { x: x + 0.3, y: y + 0.7, w: 3.6, h: 0.3, fontSize: 12, fontFace: FONT, color: C.grayLight });
    s.addText(t.name + " — " + t.role, { x: x + 0.3, y: y + 1.1, w: 3.6, h: 0.3, fontSize: 11, fontFace: FONT, color: C.gray, italic: true });
  });
}

// ===== SLIDE 14 — METRICAS CLAVE =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Traccion y crecimiento", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const metrics = [
    { value: "6", label: "Usuarios beta" },
    { value: "283+", label: "Transacciones" },
    { value: "11", label: "Bancos" },
    { value: "19+", label: "Funcionalidades" },
    { value: "56", label: "Tests automatizados" },
    { value: "0", label: "Vulnerabilidades" },
    { value: "2 min", label: "Setup promedio" },
  ];

  metrics.forEach((m, i) => {
    const col = i < 4 ? i : i - 4;
    const row = i < 4 ? 0 : 1;
    const colCount = row === 0 ? 4 : 3;
    const totalW = colCount * 2.3 - 0.3;
    const startX = (10 - totalW) / 2;
    const x = startX + col * 2.3;
    const y = 1.3 + row * 2.0;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.0, h: 1.6, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(m.value, { x, y: y + 0.2, w: 2.0, h: 0.7, fontSize: 32, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center" });
    s.addText(m.label, { x, y: y + 0.95, w: 2.0, h: 0.4, fontSize: 11, fontFace: FONT, color: C.grayLight, align: "center" });
  });
}

// ===== SLIDE 15 — ROADMAP =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Lo que viene", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const roadmap = [
    { quarter: "Q2 2026", items: "Verificacion Meta Business\nModularizacion backend\nVideo demo 60s" },
    { quarter: "Q3 2026", items: "App movil nativa\nMas bancos\nMarketplace de plugins" },
    { quarter: "Q4 2026", items: "Expansion regional\n(Colombia, Mexico)\nAPI publica" },
    { quarter: "2027", items: "B2B (empresas)\nWhite-label\nIntegraciones ERP" },
  ];

  // Timeline line
  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 1.85, w: 8.8, h: 0.04, fill: { color: C.green, transparency: 40 } });

  roadmap.forEach((r, i) => {
    const x = 0.6 + i * 2.3;
    // Dot on timeline
    s.addShape(pres.shapes.OVAL, { x: x + 0.85, y: 1.7, w: 0.3, h: 0.3, fill: { color: C.green } });
    s.addText(r.quarter, { x, y: 2.1, w: 2.0, h: 0.4, fontSize: 14, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center" });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.6, w: 2.0, h: 2.2, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addText(r.items, { x: x + 0.15, y: 2.8, w: 1.7, h: 1.8, fontSize: 11, fontFace: FONT, color: C.grayLight, valign: "top" });
  });
}

// ===== SLIDE 16 — COMPETENCIA =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("Por que Neto y no otra app?", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const headers = ["Feature", "Neto", "Monefy", "App Banco", "Excel"];
  const rows = [
    ["WhatsApp nativo", "Si", "No", "No", "No"],
    ["Lectura automatica", "Si", "No", "Parcial", "No"],
    ["IA personalizada", "Si", "No", "No", "No"],
    ["Dashboard web", "Si", "Si", "Si", "Manual"],
    ["Gratis para empezar", "Si", "Freemium", "Si", "Si"],
    ["Mercado peruano", "Si", "No", "Si", "No"],
  ];

  const colW = [2.5, 1.5, 1.5, 1.5, 1.5];
  const tableX = 0.6;

  // Header row
  headers.forEach((h, i) => {
    let xPos = tableX;
    for (let j = 0; j < i; j++) xPos += colW[j] + 0.1;
    s.addShape(pres.shapes.RECTANGLE, { x: xPos, y: 1.2, w: colW[i], h: 0.5, fill: { color: C.green } });
    s.addText(h, { x: xPos, y: 1.2, w: colW[i], h: 0.5, fontSize: 12, fontFace: FONT_BOLD, color: C.bg, bold: true, align: "center", valign: "middle" });
  });

  // Data rows
  rows.forEach((row, ri) => {
    const y = 1.8 + ri * 0.55;
    row.forEach((cell, ci) => {
      let xPos = tableX;
      for (let j = 0; j < ci; j++) xPos += colW[j] + 0.1;
      const bgColor = ri % 2 === 0 ? C.bgCard : C.bgLight;
      s.addShape(pres.shapes.RECTANGLE, { x: xPos, y, w: colW[ci], h: 0.48, fill: { color: bgColor } });
      const cellColor = cell === "Si" ? C.green : cell === "No" ? C.red : C.grayLight;
      s.addText(cell, { x: xPos, y, w: colW[ci], h: 0.48, fontSize: 11, fontFace: ci === 0 ? FONT_BOLD : FONT, color: cellColor, bold: ci === 0, align: ci === 0 ? "left" : "center", valign: "middle", margin: ci === 0 ? [0, 0, 0, 8] : 0 });
    });
  });
}

// ===== SLIDE 17 — LA OPORTUNIDAD =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("La oportunidad", {
    x: 0.6, y: 0.3, w: 9, h: 0.7,
    fontSize: 32, fontFace: FONT_BOLD, color: C.white, bold: true,
  });

  const opps = [
    { title: "Para empresas", desc: "Integra Neto como beneficio para tus empleados. Bienestar financiero que se mide." },
    { title: "Para inversores", desc: "Mercado de 33M de peruanos, 85% usa WhatsApp. Primer asistente financiero WhatsApp-first." },
    { title: "Licencia corporativa", desc: "White-label, API publica, integraciones ERP. Escala a toda la organizacion." },
  ];

  opps.forEach((o, i) => {
    const y = 1.2 + i * 1.3;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 8.8, h: 1.1, fill: { color: C.bgCard }, shadow: cardShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 0.08, h: 1.1, fill: { color: C.green } });
    s.addText(o.title, { x: 1.0, y: y + 0.1, w: 8.0, h: 0.4, fontSize: 16, fontFace: FONT_BOLD, color: C.green, bold: true });
    s.addText(o.desc, { x: 1.0, y: y + 0.5, w: 8.0, h: 0.5, fontSize: 13, fontFace: FONT, color: C.grayLight });
  });

  s.addText("El asistente financiero que el Peru necesita", {
    x: 0.6, y: 4.8, w: 8.8, h: 0.5,
    fontSize: 18, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center",
  });
}

// ===== SLIDE 18 — CIERRE =====
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.green } });

  s.addText("NETO", {
    x: 0, y: 1.0, w: 10, h: 1.0,
    fontSize: 64, fontFace: FONT_BOLD, color: C.green, bold: true, align: "center", charSpacing: 10,
  });

  s.addText("Ordena tu plata sin mover un dedo", {
    x: 1.5, y: 2.1, w: 7, h: 0.5,
    fontSize: 18, fontFace: FONT, color: C.white, align: "center", italic: true,
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 3.0, y: 2.8, w: 4.0, h: 0.03, fill: { color: C.green, transparency: 50 } });

  const contacts = [
    { label: "Web", value: "neto.pe" },
    { label: "Dashboard", value: "app.neto.pe" },
    { label: "WhatsApp", value: "+51 933 014 505" },
    { label: "Email", value: "hola@neto.pe" },
  ];

  contacts.forEach((c, i) => {
    const y = 3.1 + i * 0.45;
    s.addText(c.label, { x: 3.0, y, w: 1.8, h: 0.35, fontSize: 12, fontFace: FONT, color: C.gray, align: "right" });
    s.addText(c.value, { x: 5.0, y, w: 2.5, h: 0.35, fontSize: 12, fontFace: FONT_BOLD, color: C.green, bold: true });
  });

  s.addText("Gracias.", {
    x: 0, y: 4.8, w: 10, h: 0.5,
    fontSize: 20, fontFace: FONT, color: C.grayLight, align: "center",
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.565, w: 10, h: 0.06, fill: { color: C.green } });
}

// Generate
pres.writeFile({ fileName: "C:/Neto.pe/docs/NETO-Pitch-Deck.pptx" })
  .then(() => console.log("PPTX created: C:/Neto.pe/docs/NETO-Pitch-Deck.pptx"))
  .catch(err => console.error("Error:", err));
