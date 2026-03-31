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
  Pencil,
  X,
  Tag,
  Trash2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  { label: 'Lectura automática de correos', free: false, premium: 'Ilimitadas (11 bancos)' },
  { label: 'Registro por WhatsApp', free: true, premium: true },
  { label: 'Imágenes Yape/Plin', free: true, premium: true },
  { label: 'Categorías personalizables', free: true, premium: true },
  { label: 'Presupuestos', free: 'Ilimitados', premium: 'Ilimitados' },
  { label: 'Metas de ahorro', free: 'Ilimitadas', premium: 'Ilimitadas' },
  { label: 'Dashboard', free: 'Mes actual', premium: 'Historial completo' },
  { label: 'Resumen diario', free: false, premium: true },
  { label: 'Resumen semanal IA', free: 'Básico', premium: 'Insights + comparativa' },
  { label: 'Score financiero', free: 'Número', premium: 'Desglose + tendencia' },
  { label: 'Consejo IA', free: '1/semana', premium: 'Ilimitado' },
  { label: 'Reportes PDF', free: false, premium: true },
  { label: 'Calendario financiero', free: false, premium: true },
  { label: 'Heatmap de gastos', free: false, premium: true },
  { label: 'Export CSV/JSON', free: false, premium: true },
  { label: 'Carga masiva Excel', free: false, premium: true },
  { label: 'Recordatorios diarios', free: false, premium: true },
  { label: 'Multimoneda USD/PEN', free: true, premium: true },
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

  /* ---- Edit name ---- */
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);

  /* ---- Categories ---- */
  interface CategoryItem {
    id: string;
    nombre: string;
    emoji?: string;
    subcategorias: { id: string; nombre: string }[];
  }
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [renamingCat, setRenamingCat] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deletingCat, setDeletingCat] = useState<string | null>(null);

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
    // Fetch categories
    fetchCategories();
  }, []);

  async function fetchCategories() {
    setCategoriesLoading(true);
    try {
      const res = await fetch('/api/categories');
      if (res.ok) {
        const data = await res.json();
        setCategories(data);
      }
    } catch { /* ignore */ }
    setCategoriesLoading(false);
  }

  /* ---- Save name ---- */
  async function handleSaveName() {
    if (!nameInput.trim() || nameInput.trim().length < 2) {
      toast.error('El nombre debe tener al menos 2 caracteres');
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch('/api/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: nameInput.trim() }),
      });
      if (res.ok) {
        toast.success('Nombre actualizado');
        setEditingName(false);
        // Refresh user data
        window.location.reload();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Error al actualizar');
      }
    } catch {
      toast.error('Error de conexion');
    }
    setSavingName(false);
  }

  /* ---- Delete category ---- */
  async function handleDeleteCategory(catId: string, isSub: boolean) {
    try {
      const res = await fetch(`/api/categories?id=${catId}&sub=${isSub}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Categoria eliminada');
        fetchCategories();
        setDeletingCat(null);
      } else {
        toast.error('Error al eliminar');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  /* ---- Rename category ---- */
  async function handleRenameCategory(catId: string) {
    if (!renameInput.trim() || renameInput.trim().length < 2) {
      toast.error('El nombre debe tener al menos 2 caracteres');
      return;
    }
    try {
      const res = await fetch('/api/categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: catId, nombre: renameInput.trim() }),
      });
      if (res.ok) {
        toast.success('Categoria renombrada');
        setRenamingCat(null);
        fetchCategories();
      } else {
        toast.error('Error al renombrar');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  function toggleExpand(catId: string) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

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
              className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-primary/20"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1D9E75] text-xl font-bold text-white">
              {getInitial(user.email)}
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-2">
            {/* Name + plan */}
            <div className="flex items-center gap-2">
              {editingName ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    className="h-8 text-sm bg-[rgba(255,255,255,0.05)] border-[rgba(255,255,255,0.1)] text-[#F0EFE8] max-w-[200px]"
                    placeholder="Tu nombre"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName();
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 bg-[#1D9E75] text-white hover:bg-[#178a64]"
                    onClick={handleSaveName}
                    disabled={savingName}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[#8A877D] hover:text-[#F0EFE8]"
                    onClick={() => setEditingName(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-[#F0EFE8] truncate">
                    {user.nombre || (user.email ? user.email.split('@')[0] : 'Usuario')}
                  </h2>
                  <button
                    className="shrink-0 p-1 rounded-md hover:bg-[rgba(255,255,255,0.05)] text-[#8A877D] hover:text-[#F0EFE8] transition-colors"
                    onClick={() => {
                      setNameInput(user.nombre || '');
                      setEditingName(true);
                    }}
                    title="Editar nombre"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              {!editingName && (user.plan === 'premium' ? (
                <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 gap-1 shrink-0">
                  <Crown className="h-3 w-3" />
                  Neto Pro
                </Badge>
              ) : (
                <Badge className="bg-[#87948c]/20 text-[#87948c] border-[#87948c]/30 gap-1 shrink-0">
                  Free
                </Badge>
              ))}
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
          <span className="text-sm font-medium text-[#1D9E75]">Neto Pro</span>
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

        {/* Feature list */}
        <div className="overflow-x-auto -mx-1 glass-card-depth rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#8A877D]">
                <th className="text-left font-medium py-2 pr-4">Funcion incluida</th>
                <th className="text-center font-medium py-2 px-3">Tu plan</th>
              </tr>
            </thead>
            <tbody>
              {PLAN_FEATURES.map((f) => (
                <tr key={f.label} className="border-t border-[rgba(255,255,255,0.04)]">
                  <td className="py-2.5 pr-4 text-[#C8C6BC]">{f.label}</td>
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
          Invita a 3 amigos. Cuando se suscriban y estén activos, tu siguiente mes es gratis.
        </p>

        {/* Referral link */}
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#C8C6BC] truncate">
            {referralLink}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 border-[rgba(255,255,255,0.1)] bg-transparent hover:bg-[rgba(255,255,255,0.05)] transition-all duration-200 active:scale-95"
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
      {/*  Categories management                                          */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Tag className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Gestionar categorias
          </h2>
        </div>

        <p className="text-sm text-[#8A877D]">
          Renombra o elimina categorias y subcategorias. Las transacciones existentes mantienen su categoria original.
        </p>

        {categoriesLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        ) : categories.length === 0 ? (
          <p className="text-sm text-[#8A877D] py-4 text-center">
            No tienes categorias personalizadas. Se crean automaticamente al registrar gastos.
          </p>
        ) : (
          <div className="space-y-1">
            {categories.map((cat) => (
              <div key={cat.id}>
                {/* Category row */}
                <div className="flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-3 py-2.5">
                  {/* Expand toggle */}
                  {cat.subcategorias.length > 0 ? (
                    <button
                      className="shrink-0 p-0.5 text-[#8A877D] hover:text-[#F0EFE8]"
                      onClick={() => toggleExpand(cat.id)}
                    >
                      {expandedCats.has(cat.id) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                  ) : (
                    <span className="shrink-0 w-5" />
                  )}

                  {/* Emoji + name */}
                  {renamingCat === cat.id ? (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Input
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        className="h-7 text-sm bg-[rgba(255,255,255,0.05)] border-[rgba(255,255,255,0.1)] text-[#F0EFE8] max-w-[180px]"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameCategory(cat.id);
                          if (e.key === 'Escape') setRenamingCat(null);
                        }}
                      />
                      <Button size="sm" className="h-6 px-1.5 bg-[#1D9E75] text-white hover:bg-[#178a64]" onClick={() => handleRenameCategory(cat.id)}>
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[#8A877D]" onClick={() => setRenamingCat(null)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className="text-sm font-medium text-[#F0EFE8] flex-1 min-w-0 truncate">
                        {cat.emoji ? `${cat.emoji} ` : ''}{cat.nombre}
                      </span>
                      <span className="text-xs text-[#8A877D] shrink-0">
                        {cat.subcategorias.length > 0 ? `${cat.subcategorias.length} sub` : ''}
                      </span>
                    </>
                  )}

                  {/* Actions */}
                  {renamingCat !== cat.id && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className="p-1 rounded text-[#8A877D] hover:text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.05)]"
                        onClick={() => { setRenamingCat(cat.id); setRenameInput(cat.nombre); }}
                        title="Renombrar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {deletingCat === cat.id ? (
                        <div className="flex items-center gap-1">
                          <Button size="sm" className="h-6 px-1.5 bg-[#D85A30] text-white hover:bg-[#D85A30]/80 text-xs" onClick={() => handleDeleteCategory(cat.id, false)}>
                            Si
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[#8A877D] text-xs" onClick={() => setDeletingCat(null)}>
                            No
                          </Button>
                        </div>
                      ) : (
                        <button
                          className="p-1 rounded text-[#8A877D] hover:text-[#D85A30] hover:bg-[rgba(216,90,48,0.05)]"
                          onClick={() => setDeletingCat(cat.id)}
                          title="Eliminar"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Subcategories */}
                {expandedCats.has(cat.id) && cat.subcategorias.length > 0 && (
                  <div className="ml-7 mt-0.5 space-y-0.5">
                    {cat.subcategorias.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.015)] border border-[rgba(255,255,255,0.04)] px-3 py-2">
                        {renamingCat === sub.id ? (
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Input
                              value={renameInput}
                              onChange={(e) => setRenameInput(e.target.value)}
                              className="h-7 text-sm bg-[rgba(255,255,255,0.05)] border-[rgba(255,255,255,0.1)] text-[#F0EFE8] max-w-[160px]"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameCategory(sub.id);
                                if (e.key === 'Escape') setRenamingCat(null);
                              }}
                            />
                            <Button size="sm" className="h-6 px-1.5 bg-[#1D9E75] text-white hover:bg-[#178a64]" onClick={() => handleRenameCategory(sub.id)}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[#8A877D]" onClick={() => setRenamingCat(null)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm text-[#C8C6BC] flex-1 min-w-0 truncate">{sub.nombre}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                className="p-1 rounded text-[#8A877D] hover:text-[#F0EFE8] hover:bg-[rgba(255,255,255,0.05)]"
                                onClick={() => { setRenamingCat(sub.id); setRenameInput(sub.nombre); }}
                                title="Renombrar"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              {deletingCat === sub.id ? (
                                <div className="flex items-center gap-1">
                                  <Button size="sm" className="h-6 px-1.5 bg-[#D85A30] text-white hover:bg-[#D85A30]/80 text-xs" onClick={() => handleDeleteCategory(sub.id, true)}>
                                    Si
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[#8A877D] text-xs" onClick={() => setDeletingCat(null)}>
                                    No
                                  </Button>
                                </div>
                              ) : (
                                <button
                                  className="p-1 rounded text-[#8A877D] hover:text-[#D85A30] hover:bg-[rgba(216,90,48,0.05)]"
                                  onClick={() => setDeletingCat(sub.id)}
                                  title="Eliminar"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
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
