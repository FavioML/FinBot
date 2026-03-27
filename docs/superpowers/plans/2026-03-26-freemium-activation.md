# Freemium Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the freemium model across backend, webapp, and landing — where Gmail OAuth is Pro-only (to conserve 100 OAuth slots) and Free users can use Neto manually.

**Architecture:** The infrastructure already exists but is disabled (FREEMIUM_ACTIVE=false, all limits=Infinity, PRO_ONLY_FEATURES=[]). We activate enforcement by flipping constants and adding gates where missing. Free users register via WhatsApp or webapp without OAuth. Pro users pay, then get OAuth link.

**Tech Stack:** Node.js backend (index.js, lib/constants.js), Next.js 16 webapp (plan.ts, pages), React landing (Pricing.tsx)

**Key constraint:** Only 100 OAuth slots available in GCC. Gmail OAuth = Pro-only feature to conserve slots.

---

## File Structure

### Files to MODIFY:
1. `lib/constants.js` — Flip FREEMIUM_ACTIVE=true, set real free limits in PLAN_CONFIG
2. `webapp/src/lib/plan.ts` — Set real PRO_ONLY_FEATURES and FREE_LIMITS
3. `webapp/src/app/api/budgets/route.ts` — Change FREE_BUDGET_LIMIT from Infinity to 3
4. `webapp/src/app/api/goals/route.ts` — Change FREE_GOAL_LIMIT from Infinity to 1
5. `webapp/src/app/api/advice/route.ts` — Add plan-based rate differentiation
6. `webapp/src/app/api/export/route.ts` — Add Pro gate
7. `webapp/src/app/api/notifications/route.ts` — Add Pro gate for recordatorios
8. `webapp/src/app/dashboard/reportes/page.tsx` — Add Pro gate for PDF download
9. `webapp/src/app/dashboard/configuracion/page.tsx` — Fix hardcoded "Neto Pro" badge
10. `index.js` — Update onboarding flow for freemium (Free path + Pro path), gate /conectar
11. `landing/src/components/Pricing.tsx` — Two-column Free vs Pro pricing

### Files to CREATE:
12. `webapp/src/components/shared/pro-gate.tsx` — Reusable upgrade prompt component

---

## Task 1: Backend — Activate FREEMIUM_ACTIVE and set real limits

**Files:**
- Modify: `lib/constants.js:46-81`

- [ ] **Step 1: Set FREEMIUM_ACTIVE=true and configure free plan limits**

```javascript
// In lib/constants.js, replace lines 46-81:

const FREEMIUM_ACTIVE = true;

const PLAN_CONFIG = {
  free: {
    historyMonths: 1,        // Solo mes actual
    reportesPerMonth: 0,     // Sin PDF
    excelUpload: false,       // Sin carga masiva
    dashboardTTL: 1,          // 1 hora
    weeklyResumen: 'basic',   // Solo total gastado
    scoreFinanciero: 'number', // Solo número, sin desglose
    resumenDiario: false,     // Sin resumen diario
    recordatorios: false,     // Sin recordatorios
    maxPresupuestos: 3,       // 3 presupuestos
    maxMetas: 1,              // 1 meta
    maxGmailAccounts: 0,      // Sin Gmail (OAuth = Pro only)
    ocrPerMonth: 5,           // 5 imágenes/mes
    consejoPerWeek: 1,        // 1 consejo/semana
    csvExport: false,         // Sin export
  },
  premium: {
    historyMonths: null,      // Ilimitado
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

- [ ] **Step 2: Run backend tests**

Run: `npx vitest run`
Expected: 55/56 pass (1 pre-existing date test failure)

- [ ] **Step 3: Commit**

```bash
git add lib/constants.js
git commit -m "feat(freemium): activate FREEMIUM_ACTIVE with real plan limits"
```

---

## Task 2: Webapp — Set real PRO_ONLY_FEATURES and FREE_LIMITS

**Files:**
- Modify: `webapp/src/lib/plan.ts:20-30`

- [ ] **Step 1: Update PRO_ONLY_FEATURES and FREE_LIMITS**

```typescript
// Replace lines 20-30 in plan.ts:

/** Features only available on Pro plan */
const PRO_ONLY_FEATURES: PlanFeature[] = [
  'reports_pdf',
  'calendar',
  'heatmap',
  'export',
  'excel_upload',
  'score_breakdown',
  'daily_summary',
  'daily_reminder',
  'advice_daily',
  'custom_categories',
];

/** Free plan limits for counted features */
export const FREE_LIMITS = {
  budgets: 3,
  goals: 1,
  ocr_per_month: 5,
  gmail_accounts: 0,
  advice_per_week: 1,
} as const;
```

- [ ] **Step 2: Verify build compiles**

Run: `cd webapp && npx next build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add webapp/src/lib/plan.ts
git commit -m "feat(freemium): activate PRO_ONLY_FEATURES and FREE_LIMITS in webapp"
```

---

## Task 3: Webapp — Create reusable ProGate component

**Files:**
- Create: `webapp/src/components/shared/pro-gate.tsx`

- [ ] **Step 1: Create the ProGate component**

```tsx
'use client';

import { Lock, Crown } from 'lucide-react';

const WA_LINK =
  'https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90';

interface ProGateProps {
  feature: string;
  description?: string;
  children?: React.ReactNode;
}

/** Overlay/message shown when a Free user tries to access a Pro feature */
export function ProGate({ feature, description }: ProGateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-[#1D9E75]/10 flex items-center justify-center">
        <Lock className="h-7 w-7 text-[#1D9E75]" />
      </div>
      <h3 className="text-lg font-semibold text-[#F0EFE8]">{feature}</h3>
      <p className="text-sm text-[#8A877D] max-w-sm">
        {description || 'Esta función está disponible en el plan Pro.'}
      </p>
      <a
        href={WA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-full bg-[#1D9E75] px-6 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#178a64]"
      >
        <Crown className="h-4 w-4" />
        Activar Neto Pro
      </a>
      <p className="text-xs text-[#8A877D]">S/10/mes · Cancela cuando quieras</p>
    </div>
  );
}

/** Inline badge for upgrade prompts inside existing UI */
export function ProBadge({ message }: { message?: string }) {
  return (
    <a
      href={WA_LINK}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full bg-[#1D9E75]/15 px-3 py-1 text-xs font-medium text-[#68dbae] hover:bg-[#1D9E75]/25 transition-colors"
    >
      <Crown className="h-3 w-3" />
      {message || 'Pro'}
    </a>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add webapp/src/components/shared/pro-gate.tsx
git commit -m "feat(freemium): add reusable ProGate and ProBadge components"
```

---

## Task 4: Webapp API — Activate budget and goal limits

**Files:**
- Modify: `webapp/src/app/api/budgets/route.ts:33`
- Modify: `webapp/src/app/api/goals/route.ts` (similar line)

- [ ] **Step 1: Fix budgets API limit**

In `webapp/src/app/api/budgets/route.ts`, change line 33:
```typescript
// OLD:
const FREE_BUDGET_LIMIT = Infinity; // No free plan — all users have full access

// NEW:
const FREE_BUDGET_LIMIT = 3;
```

Also update the error message at line 50:
```typescript
// OLD:
{ error: 'Límite de presupuestos alcanzado. Contacta soporte por WhatsApp.', upgrade: false },

// NEW:
{ error: 'Plan Free permite máximo 3 presupuestos. Activa Pro para presupuestos ilimitados.', upgrade: true },
```

- [ ] **Step 2: Fix goals API limit**

In `webapp/src/app/api/goals/route.ts`, find the equivalent FREE_GOAL_LIMIT and change:
```typescript
// OLD:
const FREE_GOAL_LIMIT = Infinity;

// NEW:
const FREE_GOAL_LIMIT = 1;
```

Update error message similarly:
```typescript
{ error: 'Plan Free permite 1 meta de ahorro. Activa Pro para metas ilimitadas.', upgrade: true },
```

- [ ] **Step 3: Verify build**

Run: `cd webapp && npx next build`

- [ ] **Step 4: Commit**

```bash
git add webapp/src/app/api/budgets/route.ts webapp/src/app/api/goals/route.ts
git commit -m "feat(freemium): activate budget (3) and goal (1) limits for free plan"
```

---

## Task 5: Webapp API — Add Pro gate to export route

**Files:**
- Modify: `webapp/src/app/api/export/route.ts`

- [ ] **Step 1: Read the file first to understand structure**

- [ ] **Step 2: Add plan check at the top of the GET handler**

After getting the netoUser, add:
```typescript
if (netoUser.plan !== 'premium') {
  return NextResponse.json(
    { error: 'Exportar datos es una función Pro. Activa Pro por WhatsApp.', upgrade: true },
    { status: 403 },
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add webapp/src/app/api/export/route.ts
git commit -m "feat(freemium): gate CSV/JSON export behind Pro plan"
```

---

## Task 6: Webapp — Add Pro gate to Reportes PDF page

**Files:**
- Modify: `webapp/src/app/dashboard/reportes/page.tsx`

- [ ] **Step 1: Read relevant section of reportes page**

Find where the PDF download button is rendered and where the user object is available.

- [ ] **Step 2: Import ProGate and canAccess, wrap PDF generation behind Pro check**

At the top of the file, add imports:
```typescript
import { canAccess } from '@/lib/plan';
import { ProGate } from '@/components/shared/pro-gate';
```

In the render section, before the report content, add:
```tsx
if (!canAccess(user?.plan, 'reports_pdf')) {
  return (
    <ProGate
      feature="Reportes PDF"
      description="Descarga reportes detallados con gráficos, score financiero y análisis de tus finanzas. Disponible en Pro."
    />
  );
}
```

- [ ] **Step 3: Verify build**

Run: `cd webapp && npx next build`

- [ ] **Step 4: Commit**

```bash
git add webapp/src/app/dashboard/reportes/page.tsx
git commit -m "feat(freemium): gate PDF reports behind Pro plan"
```

---

## Task 7: Webapp — Fix configuracion page plan badge

**Files:**
- Modify: `webapp/src/app/dashboard/configuracion/page.tsx:207-210`

- [ ] **Step 1: Replace hardcoded Pro badge with conditional**

```tsx
// OLD (lines 207-210):
<Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 gap-1 shrink-0">
  <Crown className="h-3 w-3" />
  Neto Pro
</Badge>

// NEW:
{user.plan === 'premium' ? (
  <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 gap-1 shrink-0">
    <Crown className="h-3 w-3" />
    Neto Pro
  </Badge>
) : (
  <Badge className="bg-[#87948c]/20 text-[#87948c] border-[#87948c]/30 gap-1 shrink-0">
    Free
  </Badge>
)}
```

- [ ] **Step 2: Add an upgrade section for Free users in the plan area**

Find the plan section in configuracion and add below the badge for free users:
```tsx
{user.plan !== 'premium' && (
  <div className="mt-4 rounded-xl border border-[#1D9E75]/20 bg-[#1D9E75]/5 p-4">
    <div className="flex items-center gap-2 mb-2">
      <Crown className="h-4 w-4 text-[#1D9E75]" />
      <span className="text-sm font-semibold text-[#F0EFE8]">Activa Neto Pro</span>
    </div>
    <p className="text-xs text-[#8A877D] mb-3">
      Gmail automático, reportes PDF, presupuestos ilimitados, metas, calendario y más.
    </p>
    <a
      href="https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-full bg-[#1D9E75] px-4 py-2 text-xs font-semibold text-white hover:bg-[#178a64] transition-colors"
    >
      Activar Pro — S/10/mes
    </a>
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add webapp/src/app/dashboard/configuracion/page.tsx
git commit -m "feat(freemium): show correct plan badge and upgrade CTA for free users"
```

---

## Task 8: Backend — Update onboarding flow for freemium

**Files:**
- Modify: `index.js` (onboarding section ~lines 860-1023)

The new flow is:
- User says "hola" → Neto pitch with TWO options:
  1. **Free**: registro manual inmediato (no pago, no OAuth)
  2. **Pro**: pago → Gmail OAuth
- `/manual` command stays (Free path shortcut)
- `/conectar` gated: only Pro users can generate OAuth link

- [ ] **Step 1: Update the "hola" welcome message (line ~977-989)**

```javascript
// Replace the welcome message for new users (onboarding_paso not completed):
if (!tieneGmail && !usuario.onboarding_completado) {
  await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
  respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy *NETO*, tu asistente financiero.\n\n' +
    '📊 *¿Qué hace Neto?*\n' +
    '• Te dice en qué gastas tu plata por WhatsApp\n' +
    '• Dashboard con gráficos, metas y reportes\n' +
    '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
    '🆓 *Plan Free* — S/0\n' +
    '• Registra gastos manual o por foto\n' +
    '• 3 presupuestos, 1 meta de ahorro\n' +
    '• Dashboard del mes actual\n\n' +
    '⭐ *Plan Pro* — S/10/mes\n' +
    '• Lectura automática de correos bancarios\n' +
    '• Todo ilimitado + reportes PDF\n\n' +
    'Escribe *free* para empezar gratis o *pro* para activar Pro.';
}
```

- [ ] **Step 2: Update onboarding paso 1 to handle "free" and "pro" responses (line ~861)**

```javascript
if (usuario.onboarding_paso === 1 && !cmd.startsWith('/')) {
  const resp1 = cmd.trim().toLowerCase();
  // Free path — immediate activation
  if (resp1 === 'free' || resp1 === 'gratis' || resp1 === 'manual') {
    await supabase.from('usuarios').update({
      plan: 'free',
      onboarding_paso: 10,
      onboarding_completado: true
    }).eq('id', usuario.id);
    var menuCats = CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n');
    respuesta = '🆓 *¡Bienvenido a Neto Free!*\n\n' +
      'Personaliza tus categorías:\n\n' + menuCats + '\n\n' +
      '_Escribe los números separados por espacio (ej: 1 3 5) o "todas"._';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  // Pro path — payment flow
  if (resp1 === 'pro' || resp1 === 'si' || resp1 === 'sí' || resp1 === 'yes' || resp1 === 'dale' || resp1 === 'va' || resp1 === 'quiero') {
    await supabase.from('usuarios').update({ onboarding_paso: 2 }).eq('id', usuario.id);
    respuesta = '🎉 *¡Genial!*\n\n' +
      'Elige tu plan:\n\n' +
      '1️⃣ *Mensual* — S/10/mes\n' +
      '2️⃣ *Anual* — S/99/año (2 meses gratis)\n\n' +
      '📲 *Yapea al:* 970398192\n' +
      '👤 *A nombre de:* Favio Mendoza\n\n' +
      'Después envíame la captura del Yape aquí. 📸';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  if (resp1 === 'no' || resp1 === 'no gracias') {
    await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
    respuesta = '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';
    await enviarWhatsapp(from, respuesta);
    return;
  }
  respuesta = 'Escribe *free* para empezar gratis o *pro* para activar el plan Pro.';
  await enviarWhatsapp(from, respuesta);
  return;
}
```

- [ ] **Step 3: Gate /conectar command to Pro users only (line ~1022)**

```javascript
} else if (cmd === '/conectar') {
  if (usuario.plan !== 'premium') {
    respuesta = '⭐ *Conectar Gmail es una función Pro.*\n\n' +
      'Con Pro, Neto lee tus correos bancarios automáticamente.\n\n' +
      '💰 S/10/mes o S/99/año\n' +
      '📲 Yapea al 970398192 y escríbeme aquí para activar.';
  } else {
    respuesta = 'Para conectar tu Gmail, abre este enlace:\n\n' + generarUrlAutorizacion(from) + '\n\n_Solo leemos notificaciones bancarias. Sin contrasenas bancarias._';
  }
```

- [ ] **Step 4: Update /manual command to set plan='free' explicitly (line ~1010)**

```javascript
} else if (cmd === '/manual') {
  await supabase.from('usuarios').update({ plan: 'free', onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
  respuesta = '✍️ *Modo Free activado*\n\nRegistra gastos así:\n📝 _"gasté 50 en taxi"_\n📸 Envía una foto de Yape o Plin\n\n📊 *Tu dashboard:* app.neto.pe\n\n¿Por dónde empezamos?';
```

- [ ] **Step 5: Run backend tests**

Run: `npx vitest run`
Expected: 55/56 pass

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(freemium): update WhatsApp onboarding with Free/Pro paths, gate /conectar"
```

---

## Task 9: Landing — Two-column Free vs Pro pricing

**Files:**
- Modify: `landing/src/components/Pricing.tsx`

- [ ] **Step 1: Replace single Pro card with Free + Pro comparison**

Replace the entire Pricing.tsx content:

```tsx
"use client";

import { useState } from "react";
import { Check, X, Crown } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";
const WA_PRO_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90";
const APP_LINK = "https://app.neto.pe";

interface Feature {
  name: string;
  free: string | boolean;
  pro: string | boolean;
}

const FEATURES: Feature[] = [
  { name: "WhatsApp: registro de gastos", free: true, pro: true },
  { name: "Dashboard web", free: "Mes actual", pro: "Historial completo" },
  { name: "Clasificación automática con IA", free: true, pro: true },
  { name: "Categorías raíz (11)", free: true, pro: true },
  { name: "Categorías personalizadas", free: false, pro: true },
  { name: "Presupuestos", free: "3", pro: "Ilimitados" },
  { name: "Metas de ahorro", free: "1", pro: "Ilimitadas" },
  { name: "Lectura de imágenes Yape/Plin", free: "5/mes", pro: "Ilimitada" },
  { name: "Lectura automática de correos bancarios", free: false, pro: true },
  { name: "Múltiples cuentas Gmail", free: false, pro: true },
  { name: "Resumen semanal", free: "Básico", pro: "Completo con IA" },
  { name: "Resumen diario por WhatsApp", free: false, pro: true },
  { name: "Score financiero", free: "Número", pro: "Desglose + tendencia" },
  { name: "Reportes PDF descargables", free: false, pro: true },
  { name: "Calendario financiero", free: false, pro: true },
  { name: "Heatmap de gastos", free: false, pro: true },
  { name: "Consejo IA", free: "1/semana", pro: "Diario" },
  { name: "Export CSV/JSON + carga masiva", free: false, pro: true },
  { name: "Recordatorios diarios (8 pm)", free: false, pro: true },
  { name: "Multimoneda USD/PEN", free: true, pro: true },
  { name: "Referidos (3 = 1 mes Pro)", free: true, pro: true },
];

function FeatureCell({ value }: { value: string | boolean }) {
  if (value === true)
    return (
      <div className="w-5 h-5 rounded-full bg-[#1D9E75]/15 flex items-center justify-center">
        <Check size={12} className="text-[#1D9E75]" />
      </div>
    );
  if (value === false)
    return (
      <div className="w-5 h-5 rounded-full bg-[#87948c]/10 flex items-center justify-center">
        <X size={12} className="text-[#87948c]/50" />
      </div>
    );
  return <span className="text-xs text-[#bccac1]">{value}</span>;
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="precios" className="py-28 relative overflow-hidden">
      <div className="absolute top-[10%] left-[50%] -translate-x-1/2 w-[800px] h-[600px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[150px]" />

      <div className="mx-auto max-w-[900px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Precios
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Empieza gratis. Crece con Pro.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[520px] mx-auto text-lg leading-relaxed">
            Registra tus gastos sin costo. Activa Pro cuando quieras lectura automática de correos y todo ilimitado.
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

        {/* Two pricing cards */}
        <div className="grid min-[860px]:grid-cols-2 gap-6 mb-12">
          {/* FREE Card */}
          <div className="relative rounded-[24px] overflow-hidden">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#87948c]/20 via-[#87948c]/10 to-[#87948c]/5" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />

            <div className="relative p-8 flex flex-col h-full">
              <h3 className="text-xl font-bold text-[#e5e2de] mb-4">Free</h3>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">S/0</span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">Para siempre</p>

              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-[#87948c]/30 text-[#e5e2de] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:border-[#87948c]/60 cursor-pointer block mt-auto"
              >
                Empezar gratis
              </a>
            </div>
          </div>

          {/* PRO Card */}
          <div className="relative rounded-[24px] overflow-hidden">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#68dbae]/30 via-[#1D9E75]/20 to-[#0F6E56]/30" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-[#1D9E75]/20 blur-[60px] -z-0" />

            <div className="relative p-8 flex flex-col h-full">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Crown size={20} className="text-[#68dbae]" />
                  <h3 className="text-xl font-bold text-[#e5e2de]">Pro</h3>
                </div>
                <span className="rounded-full bg-[#EF9F27] px-3 py-1 text-xs font-bold text-[#0E0E0C]">
                  PRECIO FUNDADOR
                </span>
              </div>
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

              <a
                href={WA_PRO_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] text-[#002115] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer block mt-auto"
              >
                Activar Pro
              </a>
              <p className="text-center text-xs text-[#87948c] mt-4">
                Paga con Yape · Setup en 5 min
              </p>
            </div>
          </div>
        </div>

        {/* Feature comparison table */}
        <div className="rounded-[20px] border border-white/5 bg-[#131311] overflow-hidden">
          <div className="grid grid-cols-[1fr_80px_80px] min-[860px]:grid-cols-[1fr_120px_120px] items-center px-6 py-4 border-b border-white/5">
            <span className="text-xs font-medium text-[#87948c] uppercase tracking-wider">Función</span>
            <span className="text-xs font-medium text-[#87948c] uppercase tracking-wider text-center">Free</span>
            <span className="text-xs font-medium text-[#68dbae] uppercase tracking-wider text-center">Pro</span>
          </div>
          {FEATURES.map((f) => (
            <div
              key={f.name}
              className="grid grid-cols-[1fr_80px_80px] min-[860px]:grid-cols-[1fr_120px_120px] items-center px-6 py-3 border-b border-white/[0.03] last:border-0"
            >
              <span className="text-sm text-[#bccac1]">{f.name}</span>
              <div className="flex justify-center">
                <FeatureCell value={f.free} />
              </div>
              <div className="flex justify-center">
                <FeatureCell value={f.pro} />
              </div>
            </div>
          ))}
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

- [ ] **Step 2: Update Hero.tsx stat to say "Desde S/0"**

In `landing/src/components/Hero.tsx`, change the stat:
```typescript
// OLD:
{ label: "Desde", value: "S/10/mes", accent: false }
// NEW:
{ label: "Desde", value: "S/0 gratis", accent: false }
```

- [ ] **Step 3: Update StickyCTA.tsx to show free option**

In `landing/src/components/StickyCTA.tsx`, change:
```typescript
// OLD:
<p className="text-xs text-[#87948c]">Desde S/10/mes</p>
// NEW:
<p className="text-xs text-[#87948c]">Gratis · Pro desde S/10/mes</p>
```

- [ ] **Step 4: Verify landing builds**

Run: `cd landing && npm run build`

- [ ] **Step 5: Commit**

```bash
git add landing/src/components/Pricing.tsx landing/src/components/Hero.tsx landing/src/components/StickyCTA.tsx
git commit -m "feat(freemium): landing pricing shows Free vs Pro comparison table"
```

---

## Task 10: Update documentation and memory

**Files:**
- Modify: `CLAUDE.md`
- Modify: `webapp/PRICING-PLAN.md` (add note about OAuth = Pro only)
- Modify: Memory files

- [ ] **Step 1: Update CLAUDE.md to reflect freemium model**

Replace references to "paid-only" with freemium. Update onboarding description.

- [ ] **Step 2: Update PRICING-PLAN.md to add OAuth constraint**

Add note: "Gmail OAuth = Pro-only feature. Only 100 OAuth slots available until CASA Tier 2 verification ($540 USD). Free users register gastos manually."

- [ ] **Step 3: Update memory files**

Update `project_paid_model.md` → rename to `project_freemium_model.md` with new model description.
Update `project_pricing_plan.md` with OAuth constraint note.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md webapp/PRICING-PLAN.md
git commit -m "docs: update documentation for freemium model with OAuth = Pro only"
```

---

## Summary of changes by system

| System | Change |
|--------|--------|
| **Backend (lib/constants.js)** | FREEMIUM_ACTIVE=true, real limits in PLAN_CONFIG |
| **Backend (index.js)** | Onboarding: "free" vs "pro" paths, /conectar gated, /manual sets plan='free' |
| **Webapp (plan.ts)** | Real PRO_ONLY_FEATURES and FREE_LIMITS |
| **Webapp (API routes)** | Budget limit=3, Goal limit=1, Export gated, Notifications gated |
| **Webapp (pages)** | ProGate on reportes, conditional badge on configuración |
| **Webapp (component)** | New ProGate + ProBadge reusable components |
| **Landing (Pricing.tsx)** | Two-column Free vs Pro with feature comparison table |
| **Landing (Hero, StickyCTA)** | Updated "Desde S/0 gratis" messaging |
| **Docs** | CLAUDE.md, PRICING-PLAN.md, memory files updated |
