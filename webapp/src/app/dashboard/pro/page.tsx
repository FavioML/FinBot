'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Copy, Check, Upload, Loader2, Clock, ShieldCheck, Mail, RefreshCw, Landmark, ChevronDown, ZoomIn, Lock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { HeaderActions } from '@/components/dashboard/topbar';
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';
import { pantallaPro, diasRestantesTrial, esProPagado } from '@/lib/plan';
import { estadoGmail, puedeAccionar } from '@/lib/gmail-estado';

const YAPE_NUMERO = '970398192';
const YAPE_NOMBRE = 'Favio Mendoza';
const PRECIOS = { mensual: PRO_PRICE_MONTHLY_PEN, anual: PRO_PRICE_YEARLY_PEN } as const;

type Plan = 'mensual' | 'anual';
type Banco = { id: string; label: string };

// Descuento de referido (50% off primer mes). Solo aplica al mensual.
type Descuento = { pct: number; vence: string; diasRestantes: number } | null;

interface ProStatus {
  plan: string;
  /** "¿tiene Pro ahora?" — durante el trial también es true. NO significa "paga". */
  isPremium: boolean;
  trialEstado: string | null;
  trialVence: string | null;
  pagoPendiente: boolean;
  premiumVence: string | null;
  bancosSeleccionados: string[] | null;
  gmailConectado: boolean;
  gmailEmail: string | null;
  /** Conectada pero con el token muerto. `gmailConectado` sigue en true: ver `@/lib/gmail-estado`. */
  gmailNecesitaReconexion: boolean;
  gmailAuthErrorAt: string | null;
  ultimoPago: { estado: string; tipoPlan: string } | null;
  descuento: Descuento;
}

// Precio efectivo del plan aplicando el descuento de referido (solo mensual).
function precioEfectivo(plan: Plan, descuento: Descuento): number {
  if (plan === 'mensual' && descuento?.pct) {
    return Math.round(PRECIOS.mensual * (100 - descuento.pct)) / 100;
  }
  return PRECIOS[plan];
}

export default function ProPage() {
  const { data: status, isLoading, isError, refetch } = useQuery<ProStatus>({
    queryKey: ['pro-status'],
    queryFn: async () => {
      const r = await fetch('/api/pro/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('status');
      return r.json();
    },
    refetchInterval: (q) => (q.state.data?.pagoPendiente ? 5000 : false),
  });

  const pendiente = !!status?.pagoPendiente || status?.ultimoPago?.estado === 'pendiente';
  const rechazado = status?.ultimoPago?.estado === 'rechazado' && !pendiente && !status?.isPremium;
  const pantalla = pantallaPro({
    plan: status?.plan,
    trialEstado: status?.trialEstado,
    pagoPendiente: pendiente,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-[#1D9E75]" />
      </div>
    );
  }

  // Sin estado cargado (fetch falló tras el retry) NUNCA mostramos el formulario de pago:
  // un usuario que ya es Pro vería el form y podría yapear de nuevo. Estado neutro + reintentar.
  if (!status) {
    return (
      <FadeIn>
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[#F0EFE8] flex items-center gap-2">
                <Crown className="h-6 w-6" style={{ color: '#68dbae' }} /> Neto Pro
              </h1>
              <p className="text-sm text-[#8A877D] mt-1">Todo el potencial de Neto, sin fricción</p>
            </div>
            <HeaderActions />
          </div>
          <div className="glass-card p-6 text-center space-y-3 mx-auto max-w-xl">
            <h2 className="text-lg font-semibold text-[#F0EFE8]">No pudimos cargar tu estado Pro</h2>
            <p className="text-sm text-[#8A877D] max-w-md mx-auto">
              {isError
                ? 'Revisa tu conexión e inténtalo de nuevo. Si ya eres Pro, tu plan sigue activo.'
                : 'Inténtalo de nuevo en un momento.'}
            </p>
            <button onClick={() => refetch()} className="text-xs text-[#1D9E75] hover:underline">Reintentar</button>
          </div>
        </div>
      </FadeIn>
    );
  }

  return (
    <FadeIn>
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8] flex items-center gap-2">
              <Crown className="h-6 w-6" style={{ color: '#68dbae' }} /> Neto Pro
            </h1>
            <p className="text-sm text-[#8A877D] mt-1">Todo el potencial de Neto, sin fricción</p>
          </div>
          <HeaderActions />
        </div>

        {/* La decisión vive en `pantallaPro` (@/lib/plan, probada en plan.test.ts) y no acá:
            ramificar con `isPremium` a secas mandaba al usuario en prueba a la pantalla de
            "ya eres Pro", sin fecha ni precio, que es donde aterrizaban TODOS los CTA del
            trial. Ver el comentario de `pantallaPro`. */}
        {pantalla === 'pendiente' ? (
          // `renewal` solo para quien YA paga: a alguien en su primer pago (venga del trial
          // o del muro) decirle "tu renovación está en verificación, tu Pro sigue activo"
          // describe una suscripción que todavía no tiene.
          <PendingState renewal={esProPagado(status.plan, status.trialEstado)} onRefresh={() => refetch()} />
        ) : pantalla === 'trial' ? (
          <TrialState status={status} onDone={() => refetch()} />
        ) : pantalla === 'pagado' ? (
          <PremiumState status={status} onDone={() => refetch()} />
        ) : (
          <PaymentForm rejected={rechazado} descuento={status.descuento} onDone={() => refetch()} />
        )}
      </div>
    </FadeIn>
  );
}

/* ------------------------------ Trial ------------------------------ */

/**
 * Lo que ve quien está PROBANDO Pro. Es la pantalla más importante del embudo: acá
 * aterrizan el banner del dashboard, los avisos de WhatsApp del día 11 y 14, y la
 * notificación in-app. Antes caía en `PremiumState` y leía "Eres Neto Pro ⭐" sin fecha
 * ni precio, o sea que el trial mandaba a la gente a decidir a una pantalla que le decía
 * que no había nada que decidir.
 *
 * Tres cosas, en este orden:
 *  1. Qué tiene y hasta cuándo. La fecha es lo único que hace que el día 15 no sorprenda.
 *  2. Qué pasa después, sin dramatizar: sigue anotando gratis, se cierra la lectura.
 *  3. El formulario de pago ABIERTO, con el descuento. No detrás de un botón: pagar es el
 *     único motivo por el que alguien entra acá durante la prueba.
 *
 * Bancos y Gmail siguen abajo pero BLOQUEADOS: son la única capability que el trial no
 * entrega, porque cada conexión consume un cupo de Google que no se recupera. Se muestran
 * en vez de esconderse justamente por eso — es el único momento del trial donde hay algo
 * concreto que solo se abre pagando, y el formulario está tres centímetros más arriba.
 */
function TrialState({ status, onDone }: { status: ProStatus; onDone: () => void }) {
  const dias = diasRestantesTrial(status.plan, status.trialEstado, status.trialVence);
  const urgente = dias !== null && dias <= 3;
  const cuando =
    dias === null ? null : dias === 0 ? 'Termina hoy' : dias === 1 ? 'Queda 1 día' : `Quedan ${dias} días`;
  const fecha = status.trialVence
    ? new Date(status.trialVence + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'long' })
    : null;

  return (
    <div className="space-y-4">
      <div className="glass-card p-6 flex flex-col sm:flex-row items-center gap-4 sm:gap-6 text-center sm:text-left">
        <div
          className={`inline-flex items-center justify-center w-14 h-14 rounded-full shrink-0 border ${
            urgente
              ? 'bg-[#EF9F27]/15 border-[#EF9F27]/30'
              : 'bg-[#1D9E75]/15 border-[#1D9E75]/30'
          }`}
        >
          <Clock className={`w-7 h-7 ${urgente ? 'text-[#EF9F27]' : 'text-[#1D9E75]'}`} />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-[#F0EFE8]">Estás probando Neto Pro</h2>
          <p className={`text-sm mt-0.5 ${urgente ? 'font-medium text-[#EF9F27]' : 'text-[#8A877D]'}`}>
            {cuando}
            {fecha ? ` — termina el ${fecha}` : ''}
          </p>
          <p className="text-sm text-[#8A877D] mt-2">
            Después sigo anotando todos tus gastos por WhatsApp, gratis. Lo que se cierra es el
            dashboard, el historial y los reportes.
          </p>
        </div>
      </div>

      <div className="glass-card p-5 space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#F0EFE8] mb-2">
          <Crown className="h-4 w-4 text-[#1D9E75]" /> Continúa con Pro
        </div>
        <PaymentForm descuento={status.descuento} onDone={onDone} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BancosManager initial={status.bancosSeleccionados} proPagado={esProPagado(status.plan, status.trialEstado)} />
        {/* En prueba se muestra bloqueada, no se esconde: es el único momento del trial donde
            pedimos el pago por algo concreto, y vale más como conversión visible. Se deriva del
            predicado en vez de pasar `false` fijo, para que no pueda divergir del gate real. */}
        <GmailConnect
          conectado={status.gmailConectado}
          email={status.gmailEmail}
          proPagado={esProPagado(status.plan, status.trialEstado)}
          necesitaReconexion={status.gmailNecesitaReconexion}
          authErrorAt={status.gmailAuthErrorAt}
        />
      </div>
    </div>
  );
}

/* ----------------------------- Premium ----------------------------- */

function PremiumState({ status, onDone }: { status: ProStatus; onDone: () => void }) {
  const [showRenew, setShowRenew] = useState(false);

  return (
    <div className="space-y-4">
      {/* Banner */}
      <div className="glass-card glass-card-glow p-6 flex flex-col sm:flex-row items-center gap-4 sm:gap-6 text-center sm:text-left">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#1D9E75]/15 border border-[#1D9E75]/30 shrink-0">
          <ShieldCheck className="w-7 h-7 text-[#1D9E75]" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-[#F0EFE8]">Eres Neto Pro ⭐</h2>
          {status.premiumVence && (
            <p className="text-sm text-[#8A877D] mt-0.5">
              Activo hasta el{' '}
              {new Date(status.premiumVence + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowRenew((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#C8C6BC] hover:text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.04)] transition-colors shrink-0"
        >
          <RefreshCw className="h-4 w-4" /> {showRenew ? 'Cerrar' : 'Renovar'}
        </button>
      </div>

      {/* Renewal form (opens above the management grid) */}
      {showRenew && (
        <div className="glass-card p-5 space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#F0EFE8] mb-2">
            <RefreshCw className="h-4 w-4 text-[#1D9E75]" /> Renovar / extender tu Pro
          </div>
          <PaymentForm renewal onDone={() => { setShowRenew(false); onDone(); }} />
        </div>
      )}

      {/* Management: bancos + gmail side by side on desktop */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BancosManager initial={status.bancosSeleccionados} proPagado={esProPagado(status.plan, status.trialEstado)} />
        <GmailConnect
          conectado={status.gmailConectado}
          email={status.gmailEmail}
          proPagado={esProPagado(status.plan, status.trialEstado)}
          necesitaReconexion={status.gmailNecesitaReconexion}
          authErrorAt={status.gmailAuthErrorAt}
        />
      </div>
    </div>
  );
}

/**
 * Elegir bancos es la otra mitad de la lectura de correos: sin Gmail conectado no lee nada.
 * Por eso comparte el gate de `GmailConnect` — dejarlo abierto al que no paga configuraba
 * una lectura que nunca iba a ocurrir, que es un callejón sin salida, no una feature gratis.
 */
function BancosManager({ initial, proPagado }: { initial: string[] | null; proPagado: boolean }) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: bancos = [] } = useQuery<Banco[]>({
    queryKey: ['pro-bancos'],
    // El endpoint responde 403 a quien no paga; ni se pide para no ensuciar la consola
    // con un error esperado ni dejar el catálogo cacheado por si el gate se cae.
    enabled: proPagado,
    queryFn: async () => {
      const r = await fetch('/api/pro/bancos', { cache: 'no-store' });
      const j = await r.json();
      return j.bancos || [];
    },
  });

  // Inicializa la selección una vez que carga el catálogo: null = todos.
  useEffect(() => {
    if (!bancos.length || selected !== null) return;
    setSelected(initial === null ? new Set(bancos.map((b) => b.id)) : new Set(initial));
  }, [bancos, initial, selected]);

  const sel = selected ?? new Set<string>();
  const allChecked = bancos.length > 0 && sel.size === bancos.length;

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(bancos.map((b) => b.id)));
  }
  function toggle(id: string) {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSelected(n);
  }

  async function save() {
    setSaving(true);
    try {
      // Si están todos marcados guardamos null (= todos, y auto-incluye bancos nuevos).
      const payload = allChecked ? null : Array.from(sel);
      const r = await fetch('/api/pro/bancos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bancos: payload }),
      });
      if (!r.ok) throw new Error('No se pudo guardar');
      toast.success('Bancos actualizados');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const resumen = allChecked ? 'Todos' : `${sel.size} seleccionado${sel.size === 1 ? '' : 's'}`;

  if (!proPagado) {
    return (
      <div className="glass-card p-5 space-y-3 opacity-70">
        <div className="flex w-full items-center gap-2 text-left">
          <Lock className="h-4 w-4 text-[#8A877D] shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#C8C6BC]">Bancos y billeteras que Neto leerá</p>
            <p className="text-xs text-[#8A877D] mt-0.5">
              Vuélvete Pro para activar esta función beta
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5" aria-hidden="true">
          {['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'Yape', 'Plin'].map((n) => (
            <div key={n} className="flex items-center gap-2.5 py-1">
              <span className="h-4 w-4 rounded-[3px] border border-[rgba(240,239,232,0.15)] shrink-0" />
              <span className="text-sm text-[#8A877D] truncate blur-[2px] select-none">{n}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-5 space-y-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <Landmark className="h-4 w-4 text-[#1D9E75] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#F0EFE8]">Bancos y billeteras que Neto leerá</p>
          <p className="text-xs text-[#8A877D] mt-0.5">Se aplica al conectar tu Gmail · {resumen}</p>
        </div>
        <ChevronDown className={`h-4 w-4 text-[#8A877D] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-3">
          <label className="flex items-center gap-2.5 py-1.5 cursor-pointer border-b border-[rgba(255,255,255,0.06)]">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-[#1D9E75] h-4 w-4" />
            <span className="text-sm font-medium text-[#F0EFE8]">Todos mis bancos</span>
          </label>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {bancos.map((b) => (
              <label key={b.id} className="flex items-center gap-2.5 py-1 cursor-pointer">
                <input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} className="accent-[#1D9E75] h-4 w-4" />
                <span className="text-sm text-[#C8C6BC] truncate">{b.label}</span>
              </label>
            ))}
          </div>

          <Button onClick={save} disabled={saving} size="sm" className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 mt-1">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar bancos'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Conectar Gmail consume uno de los 100 cupos de Google que tenemos hasta la certificación
 * CASA, así que es la única capability que se cobra por adelantado: `proPagado`, no `isPremium`
 * (durante el trial `plan` ya vale 'premium'). El backend lo rechaza igual con 403 — esto es
 * para que el usuario en prueba entienda por qué, en vez de chocar contra un error.
 *
 * La variante bloqueada vive DENTRO de la tarjeta y no usa `ProGate`: ese componente es de
 * página entera (`min-h-[400px]`) y reventaría el grid de dos columnas donde convive con
 * `BancosManager`. Y su copy —"es Pro" → "Pasar a Pro"— le mentiría a quien tiene Pro ahora
 * mismo. Acá el mensaje es el otro: lo tienes todo, esto pide el pago primero, y este es el
 * motivo. El `PaymentForm` que `TrialState` deja abierto está justo arriba.
 *
 * Son CUATRO estados, no dos. `conectado` y `sano` dejaron de ser lo mismo: la fila queda en
 * activa=true cuando Google revoca el token, así que la tarjeta afirmaba "Gmail conectado ✓"
 * mientras no leía nada. Por eso el enlace de reconexión tenía que estar siempre visible,
 * contradiciendo el ✓ que estaba justo encima. Ahora el estado sano no lleva NINGUNA acción y
 * el CTA existe solo donde hace falta. La decisión vive en `@/lib/gmail-estado` (testeada);
 * acá solo se pinta.
 */
function GmailConnect({
  conectado,
  email,
  proPagado,
  necesitaReconexion,
  authErrorAt,
}: {
  conectado: boolean;
  email: string | null;
  proPagado: boolean;
  necesitaReconexion: boolean;
  authErrorAt: string | null;
}) {
  const [loading, setLoading] = useState<string | null>(null);

  async function connect(modo: 'inicial' | 'reemplazar') {
    setLoading(modo);
    try {
      const r = await fetch('/api/pro/gmail-auth-url?modo=' + modo, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo generar el enlace');
      window.location.href = j.url;
    } catch (e) {
      toast.error((e as Error).message);
      setLoading(null);
    }
  }

  const estado = estadoGmail({ conectado, necesitaReconexion, proPagado });
  const accionable = puedeAccionar(estado, proPagado);
  const caido = estado === 'caido';

  // Fecha Lima, igual que el resto de la app: "se desconectó el 3 de agosto" tiene que decir el
  // día que fue acá, no el del navegador de quien mira.
  const desde = authErrorAt
    ? new Date(authErrorAt).toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long' })
    : null;

  const TITULOS: Record<typeof estado, string> = {
    caido: 'Gmail desconectado',
    sano: 'Gmail conectado',
    bloqueado: 'Lectura de correos bancarios',
    'sin-conectar': 'Conecta tu Gmail',
  };

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${
            caido ? 'bg-[#EF9F27]/10' : 'bg-[#1D9E75]/10'
          }`}
        >
          {caido ? (
            <AlertTriangle className="w-5 h-5 text-[#EF9F27]" />
          ) : estado === 'bloqueado' ? (
            <Lock className="w-5 h-5 text-[#1D9E75]" />
          ) : (
            <Mail className="w-5 h-5 text-[#1D9E75]" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[#F0EFE8]">{TITULOS[estado]}</h3>
            {estado === 'sano' && <Check className="h-4 w-4 text-[#1D9E75] shrink-0" />}
          </div>
          {caido ? (
            /* Se dice QUÉ pasó y qué dejó de funcionar, porque el usuario no hizo nada para
               romperlo y el síntoma que ve es "Neto dejó de anotar mis gastos". No se ofrece
               cambiar de cuenta: mandarlo a Google con otro correo ya cuesta un cupo, aunque
               el callback después lo rechace. */
            <p className="text-xs text-[#8A877D] mt-0.5">
              Google dejó de aceptar el permiso de{' '}
              <span className="text-[#C8C6BC] font-medium break-all">{email || 'tu cuenta'}</span>
              {desde ? <> el {desde}</> : null}, así que Neto ya no está registrando los gastos que te llegan por
              correo. Lo que anotas por WhatsApp sigue igual. Vuelve a autorizar esa misma cuenta y se retoma solo.
            </p>
          ) : estado === 'sano' ? (
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto lee tus notificaciones bancarias de{' '}
              <span className="text-[#C8C6BC] font-medium break-all">{email || 'tu cuenta'}</span>. Solo lectura de esos avisos.
            </p>
          ) : estado === 'bloqueado' ? (
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto detecta tus gastos de las notificaciones del banco y los anota solos.{' '}
              <span className="text-[#C8C6BC]">Se activa al confirmar tu pago</span> — cada conexión nos cuesta un cupo con
              Google y los tenemos contados. Actívalo aquí arriba y empieza a leer el mismo día.
            </p>
          ) : (
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto leerá tus notificaciones bancarias por correo. Solo lectura de esos avisos, sin contraseñas bancarias.
            </p>
          )}
        </div>
      </div>

      {/* El estado sano no lleva acción a propósito: un CTA debajo de un "conectado ✓" se lee
          como paso pendiente y hace dudar de lo que la tarjeta acaba de afirmar. Reconectar es
          una salida de emergencia (el token muere solo), no un paso del flujo normal — así que
          aparece justo cuando la emergencia existe.
          Un usuario, UNA cuenta, para siempre: cada cuenta de Google distinta consume otro de
          los 100 cupos de por vida. Por eso el botón siempre reconecta LA MISMA; autorizar con
          otro correo lo rechaza el callback.
          `accionable` exige Pro pagado: a quien dejó de pagar se le conserva la conexión que ya
          tiene, pero el backend responde 403 si intenta reabrirla. */}
      {estado === 'sin-conectar' || estado === 'bloqueado' ? (
        <Button
          onClick={() => connect('inicial')}
          disabled={!!loading || !accionable}
          className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : accionable ? 'Conectar mi Gmail' : 'Se activa con Pro pagado'}
        </Button>
      ) : caido && accionable ? (
        <>
          <Button
            onClick={() => connect('reemplazar')}
            disabled={!!loading}
            className="w-full bg-[#EF9F27] text-[#0E0E0C] hover:bg-[#EF9F27]/90 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reconectar Gmail'}
          </Button>
          <p className="text-[11px] text-[#8A877D] leading-relaxed">
            Neto lee de una sola cuenta; para cambiarla, escríbenos.
          </p>
        </>
      ) : null}
    </div>
  );
}

/* --------------------------- Pending state -------------------------- */

function PendingState({ renewal = false, onRefresh }: { renewal?: boolean; onRefresh: () => void }) {
  return (
    <div className="glass-card glass-card-glow p-6 text-center space-y-3 mx-auto max-w-xl">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#EF9F27]/15 border border-[#EF9F27]/30">
        <Clock className="w-7 h-7 text-[#EF9F27]" />
      </div>
      <h2 className="text-xl font-bold text-[#F0EFE8]">
        {renewal ? 'Tu renovación está en verificación' : 'Estamos verificando tu pago'}
      </h2>
      <p className="text-sm text-[#8A877D] max-w-md mx-auto">
        {renewal
          ? 'Tu Pro sigue activo. Apenas validemos el pago, extendemos tu suscripción y te avisamos.'
          : 'Recibimos tu comprobante. Apenas lo validemos, activamos tu Pro y te avisamos aquí y por WhatsApp. Suele tomar pocos minutos.'}
      </p>
      <button onClick={onRefresh} className="text-xs text-[#1D9E75] hover:underline">Actualizar estado</button>
    </div>
  );
}

/* --------------------------- Payment form --------------------------- */

function PaymentForm({ rejected = false, renewal = false, descuento = null, onDone }: { rejected?: boolean; renewal?: boolean; descuento?: Descuento; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan>('mensual');
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const monto = precioEfectivo(plan, descuento);

  function copyNumero() {
    navigator.clipboard.writeText(YAPE_NUMERO);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function onPickFile(f: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  async function submit() {
    if (!file) {
      toast.error('Sube la captura de tu Yape');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('comprobante', file);
      fd.append('tipo_plan', plan);
      const r = await fetch('/api/pro/solicitud', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo enviar');
      toast.success(renewal ? '¡Comprobante enviado! Verificamos tu renovación.' : '¡Comprobante enviado! Estamos verificando tu pago.');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {descuento && !renewal && (
        <div className="glass-card p-4 border border-[#1D9E75]/30 bg-[#1D9E75]/5 flex items-start gap-3">
          <div className="mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[#1D9E75]/15 shrink-0">
            <Crown className="w-5 h-5 text-[#1D9E75]" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#F0EFE8]">Tu 50% de bienvenida está activo 🎉</p>
            <p className="text-xs text-[#8A877D] mt-0.5">
              Estrena Neto Pro por{' '}
              <span className="text-[#1D9E75] font-semibold">S/{precioEfectivo('mensual', descuento)}</span>{' '}
              <span className="line-through">S/{PRECIOS.mensual}</span> tu primer mes (plan mensual).{' '}
              {descuento.diasRestantes > 0
                ? `Vence en ${descuento.diasRestantes} día${descuento.diasRestantes === 1 ? '' : 's'}.`
                : 'Vence hoy.'}
            </p>
          </div>
        </div>
      )}

      {rejected && (
        <div className="glass-card p-4 border border-[#D85A30]/30 bg-[#D85A30]/5">
          <p className="text-sm text-[#D85A30]">
            No pudimos validar tu comprobante anterior. Revisa que el Yape sea de S/{monto} a {YAPE_NOMBRE} y vuelve a enviarlo.
          </p>
        </div>
      )}

      {/* Plan — full width */}
      <div className="glass-card p-5 space-y-3">
        <p className="text-xs uppercase tracking-wider text-[#8A877D]">1. Elige tu plan</p>
        <div className="grid grid-cols-2 gap-3">
          {(['mensual', 'anual'] as Plan[]).map((p) => (
            <button
              key={p}
              onClick={() => setPlan(p)}
              className={`rounded-xl border p-4 text-left transition-all ${
                plan === p
                  ? 'border-[#1D9E75] bg-[#1D9E75]/10 ring-1 ring-[#1D9E75]/40'
                  : 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.05)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#F0EFE8] capitalize">{p}</span>
                {p === 'anual' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#EF9F27]/15 text-[#EF9F27] font-medium">2 meses gratis</span>
                )}
              </div>
              <p className="mt-1 text-lg font-bold text-[#1D9E75]">
                {p === 'mensual' && descuento ? (
                  <>
                    S/{precioEfectivo('mensual', descuento)}
                    <span className="ml-1.5 text-xs font-normal text-[#8A877D] line-through">S/{PRECIOS.mensual}</span>
                  </>
                ) : (
                  <>S/{PRECIOS[p]}</>
                )}
                <span className="text-xs font-normal text-[#8A877D]">/{p === 'anual' ? 'año' : 'mes'}</span>
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Yape + upload — two columns on desktop */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="glass-card p-5 space-y-4">
          <p className="text-xs uppercase tracking-wider text-[#8A877D]">2. Yapea S/{monto}</p>
          <div className="flex flex-col sm:flex-row gap-4 items-center">
            <Dialog>
              <DialogTrigger className="group relative shrink-0 rounded-xl overflow-hidden border border-[rgba(255,255,255,0.08)] bg-white p-2 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-[#1D9E75]">
                <Image src="/yape-favio-qr.jpeg" alt="QR Yape de Favio Mendoza" width={150} height={150} className="rounded-md" />
                <span className="absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded-md bg-black/55 py-0.5 text-[10px] font-medium text-white opacity-90 transition-opacity group-hover:opacity-100">
                  <ZoomIn className="h-3 w-3" /> toca para ampliar
                </span>
              </DialogTrigger>
              <DialogContent className="bg-white text-neutral-900 sm:max-w-xs flex flex-col items-center gap-3">
                <DialogTitle className="text-neutral-900">Yapea a {YAPE_NOMBRE}</DialogTitle>
                <div className="rounded-xl bg-white p-3">
                  <Image src="/yape-favio-qr.jpeg" alt="QR Yape de Favio Mendoza" width={320} height={320} className="rounded-lg" />
                </div>
                <p className="text-sm text-neutral-500 tabular-nums">{YAPE_NUMERO}</p>
              </DialogContent>
            </Dialog>
            <div className="flex-1 w-full space-y-2">
              <p className="text-sm text-[#8A877D]">Yapea a nombre de <span className="text-[#F0EFE8] font-medium">{YAPE_NOMBRE}</span></p>
              <button
                onClick={copyNumero}
                className="w-full flex items-center justify-between rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-4 py-3 hover:bg-[rgba(255,255,255,0.07)] transition-colors"
              >
                <span className="text-lg font-bold text-[#F0EFE8] tabular-nums tracking-wide">{YAPE_NUMERO}</span>
                {copied ? <Check className="h-4 w-4 text-[#1D9E75]" /> : <Copy className="h-4 w-4 text-[#8A877D]" />}
              </button>
              <p className="text-xs text-[#8A877D]">Monto exacto: <span className="text-[#1D9E75] font-semibold">S/{monto}.00</span></p>
            </div>
          </div>
        </div>

        <div className="glass-card p-5 space-y-3 flex flex-col">
          <p className="text-xs uppercase tracking-wider text-[#8A877D]">3. Sube tu comprobante</p>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
          {preview ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Comprobante" className="h-20 w-20 object-cover rounded-lg border border-[rgba(255,255,255,0.08)]" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#F0EFE8] truncate">{file?.name}</p>
                <button onClick={() => inputRef.current?.click()} className="text-xs text-[#1D9E75] hover:underline">Cambiar</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => inputRef.current?.click()}
              className="flex-1 min-h-[120px] w-full flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[rgba(255,255,255,0.15)] py-8 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            >
              <Upload className="h-6 w-6 text-[#8A877D]" />
              <span className="text-sm text-[#8A877D]">Toca para subir la captura del Yape</span>
            </button>
          )}
        </div>
      </div>

      <Button onClick={submit} disabled={submitting || !file} className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 h-12 text-base">
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : `Enviar comprobante — S/${monto}`}
      </Button>
      <p className="text-center text-xs text-[#8A877D]">
        {renewal ? 'Extiende tu Pro. Un humano valida el pago antes de sumar el periodo.' : 'Un humano revisa tu pago antes de activar Pro. Cancelas cuando quieras.'}
      </p>
    </div>
  );
}
