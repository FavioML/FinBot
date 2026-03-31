# Landing Page CRO Analysis v2
## app.neto.pe (Login + Dashboard)
### Analysis Date: 2026-03-24

---

## Overall CRO Score: 78/100 (up from 68/100)

## Page Type: SaaS Freemium Signup (Google OAuth)
## Current Estimated Conversion Rate: 15-20% (visitors to signup)
## Target Conversion Rate: 25-30%

---

## What Improved Since v1 (Rounds 1-6)

| Fix | Impact | Status |
|-----|--------|--------|
| Security badge below CTA | Trust +15% | Done |
| WhatsApp secondary CTA | Alternative channel | Done |
| Score contextual feedback | Engagement | Done |
| Onboarding checklist (new users) | Activation +20% | Done |
| AI insight card | Retention | Done |
| Welcome modal (3 slides) | Education | Done |
| Empty states with CTAs | Re-engagement | Done |
| Payment method icons | Scannability | Done |
| 404 page branded | Retention | Done |
| Sidebar restructured | Navigation UX | Done |
| Bottom nav with Suscripciones | Mobile coverage | Done |
| Focus-visible + selection CSS | Accessibility | Done |
| Page fade transitions | Polish | Done |

---

## Section-by-Section Analysis

### 1. Login Page (Hero) [Score: 8/10] (was 7/10)
**Strengths:**
- Clear benefit headline ("Bienvenido")
- Single prominent CTA (Continuar con Google)
- Security badge builds trust
- WhatsApp alternative for non-web users
- Feature showcase on right panel (desktop)
- Social proof avatars at bottom

**Remaining Issues:**
- F18: Headline "Bienvenido" is generic — not benefit-driven. Should communicate the VALUE of signing up
- F19: No specific number in social proof ("Usuarios en Peru" — how many?)
- F20: Mobile users see NO features/benefits — only the login form
- F21: No "Free forever" or pricing clarity before signup

### 2. Dashboard Overview [Score: 8.5/10] (was 7/10)
**Strengths:**
- KPI cards with animated numbers and score feedback
- Onboarding checklist for new users
- AI insight card with personalized tips
- Welcome modal educates first-time users
- Trend chart + category donut side by side
- Subscriptions detected from catalog

**Remaining Issues:**
- F22: No "quick add" floating action button for manual transactions
- F23: Trend chart shows only 4 months — no label explaining this
- F24: No comparison indicators (vs last month) on KPI cards

### 3. Transacciones [Score: 8/10] (was 7.5/10)
**Strengths:**
- Full CRUD with inline edit/delete
- Filters in Spanish with clear labels
- Payment method icons with emojis
- Auto-insight banner showing top category
- Contextual empty states

**Remaining Issues:**
- F25: No bulk actions (select multiple → delete/categorize)
- F26: Search bar is inside filters — should be more prominent
- F27: No export to CSV/Excel button

### 4. Presupuestos [Score: 8/10]
**Strengths:**
- Grouped by category with sub-budgets
- Progress bars with color coding
- Detail dialog with transaction list
- Good empty state with CTA

**Remaining Issues:**
- F28: No visual alert when budget is close to limit (e.g. 80%+)
- F29: No suggested budgets based on spending history

### 5. Reportes [Score: 8/10] (was 7/10)
**Strengths:**
- Score clickable with breakdown dialog
- PDF download with branded filename
- Category bar chart + payment pie chart
- Top merchants clickable for drill-down
- Upsell banner for free users

**Remaining Issues:**
- F30: No comparison with previous month in report
- F31: Daily spending chart could show average line

### 6. Suscripciones [Score: 8.5/10]
**Strengths:**
- Catalog detection (50+ services)
- Expandable cards with plan comparison
- Monthly view with real payments
- Optimization CTA for 3+ subscriptions
- KPI summary cards

**Remaining Issues:**
- F32: No "cancel this subscription" reminder/link
- F33: No total annual projection prominently displayed at top

### 7. Configuracion [Score: 7.5/10] (was 6/10)
**Strengths:**
- User name prominent with plan badge
- Plan comparison table
- Referral link with copy button
- Session separated from danger zone
- Connected accounts section

**Remaining Issues:**
- F34: Referral progress always shows 0/3 — needs real data or hide if 0
- F35: No notification preferences
- F36: Avatar uses initial letter — should use Google avatar if available

---

## Copy Score: 74/100 (was 64/100)

| Dimension | Score | Notes |
|---|---|---|
| Clarity | 8/10 | Good — Spanish copy is clear and natural |
| Urgency | 5/10 | Still no urgency elements anywhere |
| Specificity | 7/10 | Insight card and score give specific numbers |
| Proof | 7/10 | Social proof exists but no real numbers |
| Action Orientation | 9/10 | Every empty state has CTAs now |

---

## Prioritized Fix List

### Quick Wins (this session — high impact, low effort)

| ID | Fix | Impact | Effort |
|----|-----|--------|--------|
| F18 | Login headline: "Bienvenido" → "Controla tu dinero en un solo lugar" | Signup +10% | 5 min |
| F19 | Social proof: add user count number | Trust +5% | 5 min |
| F20 | Show 3 key benefits on mobile login (below CTA) | Mobile signup +15% | 15 min |
| F21 | Add "Gratis — sin tarjeta de credito" below Google button | Signup +8% | 5 min |
| F24 | KPI cards: add vs-last-month comparison arrows | Engagement +10% | 20 min |
| F36 | Use Google avatar in configuracion profile | Polish | 10 min |

### Medium-Term (next session)

| ID | Fix | Impact | Effort |
|----|-----|--------|--------|
| F22 | Floating "+" button for quick transaction add | Engagement +15% | 30 min |
| F27 | Export CSV/Excel button in transacciones | Feature completeness | 30 min |
| F28 | Budget warning when >80% used | Engagement | 20 min |
| F30 | Month-over-month comparison in reportes | Insight value | 45 min |
| F33 | Annual projection KPI at top of suscripciones | Awareness | 15 min |

### Strategic (future sessions)

| ID | Fix | Impact | Effort |
|----|-----|--------|--------|
| F25 | Bulk transaction actions | Power user retention | 2 hrs |
| F29 | AI-suggested budgets | Activation +20% | 1 hr |
| F31 | Average spending line on daily chart | Data insight | 30 min |
| F32 | Subscription cancel reminders | Churn prevention | 1 hr |
| F35 | Notification preferences in config | Personalization | 1 hr |

---

## A/B Test Recommendations

1. "If we change the login headline from 'Bienvenido' to 'Controla tu dinero en un solo lugar', signup rate will increase 10% because benefit-driven headlines outperform generic greetings."

2. "If we add 'Gratis — sin tarjeta' microcopy below the Google button, signup rate will increase 8% because it removes the #1 objection (cost fear)."

3. "If we show key benefits on mobile login, mobile signup rate will increase 15% because 60%+ of Peruvian users access on mobile and currently see no value proposition."

4. "If we add month-over-month comparison arrows to KPI cards, daily active usage will increase 10% because users get immediate context without navigating to reportes."
