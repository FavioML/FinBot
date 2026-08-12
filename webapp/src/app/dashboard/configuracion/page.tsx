'use client';

import { useState, useEffect, useRef, type ReactNode, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import NextLink from 'next/link';
import Image from 'next/image';
import { toast } from 'sonner';
import { FadeIn } from '@/components/shared/motion-wrapper';
import {
  User,
  Mail,
  Phone,
  Crown,
  Calendar,
  Link as LinkIcon,
  Copy,
  Check,
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
  Plus,
  ChevronDown,
  ChevronRight,
  LogOut,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfiguracionSkeleton } from '@/components/dashboard/skeletons';
import { useUser } from '@/lib/hooks/use-user';
import { createClient } from '@/lib/supabase/client';
import { signOutAndClear } from '@/lib/query-client';
import { SOCIAL_LINKS, getCategoriaEmoji, CATEGORIAS, PRO_PRICE_MONTHLY_PEN } from '@/lib/constants';
import { capitalizeDisplay } from '@/lib/format';
import { enTrial } from '@/lib/plan';
import { cn } from '@/lib/utils';
import { HeaderActions } from '@/components/dashboard/topbar';
import { optOutTracking, optInTracking, hasOptedOut } from '@/lib/analytics';

/* ------------------------------------------------------------------ */
/*  Plan highlights (Pro-only, para tentar a usuarios Free)            */
/* ------------------------------------------------------------------ */
const PRO_HIGHLIGHTS = [
  'Lectura automática de correos bancarios',
  'Reportes PDF y calendario financiero',
  'Consejo IA ilimitado + score con desglose',
  'Historial completo y export CSV/JSON',
] as const;

/* ------------------------------------------------------------------ */
/*  Nav (índice sticky desktop)                                        */
/* ------------------------------------------------------------------ */
const NAV_GROUPS = [
  {
    label: 'Cuenta',
    items: [
      { id: 'perfil', label: 'Perfil' },
      { id: 'plan', label: 'Tu plan' },
      { id: 'referidos', label: 'Referidos' },
      { id: 'cuentas', label: 'Cuentas conectadas' },
    ],
  },
  {
    label: 'Preferencias',
    items: [
      { id: 'apariencia', label: 'Apariencia' },
      { id: 'notificaciones', label: 'Notificaciones' },
      { id: 'categorias', label: 'Categorías' },
    ],
  },
  {
    label: 'Datos y privacidad',
    items: [
      { id: 'privacidad', label: 'Privacidad' },
      { id: 'exportar', label: 'Exportar datos' },
    ],
  },
  {
    label: 'Sesión',
    items: [{ id: 'sesion', label: 'Sesión y cuenta' }],
  },
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
/*  Presentational primitives                                          */
/* ------------------------------------------------------------------ */
function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
      {children}
    </h2>
  );
}

function Section({
  id,
  icon: Icon,
  title,
  description,
  action,
  children,
  tone = 'default',
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-24 glass-card p-5 sm:p-6 space-y-4',
        danger && 'border-destructive/20 hover:border-destructive/40 transition-colors'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className={cn('h-[18px] w-[18px] shrink-0', danger ? 'text-destructive' : 'text-muted-foreground')} />
            <h3 className={cn('text-base font-semibold', danger ? 'text-destructive' : 'text-foreground')}>{title}</h3>
          </div>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  loading,
  onToggle,
  badge,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  onToggle?: (v: boolean) => void;
  badge?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-secondary-foreground">{title}</p>
          {badge}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled || loading}
        onCheckedChange={(v) => onToggle?.(v)}
        className={cn('mt-0.5 shrink-0', loading && 'opacity-50')}
      />
    </div>
  );
}

/* ---- Apariencia: preview visual del tema ---- */
function ThemePreview({ variant }: { variant: 'dark' | 'light' }) {
  const isDark = variant === 'dark';
  return (
    <div
      className={cn(
        'flex h-14 w-full overflow-hidden rounded-lg border',
        isDark ? 'border-white/10 bg-[#0E0E0C]' : 'border-black/10 bg-[#F4F3EE]'
      )}
    >
      <div className={cn('w-1/4 border-r', isDark ? 'border-white/10 bg-[#131311]' : 'border-black/10 bg-white')} />
      <div className="flex-1 space-y-1.5 p-2">
        <div className={cn('h-1.5 w-2/3 rounded-full', isDark ? 'bg-white/20' : 'bg-black/15')} />
        <div className="h-2.5 w-1/2 rounded-full bg-primary/70" />
        <div className={cn('h-1.5 w-3/4 rounded-full', isDark ? 'bg-white/10' : 'bg-black/10')} />
      </div>
    </div>
  );
}

function ThemeOption({
  variant,
  active,
  disabled,
  icon: Icon,
  label,
  caption,
}: {
  variant: 'dark' | 'light';
  active?: boolean;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  caption: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-all',
        active
          ? 'border-primary bg-primary/[0.06]'
          : 'border-border bg-muted/30',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:border-border/80'
      )}
    >
      <ThemePreview variant={variant} />
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
        <span className={cn('text-sm font-medium', active ? 'text-foreground' : 'text-secondary-foreground')}>{label}</span>
        {active && <span className="ml-auto h-2 w-2 rounded-full bg-primary" />}
        {disabled && (
          <Badge className="ml-auto border-border bg-muted/60 px-1.5 py-0 text-[9px] text-muted-foreground">
            Pronto
          </Badge>
        )}
      </div>
      <span className="text-[11px] text-muted-foreground">{caption}</span>
    </button>
  );
}

/* ---- Confirmación de borrado de categoría/sub (con aviso de transacciones) ---- */
function DeleteConfirmPanel({
  loading,
  count,
  isRoot,
  href,
  onConfirm,
  onCancel,
}: {
  loading: boolean;
  count: number;
  isRoot: boolean;
  href: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
      {loading ? (
        <p className="text-xs text-muted-foreground">Revisando transacciones…</p>
      ) : count > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-secondary-foreground">
            Hay <span className="font-semibold text-foreground">{count}</span>{' '}
            {count === 1 ? 'transacción' : 'transacciones'} en esta {isRoot ? 'categoría' : 'subcategoría'}. Al eliminar,{' '}
            {isRoot
              ? 'pasarán a «Por revisar» para que las reclasifiques, y se borrarán sus presupuestos, reglas y alertas.'
              : 'quedarán con su categoría principal, y se borrarán los presupuestos de esta subcategoría.'}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <NextLink href={href} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
              Revisar transacciones
              <ChevronRight className="h-3.5 w-3.5" />
            </NextLink>
            <button className="text-xs font-medium text-destructive hover:underline" onClick={onConfirm}>
              Eliminar de todos modos
            </button>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* Sin transacciones NO significa sin consecuencias: el borrado se lleva
              presupuestos, reglas y alertas igual, y /api/categories/usage solo cuenta
              transacciones. Antes acá decía solo "¿Eliminar esta categoría?". */}
          <p className="flex-1 text-xs text-secondary-foreground">
            ¿Eliminar esta {isRoot ? 'categoría' : 'subcategoría'}? Se borran también sus presupuestos
            {isRoot ? ', reglas y alertas' : ''}.
          </p>
          <Button size="sm" className="h-6 bg-destructive px-2 text-xs text-white hover:bg-destructive/80" onClick={onConfirm}>
            Eliminar
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
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
  // Cambiar/desvincular número de WhatsApp (self-serve)
  const [changingNumber, setChangingNumber] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [recordatoriosActivos, setRecordatoriosActivos] = useState(true);
  const [recordatoriosLoading, setRecordatoriosLoading] = useState(false);
  const [manosLibres, setManosLibres] = useState(false);
  const [manosLibresLoading, setManosLibresLoading] = useState(false);
  const [alertasTransaccion, setAlertasTransaccion] = useState(true);
  const [alertasTransaccionLoading, setAlertasTransaccionLoading] = useState(false);
  const [analyticsOptedOut, setAnalyticsOptedOut] = useState(false);
  const [activeSection, setActiveSection] = useState('perfil');
  // Al hacer clic en el índice fijamos la sección y suspendemos el scroll-spy
  // hasta que el usuario haga un gesto real (wheel/touch/teclado). Sin esto, el
  // scroll programático del clic dispara el recálculo y en páginas cortas el
  // borde inferior "roba" el resaltado hacia la última sección.
  const spyLocked = useRef(false);

  /* ---- Edit name ---- */
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);

  /* ---- Categories ---- */
  interface CategoryItem {
    id: string;
    nombre: string;
    emoji?: string;
    subcategorias: { id: string | null; nombre: string; system?: boolean; from_tx?: boolean }[];
    deletedSubNames?: string[];
  }
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [renamingCat, setRenamingCat] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deletingCat, setDeletingCat] = useState<string | null>(null);
  // Conteo de transacciones ligadas al ítem que se está por eliminar
  const [deleteInfo, setDeleteInfo] = useState<{ count: number; loading: boolean }>({ count: 0, loading: false });
  // Crear categoría raíz
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newRootInput, setNewRootInput] = useState('');
  const [savingRoot, setSavingRoot] = useState(false);
  // Crear subcategoría (por categoría padre)
  const [addingSubTo, setAddingSubTo] = useState<string | null>(null);
  const [newSubInput, setNewSubInput] = useState('');
  const [savingSub, setSavingSub] = useState(false);

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
        if (typeof d.manos_libres === 'boolean') {
          setManosLibres(d.manos_libres);
        }
        if (typeof d.alertas_transaccion === 'boolean') {
          setAlertasTransaccion(d.alertas_transaccion);
        }
      })
      .catch(() => {});
    // Fetch categories
    fetchCategories();
    // Estado de consentimiento de analytics (posthog se carga async)
    hasOptedOut().then(setAnalyticsOptedOut);
  }, []);

  /* ---- Scroll spy para el índice sticky ---- */
  useEffect(() => {
    if (isLoading) return;
    const ids = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    // Marca activa la última sección cuya parte superior cruzó una línea guía
    // ~140px bajo el topbar. Recorre todas las secciones (no una banda fina),
    // así las secciones cortas del fondo también activan su ítem.
    const line = 140;
    function computeActive() {
      if (spyLocked.current) return; // un clic en el índice manda hasta que el usuario scrollee
      let current = els[0].id;
      for (const el of els) {
        if (el.getBoundingClientRect().top - line <= 0) current = el.id;
        else break;
      }
      // La última sección (corta) puede no cruzar la guía nunca; la forzamos
      // SOLO si la página realmente scrollea y estamos al fondo. Sin el guard
      // `scrollable`, una página que entra entera en el viewport —o el primer
      // render corto antes de que cargue el contenido async— cuenta como "al
      // fondo" y le roba el resaltado a la última sección estando arriba del todo.
      const scrollable = document.body.scrollHeight > window.innerHeight + 8;
      const atBottom = scrollable && window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
      setActiveSection(atBottom ? els[els.length - 1].id : current);
    }
    function unlockSpy() { spyLocked.current = false; }

    computeActive();
    window.addEventListener('scroll', computeActive, { passive: true });
    window.addEventListener('resize', computeActive);
    // Solo un gesto real del usuario reactiva el scroll-spy tras un clic.
    window.addEventListener('wheel', unlockSpy, { passive: true });
    window.addEventListener('touchmove', unlockSpy, { passive: true });
    window.addEventListener('keydown', unlockSpy);
    return () => {
      window.removeEventListener('scroll', computeActive);
      window.removeEventListener('resize', computeActive);
      window.removeEventListener('wheel', unlockSpy);
      window.removeEventListener('touchmove', unlockSpy);
      window.removeEventListener('keydown', unlockSpy);
    };
  }, [isLoading, categoriesLoading]);

  async function fetchCategories() {
    setCategoriesLoading(true);
    try {
      const res = await fetch('/api/categories');
      if (res.ok) {
        const dbCats: CategoryItem[] = await res.json();
        // API already merges DB + transactions subcategories.
        // Also add hardcoded subs that may not appear in either source yet.
        const merged = dbCats.map((cat) => {
          const hardcoded = CATEGORIAS.find((c) => c.nombre.toLowerCase() === cat.nombre.toLowerCase());
          const existingLower = new Set(cat.subcategorias.map((s) => s.nombre.toLowerCase()));
          // Subs borradas/renombradas: no re-mostrar el default hardcodeado.
          const deletedLower = new Set((cat.deletedSubNames ?? []).map((n) => n.toLowerCase()));
          const isSuppressed = (s: string) => {
            const variants = [s.toLowerCase(), s.replace(/_/g, ' ').toLowerCase(), capitalizeDisplay(s).toLowerCase()];
            return variants.some((v) => existingLower.has(v) || deletedLower.has(v));
          };
          const hardcodedExtras = hardcoded
            ? hardcoded.subs
                .filter((s) => !isSuppressed(s))
                .map((s) => ({ id: null, nombre: capitalizeDisplay(s), system: true }))
            : [];
          const allSubs = [
            ...cat.subcategorias.map((s) => ({
              ...s,
              nombre: capitalizeDisplay(s.nombre),
              system: !s.id || undefined,
            })),
            ...hardcodedExtras,
          ].sort((a, b) => a.nombre.localeCompare(b.nombre));
          return { ...cat, subcategorias: allSubs };
        });
        setCategories(merged);
      }
    } catch {
      /* ignore */
    }
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
        window.location.reload();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Error al actualizar');
      }
    } catch {
      toast.error('Error de conexión');
    }
    setSavingName(false);
  }

  /* ---- Delete category ---- */
  async function handleDeleteCategory(catId: string, isSub: boolean) {
    try {
      const res = await fetch(`/api/categories?id=${catId}&sub=${isSub}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Categoría eliminada');
        fetchCategories();
        setDeletingCat(null);
      } else {
        toast.error('Error al eliminar');
      }
    } catch {
      toast.error('Error de conexión');
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
        toast.success('Categoría renombrada');
        setRenamingCat(null);
        fetchCategories();
      } else {
        toast.error('Error al renombrar');
      }
    } catch {
      toast.error('Error de conexión');
    }
  }

  /* ---- Create root category ---- */
  async function handleCreateRoot() {
    const nombre = newRootInput.trim();
    if (nombre.length < 2) {
      toast.error('El nombre debe tener al menos 2 caracteres');
      return;
    }
    setSavingRoot(true);
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre }),
      });
      if (res.ok) {
        toast.success('Categoría creada');
        setCreatingRoot(false);
        setNewRootInput('');
        fetchCategories();
      } else if (res.status === 409) {
        toast.error('Ya existe una categoría con ese nombre');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error al crear');
      }
    } catch {
      toast.error('Error de conexión');
    }
    setSavingRoot(false);
  }

  /* ---- Create subcategory ---- */
  async function handleCreateSub(catId: string) {
    const nombre = newSubInput.trim();
    if (nombre.length < 2) {
      toast.error('El nombre debe tener al menos 2 caracteres');
      return;
    }
    setSavingSub(true);
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, padreId: catId }),
      });
      if (res.ok) {
        toast.success('Subcategoría creada');
        setAddingSubTo(null);
        setNewSubInput('');
        fetchCategories();
      } else if (res.status === 409) {
        toast.error('Ya existe una subcategoría con ese nombre');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Error al crear');
      }
    } catch {
      toast.error('Error de conexión');
    }
    setSavingSub(false);
  }

  /* ---- Rename a system subcategory (materializes it) ---- */
  async function handleRenameSystemSub(catId: string, oldNombre: string) {
    if (!renameInput.trim() || renameInput.trim().length < 2) {
      toast.error('El nombre debe tener al menos 2 caracteres');
      return;
    }
    try {
      const res = await fetch('/api/categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: true, padreId: catId, oldNombre, nombre: renameInput.trim() }),
      });
      if (res.ok) {
        toast.success('Subcategoría renombrada');
        setRenamingCat(null);
        fetchCategories();
      } else if (res.status === 409) {
        toast.error('Ya existe una subcategoría con ese nombre');
      } else {
        toast.error('Error al renombrar');
      }
    } catch {
      toast.error('Error de conexión');
    }
  }

  /* ---- Delete a system subcategory (tombstones it) ---- */
  async function handleDeleteSystemSub(catId: string, nombre: string) {
    try {
      const params = new URLSearchParams({ system: 'true', padreId: catId, nombre });
      const res = await fetch(`/api/categories?${params.toString()}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Subcategoría eliminada');
        setDeletingCat(null);
        fetchCategories();
      } else {
        toast.error('Error al eliminar');
      }
    } catch {
      toast.error('Error de conexión');
    }
  }

  // Clave estable para rename/delete: id real, o compuesta para subs system (id null).
  function subKey(catId: string, sub: { id: string | null; nombre: string }) {
    return sub.id ?? `sys:${catId}:${sub.nombre}`;
  }

  // Abrir la confirmación de borrado: marca el ítem y consulta cuántas
  // transacciones lo referencian (para avisar + ofrecer "Revisar" antes de borrar).
  async function startDelete(key: string, q: { categoria: string; sub?: string }) {
    setDeletingCat(key);
    setDeleteInfo({ count: 0, loading: true });
    try {
      const params = new URLSearchParams({ nombre: q.categoria });
      if (q.sub) params.set('sub', q.sub);
      const res = await fetch(`/api/categories/usage?${params.toString()}`);
      const data = res.ok ? await res.json() : { count: 0 };
      setDeleteInfo({ count: typeof data.count === 'number' ? data.count : 0, loading: false });
    } catch {
      setDeleteInfo({ count: 0, loading: false });
    }
  }

  function cancelDelete() {
    setDeletingCat(null);
    setDeleteInfo({ count: 0, loading: false });
  }

  function reviewHref(categoria: string, sub?: string) {
    const params = new URLSearchParams({ categoria });
    if (sub) params.set('sub', sub);
    return `/dashboard/transacciones?${params.toString()}`;
  }

  function toggleExpand(catId: string) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  const isPremium = user?.plan === 'premium';
  // Pro pagado y Pro de prueba comparten `plan === 'premium'` (así el trial entrega Pro sin
  // tocar los ~40 gates que miran esa columna), pero en la pantalla donde el usuario viene a
  // ver QUÉ tiene contratado, colapsarlos es mentirle. El predicado vive en `@/lib/plan`
  // para que esta pantalla, el banner y /dashboard/pro no puedan responder distinto.
  const enPrueba = enTrial(user?.plan, user?.trial_estado);

  /* ---- Referidos: link REAL (ref_code) + progreso dos-lados desde el backend ---- */
  const {
    data: referrals,
    isError: referralsError,
    isFetching: referralsFetching,
    refetch: refetchReferrals,
  } = useQuery({
    queryKey: ['user-referrals'],
    queryFn: async () => {
      const r = await fetch('/api/user/referrals', { cache: 'no-store' });
      if (!r.ok) throw new Error('referrals');
      return r.json() as Promise<{ refCode: string; link: string; invitados: number; referidosPro: number; meses: number }>;
    },
  });
  const referralFullLink = referrals?.link ?? '';
  // Sin estado de error, un fallo de la query dejaba "Generando tu link…" para siempre: el
  // usuario esperaba algo que nunca iba a llegar, sin forma de reintentar y sin saber que
  // había fallado. Y no es una pantalla cualquiera — es la que reparte los referidos, o sea
  // el único canal de crecimiento propio (F1, auditoría CTO ola 4).
  //
  // El retry es explícito porque React Query ya agotó el suyo (`retry: 1`, query-client.ts):
  // si llegamos acá, reintentar solo ya se probó y falló.
  const referralLink = referralFullLink
    ? referralFullLink.replace(/^https?:\/\//, '')
    : referralsError
      ? 'No pudimos cargar tu link'
      : 'Generando tu link…';

  /* ---- Copy referral link ---- */
  async function handleCopy() {
    if (!referralFullLink) return;
    try {
      await navigator.clipboard.writeText(referralFullLink);
      setCopied(true);
      toast.success('Link copiado al portapapeles');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('No se pudo copiar');
    }
  }

  /* ---- Notifications toggle helper ---- */
  async function patchNotification(
    payload: Record<string, boolean>,
    apply: (v: boolean) => void,
    setLoading: (v: boolean) => void,
    okMsg: [string, string]
  ) {
    const key = Object.keys(payload)[0];
    const newVal = payload[key];
    setLoading(true);
    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        apply(newVal);
        toast.success(newVal ? okMsg[0] : okMsg[1]);
      } else {
        toast.error('Error al actualizar');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoading(false);
    }
  }

  /* ---- Desvincular WhatsApp (cambiar número) ---- */
  async function handleUnlinkWhatsapp() {
    setUnlinking(true);
    try {
      const res = await fetch('/api/whatsapp/unlink', { method: 'POST' });
      if (res.ok) {
        // Re-vincula el número correcto con el flujo reverse-OTP existente.
        router.push('/onboarding');
        return;
      }
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || 'No se pudo desvincular. Intenta de nuevo.');
      setUnlinking(false);
    } catch {
      toast.error('Error de conexión');
      setUnlinking(false);
    }
  }

  /* ---- Sign out ---- */
  async function handleSignOut() {
    setSigningOut(true);
    await signOutAndClear();
    router.push('/login');
  }

  /* ---------------------------------------------------------------- */
  /*  Loading skeleton                                                 */
  /* ---------------------------------------------------------------- */
  if (isLoading) {
    return <ConfiguracionSkeleton />;
  }

  /* ---------------------------------------------------------------- */
  /*  No user                                                          */
  /* ---------------------------------------------------------------- */
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 rounded-full bg-muted/40 p-6">
          <User className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-lg font-semibold text-foreground">Inicia sesión para ver tu configuración</h3>
        <p className="mb-6 max-w-md text-sm text-muted-foreground">Conecta tu cuenta para administrar tu perfil y plan.</p>
        <Button className="bg-primary text-white hover:bg-primary/90" onClick={() => router.push('/login')}>
          Iniciar sesión
        </Button>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <FadeIn>
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Configuración</h1>
          <HeaderActions />
        </div>

        <div className="lg:grid lg:grid-cols-[196px_1fr] lg:items-start lg:gap-8">
          {/* ---- Sticky nav (desktop) ---- */}
          <nav className="sticky top-6 hidden self-start lg:block">
            <div className="space-y-4">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="space-y-1">
                  <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                    {group.label}
                  </p>
                  {group.items.map((item) => (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      onClick={() => {
                        spyLocked.current = true;
                        setActiveSection(item.id);
                      }}
                      className={cn(
                        'block rounded-lg px-3 py-1.5 text-sm transition-colors',
                        activeSection === item.id
                          ? 'bg-primary/10 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/50 hover:text-secondary-foreground'
                      )}
                    >
                      {item.label}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </nav>

          {/* ---- Content ---- */}
          <div className="space-y-8">
            {/* ============================================================ */}
            {/*  GROUP: Cuenta                                                */}
            {/* ============================================================ */}
            <div className="space-y-4">
              <GroupHeading>Cuenta</GroupHeading>

              {/* Perfil */}
              <section id="perfil" className="scroll-mt-24 glass-card glass-card-glow p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  {avatarUrl ? (
                    <Image
                      src={avatarUrl}
                      alt={user.nombre || ''}
                      width={56}
                      height={56}
                      className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-primary/20"
                    />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-white">
                      {getInitial(user.email)}
                    </div>
                  )}

                  <div className="min-w-0 flex-1 space-y-2">
                    {/* Name + plan */}
                    <div className="flex items-center gap-2">
                      {editingName ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <Input
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            className="form-input h-8 max-w-[200px] text-sm"
                            placeholder="Tu nombre"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveName();
                              if (e.key === 'Escape') setEditingName(false);
                            }}
                          />
                          <Button
                            size="sm"
                            className="h-7 bg-primary px-2 text-white hover:bg-primary/90"
                            onClick={handleSaveName}
                            disabled={savingName}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingName(false)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <h3 className="truncate text-lg font-semibold text-foreground">
                            {user.nombre || (user.email ? user.email.split('@')[0] : 'Usuario')}
                          </h3>
                          <button
                            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
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
                      {/* Durante el trial `plan` vale 'premium', así que sin este caso el
                          badge decía "Neto Pro" a secas y la persona creía que ya paga.
                          Eso convierte el día 15 en una sorpresa — exactamente el churn
                          que el trial vino a evitar. */}
                      {!editingName &&
                        (enPrueba ? (
                          <Badge className="shrink-0 gap-1 border-primary/30 bg-primary/15 text-primary">
                            <Sparkles className="h-3 w-3" />
                            Prueba Pro
                          </Badge>
                        ) : isPremium ? (
                          <Badge className="shrink-0 gap-1 border-primary/30 bg-primary/20 text-primary">
                            <Crown className="h-3 w-3" />
                            Neto Pro
                          </Badge>
                        ) : (
                          <Badge className="shrink-0 gap-1 border-secondary-foreground/30 bg-secondary-foreground/15 text-secondary-foreground">
                            Free
                          </Badge>
                        ))}
                    </div>

                    {/* Email */}
                    {user.email && (
                      <div className="flex items-center gap-2 text-sm">
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-secondary-foreground">{user.email}</span>
                      </div>
                    )}

                    {/* WhatsApp */}
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {user.whatsapp ? (
                        <span className="text-secondary-foreground">{user.whatsapp}</span>
                      ) : (
                        <NextLink href="/onboarding" className="text-[#1D9E75] hover:underline">
                          Conectar WhatsApp (opcional)
                        </NextLink>
                      )}
                    </div>

                    {/* Member since */}
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-muted-foreground">Miembro desde {formatDate(user.created_at)}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Tu plan (comprimido) */}
              <Section id="plan" icon={Shield} title="Tu plan">
                <div className="space-y-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-secondary-foreground">Plan actual</span>
                    <span className={cn('text-sm font-semibold', isPremium ? 'text-primary' : 'text-secondary-foreground')}>
                      {enPrueba ? 'Neto Pro · prueba' : isPremium ? 'Neto Pro' : 'Free'}
                    </span>
                  </div>
                  {/* En el trial la fecha NO puede faltar: `plan_expiry` está vacío durante
                      la prueba, así que sin esto el usuario veía un plan Pro sin vencimiento
                      y daba por hecho que era permanente. La fecha del trial es lo único que
                      hace que el día 15 no sorprenda. */}
                  {enPrueba && user.trial_vence && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-secondary-foreground">Termina el</span>
                      <span className="text-sm font-medium text-[var(--color-neto-amber)]">{formatDate(user.trial_vence)}</span>
                    </div>
                  )}
                  {!enPrueba && isPremium && user.plan_expiry && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-secondary-foreground">Vence el</span>
                      <span className="text-sm font-medium text-[var(--color-neto-amber)]">{formatDate(user.plan_expiry)}</span>
                    </div>
                  )}
                  {enPrueba && (
                    <p className="text-xs text-muted-foreground">
                      Estás probando Neto Pro gratis. Cuando termine, sigo anotando tus gastos por
                      WhatsApp; el dashboard y el historial se cierran hasta que actives Pro.
                    </p>
                  )}
                </div>

                {isPremium ? (
                  <NextLink
                    href="/dashboard/pro"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                  >
                    Ver planes y precios
                    <ChevronRight className="h-4 w-4" />
                  </NextLink>
                ) : (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold text-foreground">Activa Neto Pro</span>
                    </div>
                    <ul className="mb-3 space-y-1">
                      {PRO_HIGHLIGHTS.map((h) => (
                        <li key={h} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          {h}
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center gap-3">
                      <NextLink
                        href="/dashboard/pro"
                        className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
                      >
                        Pasar a Pro — S/{PRO_PRICE_MONTHLY_PEN}/mes
                      </NextLink>
                      <NextLink href="/dashboard/pro" className="text-xs font-medium text-muted-foreground hover:text-secondary-foreground">
                        Ver planes y precios
                      </NextLink>
                    </div>
                  </div>
                )}
              </Section>

              {/* Referidos */}
              <Section
                id="referidos"
                icon={LinkIcon}
                title="Programa de referidos"
                description="Cuando un amigo se hace Pro con tu link, ganas 1 mes gratis — y él estrena Pro a mitad de precio su primer mes."
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm ${
                      referralsError && !referralFullLink ? 'text-muted-foreground' : 'text-secondary-foreground'
                    }`}
                  >
                    {referralLink}
                  </div>
                  {referralsError && !referralFullLink ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 border-border bg-transparent transition-all duration-200 hover:bg-white/[0.05] active:scale-95"
                      onClick={() => refetchReferrals()}
                      disabled={referralsFetching}
                    >
                      {referralsFetching ? 'Reintentando…' : 'Reintentar'}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 border-border bg-transparent transition-all duration-200 hover:bg-white/[0.05] active:scale-95"
                      onClick={handleCopy}
                      disabled={!referralFullLink}
                    >
                      {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Invitados', value: referrals?.invitados ?? 0 },
                    { label: 'Referidos Pro', value: referrals?.referidosPro ?? 0 },
                    { label: 'Meses ganados', value: referrals?.meses ?? 0 },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg border border-border bg-muted/40 px-2 py-3">
                      <div className="text-xl font-bold tabular-nums text-secondary-foreground">{s.value}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{s.label}</div>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Cuentas conectadas */}
              <Section id="cuentas" icon={Mail} title="Cuentas conectadas">
                <div className="space-y-2.5">
                  {user.email && (
                    <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm text-secondary-foreground">{user.email}</span>
                      </div>
                      <Badge className="shrink-0 border-primary/30 bg-primary/20 text-xs text-primary">Activa</Badge>
                    </div>
                  )}

                  {/* WhatsApp — conéctalo para registrar por chat (una sola cuenta) */}
                  {user.whatsapp ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm text-secondary-foreground">{user.whatsapp}</span>
                        </div>
                        <Badge className="shrink-0 border-primary/30 bg-primary/20 text-xs text-primary">Conectado</Badge>
                      </div>

                      {/* Acción alineada a la izquierda: lejos de los FAB flotantes
                          (Agregar / WhatsApp) que viven fijos en la esquina derecha
                          y taparían un botón puesto ahí en ciertos scrolls móviles. */}
                      {!changingNumber && (
                        <button
                          onClick={() => setChangingNumber(true)}
                          className="inline-flex items-center gap-1.5 pl-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Cambiar número
                        </button>
                      )}

                      {/* Confirmación de desvinculación (cambiar número) */}
                      {changingNumber && (
                        <div className="space-y-2.5 rounded-lg border border-[var(--color-neto-amber)]/25 bg-[var(--color-neto-amber)]/[0.06] px-4 py-3">
                          <p className="text-xs text-secondary-foreground">
                            Vas a desvincular{' '}
                            <span className="font-semibold text-foreground">{user.whatsapp}</span>. Perderás el registro por
                            chat hasta que vincules el nuevo número. Tus datos y correos quedan intactos.
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              className="h-7 bg-primary px-3 text-xs text-white hover:bg-primary/90"
                              disabled={unlinking}
                              onClick={handleUnlinkWhatsapp}
                            >
                              {unlinking ? 'Desvinculando…' : 'Desvincular y cambiar'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              disabled={unlinking}
                              onClick={() => setChangingNumber(false)}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-sm text-secondary-foreground">WhatsApp</p>
                          <p className="text-xs text-muted-foreground">
                            Conéctalo y registra gastos por chat. Queda todo en una sola cuenta.
                          </p>
                        </div>
                      </div>
                      <NextLink
                        href="/onboarding"
                        className="shrink-0 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                      >
                        Conectar
                      </NextLink>
                    </div>
                  )}

                  {!user.email && !user.whatsapp && (
                    <p className="text-sm text-muted-foreground">No hay cuentas conectadas.</p>
                  )}
                </div>
              </Section>
            </div>

            {/* ============================================================ */}
            {/*  GROUP: Preferencias                                          */}
            {/* ============================================================ */}
            <div className="space-y-4">
              <GroupHeading>Preferencias</GroupHeading>

              {/* Apariencia */}
              <Section id="apariencia" icon={Palette} title="Apariencia" description="Elige cómo se ve tu Neto.">
                <div className="grid max-w-md grid-cols-2 gap-3">
                  <ThemeOption variant="dark" active icon={Moon} label="Oscuro" caption="Nocturnal Precision" />
                  <ThemeOption variant="light" disabled icon={Sun} label="Claro" caption="Muy pronto" />
                </div>
                <p className="text-xs text-muted-foreground">
                  El tema oscuro está diseñado para reducir la fatiga visual. El modo claro llega pronto.
                </p>
              </Section>

              {/* Notificaciones */}
              <Section
                id="notificaciones"
                icon={Bell}
                title="Notificaciones"
                description="Controla qué notificaciones recibes por WhatsApp."
              >
                <ToggleRow
                  title="Recordatorios"
                  description="Recordatorio diario a las 8pm + avisos de deudas próximas a vencer"
                  checked={recordatoriosActivos}
                  loading={recordatoriosLoading}
                  onToggle={(v) =>
                    patchNotification({ recordatorios_activos: v }, setRecordatoriosActivos, setRecordatoriosLoading, [
                      'Recordatorios activados',
                      'Recordatorios desactivados',
                    ])
                  }
                />

                <ToggleRow
                  title="Avisos de movimientos detectados"
                  description="Te aviso por WhatsApp cuando detecte un gasto en tu correo"
                  checked={alertasTransaccion}
                  loading={alertasTransaccionLoading}
                  onToggle={(v) =>
                    patchNotification({ alertas_transaccion: v }, setAlertasTransaccion, setAlertasTransaccionLoading, [
                      'Avisos de movimientos activados',
                      'Avisos de movimientos desactivados',
                    ])
                  }
                />

                <ToggleRow
                  title="Modo Manos Libres"
                  description="Resumen de lo que gastaste en el día, cada noche a las 9pm por WhatsApp"
                  checked={manosLibres && isPremium}
                  disabled={!isPremium}
                  loading={manosLibresLoading}
                  badge={
                    !isPremium ? (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">Pro</span>
                    ) : undefined
                  }
                  onToggle={(v) => {
                    if (!isPremium) return;
                    patchNotification({ manos_libres: v }, setManosLibres, setManosLibresLoading, [
                      'Modo Manos Libres activado',
                      'Modo Manos Libres desactivado',
                    ]);
                  }}
                />

                {/* Auto-managed (informativo, no toggle) */}
                {[
                  { key: 'resumen_semanal', label: 'Resumen semanal', desc: 'Análisis comparativo cada domingo' },
                  { key: 'alertas_presupuesto', label: 'Alertas de presupuesto', desc: 'Aviso al superar 80% o 100% de un presupuesto' },
                ].map((pref) => (
                  <div
                    key={pref.key}
                    className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/40 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-secondary-foreground">{pref.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{pref.desc}</p>
                    </div>
                    <Badge className="mt-0.5 shrink-0 border-primary/25 bg-primary/10 text-[10px] text-primary">Automático</Badge>
                  </div>
                ))}

                <p className="text-xs text-muted-foreground">
                  El resumen semanal y las alertas de presupuesto se envían automáticamente. Los demás los activas o desactivas desde aquí.
                </p>
              </Section>

              {/* Categorías */}
              <Section
                id="categorias"
                icon={Tag}
                title="Gestionar categorías"
                // El alcance real del cascade lo declara webapp/src/lib/category-refs.ts.
                // Acá se enumeraban las tres tablas de entonces y quedó desactualizado al
                // sumarse dos: en vez de repetir la lista (que vuelve a envejecer), el copy
                // dice QUÉ pasa, no sobre cuántas tablas.
                description="Crea, renombra o elimina categorías y subcategorías. Renombrar arrastra el nombre nuevo a todo lo que la usaba (gastos, presupuestos, reglas y alertas); al eliminar, te aviso si hay transacciones y podrás revisarlas antes."
              >
                {/* Crear categoría raíz — siempre visible arriba de la lista */}
                {creatingRoot ? (
                  <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] px-3 py-2.5">
                    <Input
                      value={newRootInput}
                      onChange={(e) => setNewRootInput(e.target.value)}
                      className="form-input h-8 flex-1 text-sm"
                      placeholder="Nombre de la categoría"
                      autoFocus
                      maxLength={30}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateRoot();
                        if (e.key === 'Escape') { setCreatingRoot(false); setNewRootInput(''); }
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-7 bg-primary px-2 text-white hover:bg-primary/90"
                      onClick={handleCreateRoot}
                      disabled={savingRoot}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => { setCreatingRoot(false); setNewRootInput(''); }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full gap-2 border-dashed border-border bg-transparent text-secondary-foreground hover:bg-white/[0.05]"
                    onClick={() => { setCreatingRoot(true); setNewRootInput(''); }}
                  >
                    <Plus className="h-4 w-4" />
                    Nueva categoría
                  </Button>
                )}

                {categoriesLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 rounded-lg" />
                    <Skeleton className="h-10 rounded-lg" />
                    <Skeleton className="h-10 rounded-lg" />
                  </div>
                ) : categories.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No tienes categorías todavía. Crea la primera arriba, o se crearán solas al registrar gastos.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {categories.map((cat) => {
                      const subsShown = expandedCats.has(cat.id) && (cat.subcategorias.length > 0 || addingSubTo === cat.id);
                      return (
                      <div key={cat.id}>
                        {/* Category row */}
                        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
                          {cat.subcategorias.length > 0 ? (
                            <button
                              className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                              onClick={() => toggleExpand(cat.id)}
                            >
                              {expandedCats.has(cat.id) ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          ) : (
                            <span className="w-5 shrink-0" />
                          )}

                          {renamingCat === cat.id ? (
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <Input
                                value={renameInput}
                                onChange={(e) => setRenameInput(e.target.value)}
                                className="form-input h-7 max-w-[180px] text-sm"
                                autoFocus
                                maxLength={30}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameCategory(cat.id);
                                  if (e.key === 'Escape') setRenamingCat(null);
                                }}
                              />
                              <Button
                                size="sm"
                                className="h-6 bg-primary px-1.5 text-white hover:bg-primary/90"
                                onClick={() => handleRenameCategory(cat.id)}
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-muted-foreground" onClick={() => setRenamingCat(null)}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                {getCategoriaEmoji(cat.nombre)} {cat.nombre}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {cat.subcategorias.length > 0 ? `${cat.subcategorias.length} sub` : ''}
                              </span>
                            </>
                          )}

                          {renamingCat !== cat.id && (
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                className="rounded p-1 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                                onClick={() => {
                                  setAddingSubTo(cat.id);
                                  setNewSubInput('');
                                  setExpandedCats((prev) => new Set(prev).add(cat.id));
                                }}
                                title="Agregar subcategoría"
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                              <button
                                className="rounded p-1 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                                onClick={() => {
                                  setRenamingCat(cat.id);
                                  setRenameInput(cat.nombre);
                                }}
                                title="Renombrar"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => startDelete(cat.id, { categoria: cat.nombre })}
                                title="Eliminar"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Confirmación de borrado de categoría raíz */}
                        {deletingCat === cat.id && (
                          <DeleteConfirmPanel
                            loading={deleteInfo.loading}
                            count={deleteInfo.count}
                            isRoot
                            href={reviewHref(cat.nombre)}
                            onConfirm={() => handleDeleteCategory(cat.id, false)}
                            onCancel={cancelDelete}
                          />
                        )}

                        {/* Subcategories */}
                        {subsShown && (
                          <div className="ml-7 mt-0.5 space-y-0.5">
                            {cat.subcategorias.map((sub) => {
                              const key = subKey(cat.id, sub);
                              const doRename = () =>
                                sub.id ? handleRenameCategory(sub.id) : handleRenameSystemSub(cat.id, sub.nombre);
                              const doDelete = () =>
                                sub.id ? handleDeleteCategory(sub.id, true) : handleDeleteSystemSub(cat.id, sub.nombre);
                              return (
                              <div key={key}>
                              <div
                                className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                              >
                                {renamingCat === key ? (
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <Input
                                      value={renameInput}
                                      onChange={(e) => setRenameInput(e.target.value)}
                                      className="form-input h-7 max-w-[160px] text-sm"
                                      autoFocus
                                      maxLength={30}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') doRename();
                                        if (e.key === 'Escape') setRenamingCat(null);
                                      }}
                                    />
                                    <Button
                                      size="sm"
                                      className="h-6 bg-primary px-1.5 text-white hover:bg-primary/90"
                                      onClick={doRename}
                                    >
                                      <Check className="h-3 w-3" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-muted-foreground" onClick={() => setRenamingCat(null)}>
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ) : (
                                  <>
                                    <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">{sub.nombre}</span>
                                    <div className="flex shrink-0 items-center gap-1">
                                      <button
                                        className="rounded p-1 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                                        onClick={() => {
                                          setRenamingCat(key);
                                          setRenameInput(sub.nombre);
                                        }}
                                        title="Renombrar"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      <button
                                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => startDelete(key, { categoria: cat.nombre, sub: sub.nombre })}
                                        title="Eliminar"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </>
                                )}
                                </div>
                                {deletingCat === key && (
                                  <DeleteConfirmPanel
                                    loading={deleteInfo.loading}
                                    count={deleteInfo.count}
                                    isRoot={false}
                                    href={reviewHref(cat.nombre, sub.nombre)}
                                    onConfirm={doDelete}
                                    onCancel={cancelDelete}
                                  />
                                )}
                              </div>
                              );
                            })}

                            {/* Crear subcategoría */}
                            {addingSubTo === cat.id && (
                              <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2">
                                <Input
                                  value={newSubInput}
                                  onChange={(e) => setNewSubInput(e.target.value)}
                                  className="form-input h-7 flex-1 text-sm"
                                  placeholder="Nueva subcategoría"
                                  autoFocus
                                  maxLength={30}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleCreateSub(cat.id);
                                    if (e.key === 'Escape') { setAddingSubTo(null); setNewSubInput(''); }
                                  }}
                                />
                                <Button
                                  size="sm"
                                  className="h-6 bg-primary px-1.5 text-white hover:bg-primary/90"
                                  onClick={() => handleCreateSub(cat.id)}
                                  disabled={savingSub}
                                >
                                  <Check className="h-3 w-3" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-muted-foreground" onClick={() => { setAddingSubTo(null); setNewSubInput(''); }}>
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </Section>
            </div>

            {/* ============================================================ */}
            {/*  GROUP: Datos y privacidad                                    */}
            {/* ============================================================ */}
            <div className="space-y-4">
              <GroupHeading>Datos y privacidad</GroupHeading>

              {/* Privacidad */}
              <Section
                id="privacidad"
                icon={Shield}
                title="Privacidad"
                description="Usamos analíticas de producto para mejorar Neto. Tus montos y transacciones siempre van enmascarados."
              >
                <ToggleRow
                  title="No rastrear mi actividad"
                  description="Desactiva analíticas y grabaciones de sesión en este navegador"
                  checked={analyticsOptedOut}
                  onToggle={(next) => {
                    if (next) optOutTracking();
                    else optInTracking();
                    setAnalyticsOptedOut(next);
                    toast.success(next ? 'Seguimiento desactivado' : 'Seguimiento activado');
                  }}
                />
              </Section>

              {/* Exportar datos */}
              <Section
                id="exportar"
                icon={Download}
                title="Exportar datos"
                description="Descarga todas tus transacciones, presupuestos y metas en formato JSON."
              >
                <Button
                  variant="outline"
                  className="w-full gap-2 border-border bg-transparent text-secondary-foreground hover:bg-white/[0.05]"
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
              </Section>
            </div>

            {/* ============================================================ */}
            {/*  GROUP: Sesión                                                */}
            {/* ============================================================ */}
            <div className="space-y-4">
              <GroupHeading>Sesión</GroupHeading>

              <section id="sesion" className="scroll-mt-24 space-y-4">
                {/* Cerrar sesión */}
                <div className="glass-card p-5 sm:p-6">
                  <Button
                    variant="outline"
                    className="w-full gap-2 border-border bg-transparent text-secondary-foreground hover:bg-white/[0.05]"
                    disabled={signingOut}
                    onClick={handleSignOut}
                  >
                    <LogOut className="h-4 w-4" />
                    {signingOut ? 'Cerrando sesión...' : 'Cerrar sesión'}
                  </Button>
                </div>

                {/* Danger zone */}
                <div className="glass-card space-y-4 border-destructive/20 p-5 transition-colors hover:border-destructive/40 sm:p-6">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-[18px] w-[18px] text-destructive" />
                    <h3 className="text-sm font-semibold text-destructive">Zona de peligro</h3>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    Eliminar cuenta
                  </Button>

                  {showDeleteConfirm && (
                    <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                      <p className="text-sm text-secondary-foreground">Para eliminar tu cuenta, contacta soporte por WhatsApp.</p>
                      <div className="flex gap-2">
                        <a
                          href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero eliminar mi cuenta')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1"
                        >
                          <Button variant="outline" className="w-full gap-2 border-destructive/40 text-destructive hover:bg-destructive/10">
                            <MessageCircle className="h-4 w-4" />
                            Contactar soporte
                          </Button>
                        </a>
                        <Button
                          variant="outline"
                          className="border-border bg-transparent text-muted-foreground hover:bg-white/[0.05]"
                          onClick={() => setShowDeleteConfirm(false)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}
