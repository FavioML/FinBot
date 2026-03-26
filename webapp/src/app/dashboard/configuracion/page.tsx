'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { toast } from 'sonner';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import {
  User,
  Mail,
  Phone,
  Crown,
  Calendar,
  Link,
  Copy,
  Check,
  ExternalLink,
  Settings,
  Shield,
  MessageCircle,
  Bell,
  Moon,
  Sun,
  Palette,
  Download,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useUser } from '@/lib/hooks/use-user';
import { createClient } from '@/lib/supabase/client';
import { UserMenu } from '@/components/dashboard/user-menu';
import { SOCIAL_LINKS } from '@/lib/constants';

/* ------------------------------------------------------------------ */
/*  Plan comparison data                                               */
/* ------------------------------------------------------------------ */
const PLAN_FEATURES = [
  { label: 'Lectura automática de gastos', free: '1 cuenta', premium: 'Ilimitadas' },
  { label: 'Categorías', free: '11 fijas', premium: '11 + personalizadas' },
  { label: 'Presupuestos', free: '3', premium: 'Ilimitados' },
  { label: 'Dashboard', free: 'Mes actual', premium: 'Historial completo' },
  { label: 'Resumen diario', free: false, premium: true },
  { label: 'Resumen semanal IA', free: 'Básico', premium: 'Insights + comparativa' },
  { label: 'Imágenes Yape/Plin', free: '5/mes', premium: 'Ilimitadas' },
  { label: 'Score financiero', free: 'Número', premium: 'Desglose + tendencia' },
  { label: 'Metas de ahorro', free: '1', premium: 'Ilimitadas' },
  { label: 'Consejo IA', free: '1/semana', premium: 'Diario' },
  { label: 'Reportes PDF', free: false, premium: true },
  { label: 'Calendario financiero', free: false, premium: true },
  { label: 'Export CSV/JSON', free: false, premium: true },
  { label: 'Carga masiva Excel', free: false, premium: true },
  { label: 'Recordatorios diarios', free: false, premium: true },
] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-PE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function getInitial(email?: string) {
  return (email ?? 'U').charAt(0).toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */
export default function ConfiguracionPage() {
  const router = useRouter();
  const { data: user, isLoading } = useUser();

  const [copied, setCopied] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [recordatoriosActivos, setRecordatoriosActivos] = useState(true);
  const [recordatoriosLoading, setRecordatoriosLoading] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user: authUser } }) => {
      if (authUser?.user_metadata?.avatar_url) {
        setAvatarUrl(authUser.user_metadata.avatar_url);
      }
    });
    // Fetch notification state
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.recordatorios_activos === 'boolean') {
          setRecordatoriosActivos(d.recordatorios_activos);
        }
      })
      .catch(() => {});
  }, []);

  const isPremium = user?.plan === 'premium';
  const referralCode = user?.id?.slice(0, 8).toUpperCase() ?? 'CODIGO';
  const referralLink = `neto.pe/r/${referralCode}`;

  /* ---- Copy referral link ---- */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(`https://${referralLink}`);
      setCopied(true);
      toast.success('Link copiado al portapapeles');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('No se pudo copiar');
    }
  }

  /* ---- Sign out ---- */
  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  /* ---------------------------------------------------------------- */
  /*  Loading skeleton                                                 */
  /* ---------------------------------------------------------------- */
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-[200px] rounded-2xl" />
        <Skeleton className="h-[260px] rounded-2xl" />
        <Skeleton className="h-[160px] rounded-2xl" />
        <Skeleton className="h-[140px] rounded-2xl" />
        <Skeleton className="h-[120px] rounded-2xl" />
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  No user                                                          */
  /* ---------------------------------------------------------------- */
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="rounded-full bg-[rgba(255,255,255,0.03)] p-6 mb-4">
          <User className="h-8 w-8 text-[#8A877D]" />
        </div>
        <h3 className="text-lg font-semibold text-[#F0EFE8] mb-2">
          Inicia sesion para ver tu configuracion
        </h3>
        <p className="text-sm text-[#8A877D] max-w-md mb-6">
          Conecta tu cuenta para administrar tu perfil y plan.
        </p>
        <Button
          className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
          onClick={() => router.push('/login')}
        >
          Iniciar sesion
        </Button>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Configuracion</h1>
        <UserMenu />
      </div>

      {/* ============================================================ */}
      {/*  Profile                                                      */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={user.nombre || ''}
              width={56}
              height={56}
              className="h-14 w-14 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1D9E75] text-xl font-bold text-white">
              {getInitial(user.email)}
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-2">
            {/* Name + plan */}
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[#F0EFE8] truncate">
                {user.nombre || (user.email ? user.email.split('@')[0] : 'Usuario')}
              </h2>
              {isPremium ? (
                <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 gap-1 shrink-0">
                  <Crown className="h-3 w-3" />
                  Premium
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-[rgba(255,255,255,0.06)] text-[#8A877D] border-[rgba(255,255,255,0.08)] shrink-0">
                  Free
                </Badge>
              )}
            </div>

            {/* Email */}
            {user.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-[#8A877D] shrink-0" />
                <span className="text-[#C8C6BC] truncate">{user.email}</span>
              </div>
            )}

            {/* WhatsApp */}
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-[#C8C6BC]">{user.whatsapp}</span>
            </div>

            {/* Member since */}
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-[#8A877D]">
                Miembro desde {formatDate(user.created_at)}
              </span>
            </div>
          </div>
        </div>

        {/* Upgrade CTA */}
        {!isPremium && (
          <>
            <Separator className="my-4 bg-[rgba(255,255,255,0.06)]" />
            <a
              href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero activar Premium')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2">
                <Crown className="h-4 w-4" />
                Upgrade a Premium — S/10/mes o S/99/año
                <ExternalLink className="h-3 w-3 ml-auto opacity-60" />
              </Button>
            </a>
          </>
        )}
      </div>

      {/* ============================================================ */}
      {/*  Plan details                                                 */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">Tu plan</h2>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-[#C8C6BC]">Plan actual</span>
          <span className="text-sm font-medium text-[#F0EFE8]">
            {isPremium ? 'Premium' : 'Free'}
          </span>
        </div>

        {isPremium && user.plan_expiry && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#C8C6BC]">Vence el</span>
            <span className="text-sm font-medium text-[#EF9F27]">
              {formatDate(user.plan_expiry)}
            </span>
          </div>
        )}

        <Separator className="bg-[rgba(255,255,255,0.06)]" />

        {/* Comparison table */}
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#8A877D]">
                <th className="text-left font-medium py-2 pr-4">Funcion</th>
                <th className="text-center font-medium py-2 px-3">Free</th>
                <th className="text-center font-medium py-2 px-3">Premium</th>
              </tr>
            </thead>
            <tbody>
              {PLAN_FEATURES.map((f) => (
                <tr key={f.label} className="border-t border-[rgba(255,255,255,0.04)]">
                  <td className="py-2.5 pr-4 text-[#C8C6BC]">{f.label}</td>
                  <td className="py-2.5 px-3 text-center">
                    {typeof f.free === 'boolean' ? (
                      <span className="text-[#8A877D]">{f.free ? '\u2705' : '\u274C'}</span>
                    ) : (
                      <span className="text-[#8A877D]">{f.free}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {typeof f.premium === 'boolean' ? (
                      <span>{f.premium ? '\u2705' : '\u274C'}</span>
                    ) : (
                      <span className="text-[#1D9E75] font-medium">{f.premium}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  Referidos                                                    */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Link className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Programa de referidos
          </h2>
        </div>

        <p className="text-sm text-[#C8C6BC]">
          Invita a 3 amigos y obten 1 mes Premium gratis.
        </p>

        {/* Referral link */}
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#C8C6BC] truncate">
            {referralLink}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 border-[rgba(255,255,255,0.1)] bg-transparent hover:bg-[rgba(255,255,255,0.05)]"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-[#1D9E75]" />
            ) : (
              <Copy className="h-4 w-4 text-[#8A877D]" />
            )}
          </Button>
        </div>

        {/* Progress */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#8A877D]">Referidos activos</span>
            <span className="text-[#C8C6BC] font-medium">0 / 3 necesarios</span>
          </div>
          <div className="h-2 w-full rounded-full bg-[rgba(255,255,255,0.06)]">
            <div
              className="h-full rounded-full bg-[#1D9E75] transition-all duration-500"
              style={{ width: '0%' }}
            />
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  Connected accounts                                           */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Mail className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Cuentas conectadas
          </h2>
        </div>

        {/* Placeholder connected account */}
        {user.email ? (
          <div className="flex items-center justify-between rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <Mail className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-sm text-[#C8C6BC] truncate">{user.email}</span>
            </div>
            <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 text-xs shrink-0">
              Activa
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-[#8A877D]">No hay cuentas conectadas.</p>
        )}

        {/* Connect another */}
        <a
          href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero conectar otra cuenta de Gmail')}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button
            variant="outline"
            className="w-full border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)] gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Conectar otra cuenta
            <ExternalLink className="h-3 w-3 ml-auto opacity-60" />
          </Button>
        </a>
      </div>

      {/* ============================================================ */}
      {/*  Appearance                                                     */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Palette className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">Apariencia</h2>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Dark mode — active */}
          <button className="relative flex flex-col items-center gap-2 rounded-xl border-2 border-[#1D9E75] bg-[rgba(29,158,117,0.06)] p-4 transition-colors">
            <Moon className="h-5 w-5 text-[#1D9E75]" />
            <span className="text-xs font-medium text-[#F0EFE8]">Dark</span>
            <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-[#1D9E75]" />
          </button>

          {/* Light mode — coming soon */}
          <button className="flex flex-col items-center gap-2 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-4 opacity-50 cursor-not-allowed transition-colors" disabled>
            <Sun className="h-5 w-5 text-[#8A877D]" />
            <span className="text-xs font-medium text-[#8A877D]">Light</span>
            <Badge variant="secondary" className="absolute text-[8px] bg-[rgba(255,255,255,0.06)] text-[#8A877D] border-[rgba(255,255,255,0.08)] px-1.5 py-0">
              Pronto
            </Badge>
          </button>
        </div>

        <p className="text-xs text-[#8A877D]">
          Tema &quot;Nocturnal Precision&quot; — disenado para reducir fatiga visual.
        </p>
      </div>

      {/* ============================================================ */}
      {/*  Notification preferences                                      */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Bell className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Notificaciones
          </h2>
        </div>

        <p className="text-sm text-[#8A877D]">
          Controla que notificaciones recibes por WhatsApp.
        </p>

        {/* Recordatorios — functional toggle */}
        <div className="flex items-start justify-between gap-4 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#C8C6BC]">Recordatorios</p>
            <p className="text-xs text-[#8A877D] mt-0.5">Recordatorio diario a las 8pm para registrar gastos</p>
          </div>
          <button
            disabled={recordatoriosLoading}
            onClick={async () => {
              setRecordatoriosLoading(true);
              const newVal = !recordatoriosActivos;
              try {
                const res = await fetch('/api/notifications', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ recordatorios_activos: newVal }),
                });
                if (res.ok) {
                  setRecordatoriosActivos(newVal);
                  toast.success(newVal ? 'Recordatorios activados' : 'Recordatorios desactivados');
                } else {
                  toast.error('Error al actualizar');
                }
              } catch {
                toast.error('Error de conexion');
              } finally {
                setRecordatoriosLoading(false);
              }
            }}
            className={`shrink-0 mt-0.5 h-5 w-9 rounded-full relative transition-colors cursor-pointer ${
              recordatoriosActivos ? 'bg-[#1D9E75]' : 'bg-[#3A3A38]'
            } ${recordatoriosLoading ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              recordatoriosActivos ? 'right-0.5' : 'left-0.5'
            }`} />
          </button>
        </div>

        {/* Auto-managed toggles */}
        {[
          { key: 'resumen_diario', label: 'Resumen diario', desc: 'Resumen de gastos del dia a las 8pm' },
          { key: 'resumen_semanal', label: 'Resumen semanal', desc: 'Analisis comparativo cada domingo' },
          { key: 'alertas_presupuesto', label: 'Alertas de presupuesto', desc: 'Aviso al superar 80% o 100% de un presupuesto' },
        ].map((pref) => (
          <div key={pref.key} className="flex items-start justify-between gap-4 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#C8C6BC]">{pref.label}</p>
              <p className="text-xs text-[#8A877D] mt-0.5">{pref.desc}</p>
            </div>
            <div className="shrink-0 mt-0.5 h-5 w-9 rounded-full bg-[#1D9E75] relative">
              <span className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm" />
            </div>
          </div>
        ))}

        <p className="text-xs text-[#8A877D]">
          Los resumenes y alertas se envian automaticamente por WhatsApp. Solo los recordatorios se pueden activar o desactivar.
        </p>
      </div>

      {/* ============================================================ */}
      {/*  Data export                                                    */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Download className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">Exportar datos</h2>
        </div>
        <p className="text-sm text-[#8A877D]">
          Descarga todas tus transacciones, presupuestos y metas en formato JSON.
        </p>
        <Button
          variant="outline"
          className="w-full border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)] gap-2"
          onClick={async () => {
            try {
              const res = await fetch('/api/export');
              if (!res.ok) throw new Error('Error al exportar');
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `neto-export-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
              toast.success('Datos exportados correctamente');
            } catch {
              toast.error('Error al exportar datos');
            }
          }}
        >
          <Download className="h-4 w-4" />
          Descargar mis datos
        </Button>
      </div>

      {/* ============================================================ */}
      {/*  Session                                                       */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <Button
          variant="outline"
          className="w-full border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)]"
          disabled={signingOut}
          onClick={handleSignOut}
        >
          {signingOut ? 'Cerrando sesion...' : 'Cerrar sesion'}
        </Button>
      </div>

      {/* ============================================================ */}
      {/*  Danger zone                                                  */}
      {/* ============================================================ */}
      <div className="glass-card p-6 space-y-4 border-[#D85A30]/20 hover:border-[#D85A30]/40 transition-colors">
        <div className="flex items-center gap-2 mb-1">
          <Settings className="h-5 w-5 text-[#D85A30]" />
          <h2 className="text-sm font-semibold text-[#D85A30]">Zona de peligro</h2>
        </div>

        <Button
          variant="outline"
          className="w-full border-[#D85A30]/40 bg-transparent text-[#D85A30] hover:bg-[#D85A30]/10"
          onClick={() => setShowDeleteConfirm(true)}
        >
          Eliminar cuenta
        </Button>

        {/* Delete confirmation */}
        {showDeleteConfirm && (
          <div className="rounded-lg border border-[#D85A30]/30 bg-[#D85A30]/5 p-4 space-y-3">
            <p className="text-sm text-[#C8C6BC]">
              Para eliminar tu cuenta, contacta soporte por WhatsApp.
            </p>
            <div className="flex gap-2">
              <a
                href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero eliminar mi cuenta')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <Button
                  variant="outline"
                  className="w-full border-[#D85A30]/40 text-[#D85A30] hover:bg-[#D85A30]/10 gap-2"
                >
                  <MessageCircle className="h-4 w-4" />
                  Contactar soporte
                </Button>
              </a>
              <Button
                variant="outline"
                className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#8A877D] hover:bg-[rgba(255,255,255,0.05)]"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
    </FadeIn>
  );
}
