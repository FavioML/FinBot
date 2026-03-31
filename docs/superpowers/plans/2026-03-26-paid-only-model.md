# Neto Paid-Only Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Neto from freemium to paid-only (S/10/mes, S/99/year) with manual admin onboarding flow via WhatsApp, limited to 100 Google test users.

**Architecture:** New onboarding states in WhatsApp bot (pitch → payment → email collection → OAuth). Admin commands `/pago` and `/aprobar` trigger state transitions and user notifications. Landing/webapp updated to remove free plan references. Database gets new columns for payment tracking.

**Tech Stack:** Node.js (backend), Next.js (webapp), Supabase (DB), Meta Cloud API (WhatsApp)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/constants.js` | Modify | Remove FREEMIUM_ACTIVE, update PLAN_CONFIG |
| `index.js` (~lines 854-886) | Modify | New onboarding flow (states 1-5), admin commands `/pago`, `/aprobar` |
| `landing/src/components/Pricing.tsx` | Modify | Remove free plan card, single Pro plan with monthly/annual toggle |
| `landing/src/components/Navbar.tsx` | Modify | "Empezar gratis" → "Empezar ahora" |
| `landing/src/components/Hero.tsx` | Modify | Remove "S/0" stat, update CTA text |
| `landing/src/components/FinalCTA.tsx` | Modify | Remove "Gratis" text |
| `landing/src/components/StickyCTA.tsx` | Modify | Remove "Gratis" text |
| `landing/src/components/ExitIntent.tsx` | Modify | Remove "gratis" text |
| `landing/src/components/Referral.tsx` | Modify | Remove/update "gratis" references |
| `landing/src/components/Testimonials.tsx` | Modify | Remove "gratis" CTA |
| `webapp/src/lib/plan.ts` | Modify | Remove free limits (all users are premium) |
| `webapp/src/lib/types.ts` | Modify | Add new fields to Usuario interface |
| `webapp/src/components/shared/upgrade-prompt.tsx` | Modify | Update pricing text (S/10 not S/6) |
| `webapp/src/app/dashboard/configuracion/page.tsx` | Modify | Remove free/pro comparison, show plan status |

---

### Task 1: Database — Add payment tracking columns

**Files:**
- Modify: Supabase `usuarios` table (via SQL)

- [ ] **Step 1: Run migration SQL in Supabase**

```sql
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS estado_pago text DEFAULT 'pendiente' CHECK (estado_pago IN ('pendiente', 'pagado', 'vencido')),
  ADD COLUMN IF NOT EXISTS tipo_plan text DEFAULT 'mensual' CHECK (tipo_plan IN ('mensual', 'anual')),
  ADD COLUMN IF NOT EXISTS fecha_pago timestamptz,
  ADD COLUMN IF NOT EXISTS fecha_vencimiento timestamptz,
  ADD COLUMN IF NOT EXISTS aprobado_gcc boolean DEFAULT false;
```

Run via Supabase MCP tool `execute_sql`.

- [ ] **Step 2: Verify columns were created**

Run: `SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name IN ('estado_pago', 'tipo_plan', 'fecha_pago', 'fecha_vencimiento', 'aprobado_gcc');`

Expected: 5 rows returned.

---

### Task 2: Backend — New onboarding flow (paid-first)

**Files:**
- Modify: `index.js` lines 854-886 (onboarding section)

The new onboarding uses these states:
- **Estado 0**: Normal (usuario activo)
- **Estado 1**: Mostró pitch, esperando que diga "sí" para pagar
- **Estado 2**: Esperando comprobante de pago (foto Yape)
- **Estado 3**: Pago confirmado por admin, esperando que envíe Gmail
- **Estado 10**: Selección de categorías (existente)
- **Estado 20**: Configurar presupuesto (existente)

- [ ] **Step 1: Modify the "hola" greeting for new users (line 858-861)**

Replace the current new-user greeting that offers Gmail link directly. New flow shows the pitch and asks if they want to subscribe.

Old code (line 858-861):
```javascript
if (!tieneGmail && !usuario.onboarding_completado) {
  var urlOAuth = generarUrlAutorizacion(from);
  await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
  respuesta = '...(current long message with OAuth link)...';
```

New code:
```javascript
if (!tieneGmail && !usuario.onboarding_completado) {
  await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
  respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy *NETO*, tu asistente financiero.\n\n' +
    '📊 *¿Qué hace Neto?*\n' +
    '• Lee tus correos bancarios automáticamente\n' +
    '• Te dice en qué gastas tu plata por WhatsApp\n' +
    '• Dashboard con gráficos, metas y reportes PDF\n' +
    '• Funciona con BCP, BBVA, Interbank, Scotiabank, Yape, Plin y más\n\n' +
    '💰 *Precio fundador:*\n' +
    '• *S/10/mes* — mensual\n' +
    '• *S/99/año* — 2 meses gratis\n\n' +
    '¿Te animas? Escribe *sí* para empezar.';
```

- [ ] **Step 2: Add handler for onboarding_paso === 1 (user says "sí")**

Add BEFORE the existing `if (usuario.onboarding_paso === 10 ...)` block (line 815). This handles the user confirming they want to pay.

```javascript
// Paso 1: Usuario confirma interés → enviar datos de pago
if (usuario.onboarding_paso === 1 && !cmd.startsWith('/')) {
  const resp1 = cmd.trim().toLowerCase();
  if (resp1 === 'si' || resp1 === 'sí' || resp1 === 'yes' || resp1 === 'dale' || resp1 === 'va' || resp1 === 'quiero') {
    await supabase.from('usuarios').update({ onboarding_paso: 2 }).eq('id', usuario.id);
    respuesta = '🎉 *¡Genial!*\n\n' +
      'Para activar tu cuenta, elige tu plan:\n\n' +
      '1️⃣ *Mensual* — S/10/mes\n' +
      '2️⃣ *Anual* — S/99/año (2 meses gratis)\n\n' +
      '📲 *Yapea al:* 970398192\n' +
      '👤 *A nombre de:* Favio Mendoza\n\n' +
      'Después envíame la captura del Yape aquí. 📸';
    await enviarWhatsapp(from, respuesta);
    return;
  } else if (resp1 === 'no' || resp1 === 'no gracias') {
    await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
    respuesta = '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.\n\n_También puedes usar Neto en modo manual (sin lectura de correos). Escribe */manual*._';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  // Mensaje no reconocido en paso 1
  respuesta = 'Escribe *sí* para empezar con Neto o *no* si prefieres pensarlo.';
  await enviarWhatsapp(from, respuesta);
  return;
}

// Paso 2: Esperando comprobante de pago
if (usuario.onboarding_paso === 2 && !cmd.startsWith('/')) {
  // Si envía imagen (comprobante Yape), se maneja en el handler de imágenes
  // Si envía texto, recordar que esperamos el comprobante
  if (cmd === '1' || cmd === 'mensual') {
    await supabase.from('usuarios').update({ tipo_plan: 'mensual' }).eq('id', usuario.id);
    respuesta = '✅ Plan *mensual* (S/10/mes).\n\n📲 Yapea S/10 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    await enviarWhatsapp(from, respuesta);
    return;
  } else if (cmd === '2' || cmd === 'anual') {
    await supabase.from('usuarios').update({ tipo_plan: 'anual' }).eq('id', usuario.id);
    respuesta = '✅ Plan *anual* (S/99/año — 2 meses gratis).\n\n📲 Yapea S/99 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  respuesta = 'Elige tu plan:\n\n1️⃣ *Mensual* — S/10\n2️⃣ *Anual* — S/99\n\nO envíame la captura de tu Yape si ya pagaste. 📸';
  await enviarWhatsapp(from, respuesta);
  return;
}

// Paso 3: Pago confirmado, esperando Gmail
if (usuario.onboarding_paso === 3 && !cmd.startsWith('/')) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const posibleEmail = cmd.trim().toLowerCase();
  if (emailRegex.test(posibleEmail)) {
    await supabase.from('usuarios').update({ email: posibleEmail }).eq('id', usuario.id);
    // Notificar al admin
    const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
    await enviarWhatsapp(ADMIN_NUMBER,
      '📧 *Nuevo correo para GCC:*\n' +
      'Usuario: ' + (usuario.nombre || from) + '\n' +
      'Email: ' + posibleEmail + '\n' +
      'Plan: ' + (usuario.tipo_plan || 'mensual') + '\n\n' +
      '1. Agregar a Google Cloud Console\n' +
      '2. Enviar: /aprobar ' + posibleEmail
    );
    respuesta = '✅ *Correo recibido:* ' + posibleEmail + '\n\nEstamos configurando tu cuenta. Te avisaremos en unos minutos cuando esté lista. ⏳';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  respuesta = 'Envíame tu correo *Gmail* para conectar tus bancos.\n\nEj: tucorreo@gmail.com';
  await enviarWhatsapp(from, respuesta);
  return;
}
```

- [ ] **Step 3: Verify the code compiles and indentation is correct**

Read back the modified section of index.js to confirm no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: new paid onboarding flow (states 1-3: pitch → payment → email)"
```

---

### Task 3: Backend — Admin commands `/pago` and `/aprobar`

**Files:**
- Modify: `index.js` (after the existing `/activar` command, ~line 1032)

- [ ] **Step 1: Add `/pago` command**

Add after the `/activar` command block (after line 1032):

```javascript
} else if (cmd.startsWith('/pago ')) {
  // Admin: /pago +51999888777 mensual|anual
  const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
  if (from !== ADMIN_NUMBER) {
    respuesta = 'No tienes permiso para usar este comando.';
  } else {
    const partes = cmd.replace('/pago ', '').trim().split(/\s+/);
    const numeroPago = (partes[0] || '').replace(/\+/g, '');
    const tipoPlan = partes[1] || 'mensual';
    const { data: usuarioPago } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroPago).single();
    if (!usuarioPago) {
      respuesta = '❌ No encontré un usuario con el número: ' + numeroPago;
    } else {
      const hoy = new Date();
      const mesesAdd = tipoPlan === 'anual' ? 12 : 1;
      const vence = new Date(hoy.getFullYear(), hoy.getMonth() + mesesAdd, hoy.getDate());
      await supabase.from('usuarios').update({
        plan: 'premium',
        estado_pago: 'pagado',
        tipo_plan: tipoPlan,
        fecha_pago: hoy.toISOString(),
        fecha_vencimiento: vence.toISOString(),
        premium_desde: hoy.toISOString().split('T')[0],
        premium_vence: vence.toISOString().split('T')[0],
        pago_pendiente: false,
        onboarding_paso: 3
      }).eq('id', usuarioPago.id);
      // Notificar al usuario
      await enviarWhatsapp(usuarioPago.whatsapp,
        '✅ *¡Pago confirmado!*\n\n' +
        'Plan: *' + (tipoPlan === 'anual' ? 'Anual (S/99/año)' : 'Mensual (S/10/mes)') + '*\n' +
        'Vence: ' + vence.toISOString().split('T')[0] + '\n\n' +
        'Ahora necesito tu correo *Gmail* para conectar tus bancos.\n\n' +
        '📧 Envíame tu correo aquí (ej: tucorreo@gmail.com)'
      );
      respuesta = '✅ Pago confirmado para ' + (usuarioPago.nombre || numeroPago) + ' (' + tipoPlan + ')\nUsuario en paso 3: esperando Gmail.';
    }
  }
```

- [ ] **Step 2: Add `/aprobar` command**

Add right after the `/pago` block:

```javascript
} else if (cmd.startsWith('/aprobar ')) {
  // Admin: /aprobar correo@gmail.com
  const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
  if (from !== ADMIN_NUMBER) {
    respuesta = 'No tienes permiso para usar este comando.';
  } else {
    const emailAprobar = cmd.replace('/aprobar ', '').trim().toLowerCase();
    const { data: usuarioAprobar } = await supabase.from('usuarios').select('*').eq('email', emailAprobar).single();
    if (!usuarioAprobar) {
      respuesta = '❌ No encontré un usuario con el correo: ' + emailAprobar;
    } else {
      await supabase.from('usuarios').update({
        aprobado_gcc: true,
        onboarding_paso: 10
      }).eq('id', usuarioAprobar.id);
      // Enviar link OAuth al usuario
      const urlOAuth = generarUrlAutorizacion(usuarioAprobar.whatsapp);
      await enviarWhatsapp(usuarioAprobar.whatsapp,
        '🎉 *¡Tu cuenta está lista!*\n\n' +
        'Conecta tu Gmail para que Neto lea tus correos bancarios automáticamente:\n\n' +
        '🔗 ' + urlOAuth + '\n\n' +
        '_Solo leemos notificaciones bancarias. Sin contraseñas bancarias._'
      );
      respuesta = '✅ Aprobado ' + emailAprobar + ' en GCC.\nLink OAuth enviado al usuario.';
    }
  }
```

- [ ] **Step 3: Update `/ayuda` admin section**

In the `/ayuda` command (line 1068-1070), add the new commands to the help text. After `*/premium*`:

```
\n*/pago <num> <mensual|anual>* -- confirmar pago (admin)\n*/aprobar <email>* -- aprobar Gmail (admin)
```

- [ ] **Step 4: Update `/admin` panel to show payment states**

In the admin panel section (~line 1033-1057), update the user list to show payment status:

Replace the forEach line (1049-1053):
```javascript
todos.slice(0, 10).forEach(u => {
  const plan = u.plan === 'premium' ? '⭐' : '🟢';
  const pend = u.pago_pendiente ? ' 💸' : '';
  const estado = u.estado_pago === 'pagado' ? '' : (u.estado_pago === 'pendiente' ? ' ⏳' : '');
  msg += plan + ' ' + (u.nombre || u.whatsapp) + pend + estado + '\n';
});
```

Update the footer hint:
```javascript
msg += '\n_Comandos admin:_\n/pago <num> <mensual|anual>\n/aprobar <email>\n/activar <num>';
```

- [ ] **Step 5: Handle image receipt in paso 2**

In the image handler section of index.js (wherever Yape/Plin image OCR is handled), add a check: if `usuario.onboarding_paso === 2`, treat the image as a payment receipt and notify admin.

Search for the image handling code and add:
```javascript
if (usuario.onboarding_paso === 2) {
  // Payment receipt image — notify admin
  const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
  await enviarWhatsapp(ADMIN_NUMBER,
    '💸 *Comprobante de pago recibido:*\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Plan solicitado: ' + (usuario.tipo_plan || 'mensual') + '\n\n' +
    'Verificar y enviar: /pago ' + from + ' ' + (usuario.tipo_plan || 'mensual')
  );
  await enviarWhatsapp(from,
    '📸 *Comprobante recibido.*\n\nEstamos verificando tu pago. Te confirmaremos en breve. ⏳'
  );
  return res.sendStatus(200);
}
```

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: admin commands /pago and /aprobar for manual payment flow"
```

---

### Task 4: Backend — Remove freemium flag, update constants

**Files:**
- Modify: `lib/constants.js`

- [ ] **Step 1: Set FREEMIUM_ACTIVE to false and simplify PLAN_CONFIG**

The `FREEMIUM_ACTIVE` flag is already `false` (line 46). No change needed there.

Update PLAN_CONFIG to make both plans identical (all users are premium now):

```javascript
// All users are paid — no free tier limits
const PLAN_CONFIG = {
  free: {
    historyMonths: null,
    reportesPerMonth: Infinity,
    excelUpload: true,
    dashboardTTL: 24,
    weeklyResumen: 'full',
    scoreFinanciero: 'full',
    resumenDiario: true,
    recordatorios: true,
    maxPresupuestos: Infinity,
    maxMetas: Infinity,
    maxGmailAccounts: Infinity,
    ocrPerMonth: Infinity,
    consejoPerWeek: Infinity,
    csvExport: true,
  },
  premium: {
    historyMonths: null,
    reportesPerMonth: Infinity,
    excelUpload: true,
    dashboardTTL: 24,
    weeklyResumen: 'full',
    scoreFinanciero: 'full',
    resumenDiario: true,
    recordatorios: true,
    maxPresupuestos: Infinity,
    maxMetas: Infinity,
    maxGmailAccounts: Infinity,
    ocrPerMonth: Infinity,
    consejoPerWeek: Infinity,
    csvExport: true,
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add lib/constants.js
git commit -m "feat: remove free tier limits — all users get premium features"
```

---

### Task 5: Landing — Remove free plan, update Pricing

**Files:**
- Modify: `landing/src/components/Pricing.tsx`

- [ ] **Step 1: Rewrite Pricing component**

Replace the entire Pricing component. Key changes:
- Remove the free plan card entirely
- Single Pro plan card centered with monthly/annual toggle
- Update subtitle from "Empieza gratis" to emphasize value
- Price: S/10/mes or S/99/año with toggle
- Keep the 18-feature comparison as a single checklist (all included)
- Badge: "PRECIO FUNDADOR"
- CTA: "Empezar ahora" → WhatsApp

```tsx
"use client";

import { useState } from "react";
import { Check, Crown } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const FEATURES = [
  "WhatsApp: registro, gastos y consultas",
  "Lectura automática de correos bancarios",
  "Clasificación automática con IA",
  "Categorías personalizables",
  "Presupuestos ilimitados",
  "Dashboard web interactivo con historial completo",
  "Resumen semanal con IA (insights + comparativa)",
  "Resumen mensual",
  "Lectura de imágenes Yape/Plin ilimitada",
  "Score financiero con desglose + tendencia",
  "Suscripciones detectadas + alertas",
  "Metas de ahorro ilimitadas",
  "Consejo IA personalizado diario",
  "Resumen diario por WhatsApp",
  "Reportes PDF descargables",
  "Calendario financiero",
  "Export CSV/JSON + carga masiva",
  "Recordatorios diarios (8 pm)",
];

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="precios" className="py-28 relative overflow-hidden">
      <div className="absolute top-[10%] left-[50%] -translate-x-1/2 w-[800px] h-[600px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[150px]" />

      <div className="mx-auto max-w-[1100px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Precios
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Simple y transparente.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[480px] mx-auto text-lg leading-relaxed">
            Todo incluido. Sin funciones bloqueadas.
          </p>

          {/* Toggle mensual/anual */}
          <div className="mt-8 inline-flex items-center gap-3 rounded-full bg-[#1C1C19] p-1.5">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                !annual ? "bg-[#1D9E75] text-white" : "text-[#87948c] hover:text-[#bccac1]"
              }`}
            >
              Mensual
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                annual ? "bg-[#1D9E75] text-white" : "text-[#87948c] hover:text-[#bccac1]"
              }`}
            >
              Anual
              <span className="ml-1.5 text-xs text-[#68dbae]">-17%</span>
            </button>
          </div>
        </div>

        {/* Single pricing card */}
        <div className="max-w-[500px] mx-auto">
          <div className="group relative rounded-[24px] overflow-hidden transition-all duration-300 cursor-default">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#68dbae]/30 via-[#1D9E75]/20 to-[#0F6E56]/30" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-[#1D9E75]/20 blur-[60px] -z-0" />

            <div className="relative p-8 flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#1D9E75]/20 flex items-center justify-center">
                    <Crown size={20} className="text-[#68dbae]" />
                  </div>
                  <h3 className="text-xl font-bold text-[#e5e2de]">Neto Pro</h3>
                </div>
                <span className="rounded-full bg-[#EF9F27] px-3 py-1 text-xs font-bold text-[#0E0E0C]">
                  PRECIO FUNDADOR
                </span>
              </div>

              {/* Price */}
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">
                  {annual ? "S/99" : "S/10"}
                </span>
                <span className="text-sm text-[#87948c]">
                  {annual ? "/año" : "/mes"}
                </span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">
                {annual
                  ? "Equivale a S/8.25/mes — 2 meses gratis"
                  : "Cancela cuando quieras"}
              </p>

              {/* Features */}
              <ul className="space-y-3 mb-8">
                {FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-[#1D9E75]/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Check size={12} className="text-[#1D9E75]" />
                    </div>
                    <span className="text-sm text-[#bccac1]">{f}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] text-[#002115] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer block"
              >
                Empezar ahora
              </a>

              <p className="text-center text-xs text-[#87948c] mt-4">
                Paga con Yape · Setup en 5 min
              </p>
            </div>
          </div>
        </div>

        {/* Bottom note */}
        <div className="mt-12 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#1C1C19] px-5 py-2.5">
            <span className="text-sm text-[#87948c]">
              ¿Tu banco no está en la lista?
            </span>
            <a href="/contacto" className="text-sm font-medium text-[#68dbae] hover:text-[#1D9E75] transition-colors cursor-pointer">
              Escríbenos
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add landing/src/components/Pricing.tsx
git commit -m "feat(landing): single paid plan pricing with monthly/annual toggle"
```

---

### Task 6: Landing — Update all "gratis" references

**Files:**
- Modify: `landing/src/components/Navbar.tsx` (lines 59, 98)
- Modify: `landing/src/components/Hero.tsx` (line 12, 80)
- Modify: `landing/src/components/FinalCTA.tsx` (line 34)
- Modify: `landing/src/components/StickyCTA.tsx` (line 28)
- Modify: `landing/src/components/ExitIntent.tsx` (line 99)
- Modify: `landing/src/components/Referral.tsx` (lines 18, 50)
- Modify: `landing/src/components/Testimonials.tsx` (line 217)

- [ ] **Step 1: Navbar.tsx — Change "Empezar gratis" to "Empezar ahora"**

Line 59: `Empezar gratis` → `Empezar ahora`
Line 98: `Empezar gratis` → `Empezar ahora`

- [ ] **Step 2: Hero.tsx — Remove "S/0" stat and update CTA**

Line 12: Change STATS array — remove `{ label: "Para empezar", value: "S/0", accent: false }` and replace with `{ label: "Desde", value: "S/10/mes", accent: false }`.

Line 80: "Conecta tu banco en 2 min" — keep as is (still accurate).

- [ ] **Step 3: FinalCTA.tsx — Remove "Gratis" text**

Line 34: `Gratis · Sin tarjeta · Sin contraseña bancaria` → `Setup en 5 min · Sin contraseña bancaria`

- [ ] **Step 4: StickyCTA.tsx — Remove "Gratis" text**

Line 28: `Gratis · 2 min setup` → `Desde S/10/mes`

- [ ] **Step 5: ExitIntent.tsx — Remove "gratis" text**

Line 99: `Descubre cuánto pierdes cada mes — gratis, por WhatsApp.` → `Descubre cuánto pierdes cada mes — por WhatsApp.`

- [ ] **Step 6: Referral.tsx — Update referral messaging**

Line 18: `Ellos empiezan gratis` → `Ellos reciben 1 mes gratis` (referrals still get a benefit)
Line 50: `gana Pro gratis` → keep as is (referral reward is still valid)

- [ ] **Step 7: Testimonials.tsx — Update CTA**

Line 217: `Empieza gratis hoy.` → `Empieza hoy.`

- [ ] **Step 8: Commit**

```bash
git add landing/src/components/Navbar.tsx landing/src/components/Hero.tsx landing/src/components/FinalCTA.tsx landing/src/components/StickyCTA.tsx landing/src/components/ExitIntent.tsx landing/src/components/Referral.tsx landing/src/components/Testimonials.tsx
git commit -m "feat(landing): remove all 'gratis' references — paid-only model"
```

---

### Task 7: Webapp — Remove free tier UI, update pricing

**Files:**
- Modify: `webapp/src/lib/plan.ts`
- Modify: `webapp/src/lib/types.ts`
- Modify: `webapp/src/components/shared/upgrade-prompt.tsx`
- Modify: `webapp/src/app/dashboard/configuracion/page.tsx`

- [ ] **Step 1: Update plan.ts — Remove free limits**

All users are premium. Simplify:

```typescript
export type PlanType = 'free' | 'premium';

// ... keep PlanFeature type ...

/** No features are Pro-only anymore — all users are paid */
const PRO_ONLY_FEATURES: PlanFeature[] = [];

/** No free limits — all users get full access */
export const FREE_LIMITS = {
  budgets: Infinity,
  goals: Infinity,
  ocr_per_month: Infinity,
  gmail_accounts: Infinity,
  advice_per_week: Infinity,
} as const;
```

- [ ] **Step 2: Update types.ts — Add new fields**

Add to the Usuario interface:

```typescript
export interface Usuario {
  id: string;
  whatsapp: string;
  nombre?: string;
  email?: string;
  plan: 'free' | 'premium';
  plan_expiry?: string;
  premium_vence?: string;
  estado_pago?: 'pendiente' | 'pagado' | 'vencido';
  tipo_plan?: 'mensual' | 'anual';
  fecha_pago?: string;
  fecha_vencimiento?: string;
  aprobado_gcc?: boolean;
  supabase_auth_id?: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Update upgrade-prompt.tsx — Fix pricing**

Line 30: `Activar Pro — S/6/mes` → `Activar Pro — S/10/mes`
Line 34: `S/69/año (42% de ahorro)` → `S/99/año (2 meses gratis)`
Line 50: `Activar Pro — S/6/mes` → `Activar Pro — S/10/mes`
Line 54: `S/69/año (42% de ahorro) · Paga con Yape` → `S/99/año (2 meses gratis) · Paga con Yape`

- [ ] **Step 4: Update configuracion/page.tsx — Remove free/pro comparison table**

In the "Tu plan" section (~lines 265-285), instead of showing the comparison table, show:
- Plan actual: "Pro" (everyone is pro)
- Tipo: Mensual/Anual
- Vence: fecha_vencimiento
- Remove the Free vs Premium comparison table entirely

Replace the table section with a simple plan status display.

Also update:
- Line 214: Remove the "Free" badge case — all users show Premium
- Line 254: `Upgrade a Premium — S/10/mes o S/69/año` → `S/10/mes o S/99/año`

- [ ] **Step 5: Commit**

```bash
git add webapp/src/lib/plan.ts webapp/src/lib/types.ts webapp/src/components/shared/upgrade-prompt.tsx webapp/src/app/dashboard/configuracion/page.tsx
git commit -m "feat(webapp): remove free tier UI, update to paid-only model"
```

---

### Task 8: Landing — Update JSON-LD pricing schema

**Files:**
- Modify: `landing/src/app/layout.tsx` or wherever JSON-LD is defined

- [ ] **Step 1: Search for JSON-LD SoftwareApplication or pricing schema**

```bash
grep -rn "offers" landing/src/ --include="*.tsx" --include="*.ts"
```

- [ ] **Step 2: Update any JSON-LD pricing from "0" to "10"**

If there's a schema with `"price": "0"`, update to `"price": "10"` and add the annual option.

- [ ] **Step 3: Commit**

```bash
git add landing/src/
git commit -m "fix(landing): update JSON-LD pricing schema to paid-only"
```

---

### Task 9: Verify and deploy

- [ ] **Step 1: Build landing page**

```bash
cd C:/Neto.pe/landing && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Build webapp**

```bash
cd C:/Neto.pe/webapp && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Run backend tests**

```bash
cd C:/Neto.pe && npx vitest run
```

Expected: All 56 tests pass.

- [ ] **Step 4: Manual verification checklist**

- [ ] Landing: No "gratis" or "S/0" visible anywhere
- [ ] Landing: Pricing shows single card with monthly/annual toggle
- [ ] Landing: All CTAs go to WhatsApp
- [ ] Webapp: No free plan comparison table
- [ ] Webapp: Upgrade prompt shows S/10/mes, S/99/año
- [ ] Backend: `/pago` and `/aprobar` commands work from admin number
- [ ] Backend: New onboarding flow sends correct messages per state

- [ ] **Step 5: Deploy landing**

Use `/deploy-landing` skill or push to trigger Cloudflare Pages auto-deploy.

- [ ] **Step 6: Final commit with all changes**

```bash
git add -A
git commit -m "feat: complete migration to paid-only model (S/10/mes, S/99/año)"
```
