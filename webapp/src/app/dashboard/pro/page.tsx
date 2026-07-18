'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Copy, Check, Upload, Loader2, Clock, ShieldCheck, Mail, RefreshCw, Landmark, ChevronDown, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { HeaderActions } from '@/components/dashboard/topbar';

const YAPE_NUMERO = '970398192';
const YAPE_NOMBRE = 'Favio Mendoza';
const PRECIOS = { mensual: 10, anual: 99 } as const;

type Plan = 'mensual' | 'anual';
type Banco = { id: string; label: string };

interface ProStatus {
  plan: string;
  isPremium: boolean;
  pagoPendiente: boolean;
  premiumVence: string | null;
  bancosSeleccionados: string[] | null;
  gmailConectado: boolean;
  gmailEmail: string | null;
  ultimoPago: { estado: string; tipoPlan: string } | null;
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

        {status?.isPremium ? (
          pendiente ? (
            <PendingState renewal onRefresh={() => refetch()} />
          ) : (
            <PremiumState status={status} onDone={() => refetch()} />
          )
        ) : pendiente ? (
          <PendingState onRefresh={() => refetch()} />
        ) : (
          <PaymentForm rejected={rechazado} onDone={() => refetch()} />
        )}
      </div>
    </FadeIn>
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
        <BancosManager initial={status.bancosSeleccionados} />
        <GmailConnect conectado={status.gmailConectado} email={status.gmailEmail} />
      </div>
    </div>
  );
}

function BancosManager({ initial }: { initial: string[] | null }) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: bancos = [] } = useQuery<Banco[]>({
    queryKey: ['pro-bancos'],
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

function GmailConnect({ conectado, email }: { conectado: boolean; email: string | null }) {
  const [loading, setLoading] = useState(false);

  async function connect() {
    setLoading(true);
    try {
      const r = await fetch('/api/pro/gmail-auth-url', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo generar el enlace');
      window.location.href = j.url;
    } catch (e) {
      toast.error((e as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[#1D9E75]/10 shrink-0">
          <Mail className="w-5 h-5 text-[#1D9E75]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[#F0EFE8]">
              {conectado ? 'Gmail conectado' : 'Conecta tu Gmail'}
            </h3>
            {conectado && <Check className="h-4 w-4 text-[#1D9E75] shrink-0" />}
          </div>
          {conectado ? (
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto lee tus notificaciones bancarias de{' '}
              <span className="text-[#C8C6BC] font-medium break-all">{email || 'tu cuenta'}</span>. Solo lectura de esos avisos.
            </p>
          ) : (
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto leerá tus notificaciones bancarias por correo. Solo lectura de esos avisos, sin contraseñas bancarias.
            </p>
          )}
        </div>
      </div>

      {!conectado && (
        <Button onClick={() => connect()} disabled={loading} className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Conectar mi Gmail'}
        </Button>
      )}
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

function PaymentForm({ rejected = false, renewal = false, onDone }: { rejected?: boolean; renewal?: boolean; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan>('mensual');
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const monto = PRECIOS[plan];

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
                S/{PRECIOS[p]}
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
