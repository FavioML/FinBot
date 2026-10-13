import Link from 'next/link';
import { TrendingUp, Receipt, MessageSquare, LayoutGrid, Activity, Users, Wallet } from 'lucide-react';

export const dynamic = 'force-dynamic';

const sections = [
  {
    href: '/admin/operacion',
    title: 'Operación',
    desc: 'Usuarios, NLP errors, tickets de soporte, KPIs y embudo',
    icon: LayoutGrid,
    status: 'live' as const,
  },
  {
    href: '/admin/economics',
    title: 'Unit Economics',
    desc: 'MRR, ARR, breakeven, márgenes, CAC, LTV',
    icon: TrendingUp,
    status: 'live' as const,
  },
  {
    href: '/admin/pagos',
    title: 'Pagos recibidos',
    desc: 'Quién pagó cada mes, cuánto, plan y si es primer pago o renovación',
    icon: Wallet,
    status: 'live' as const,
  },
  {
    href: '/admin/producto',
    title: 'Producto & Retención',
    desc: 'Retención por cohorte, engagement, adopción de features',
    icon: Activity,
    status: 'live' as const,
  },
  {
    href: '/admin/users',
    title: 'Usuarios',
    desc: 'Segmentos de salud, actividad reciente, adquisición por canal',
    icon: Users,
    status: 'live' as const,
  },
  {
    href: '/admin/costs',
    title: 'Costos & Recordatorios',
    desc: 'Railway, dominio, chip Entel — vencen hoy',
    icon: Receipt,
    status: 'live' as const,
  },
  {
    href: '/admin/surveys',
    title: 'Encuestas & Feedback',
    desc: 'Recordatorios, NPS in-app, feedback abierto',
    icon: MessageSquare,
    status: 'live' as const,
  },
];

export default function AdminHomePage() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sections.map((section) => {
        const Icon = section.icon;
        const isLive = section.status === 'live';
        return (
          <Link
            key={section.href}
            href={section.href}
            className="group glass-card relative overflow-hidden rounded-xl p-5 transition-all hover:border-primary/35"
          >
            <div className="flex items-start gap-4">
              <div className="rounded-lg bg-primary/12 p-2.5 text-primary-ink">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-foreground">
                  {section.title}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{section.desc}</p>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs uppercase tracking-wider ${
                  isLive
                    ? 'border-primary/35 bg-primary/10 text-primary-ink'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {isLive ? 'Activo' : 'Próximo'}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
