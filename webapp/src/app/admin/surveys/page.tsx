'use client';

import { useMemo, useState } from 'react';
import { Loader2, Eye, Check, MessageSquare } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useAdminSurveys,
  useSurveyConversation,
  useMarkSurveyRead,
} from '@/lib/hooks/use-admin-surveys';
import type {
  NpsResponseData,
  ReminderResponseData,
  SurveyEvent,
  SurveyEventType,
  SurveyTypeStats,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const REMINDER_TYPES: SurveyEventType[] = [
  'reminder_d3',
  'reminder_d7',
  'reminder_d14',
  'reminder_d30',
];

const REMINDER_LABEL: Record<SurveyEventType, string> = {
  reminder_d3: 'Día 3',
  reminder_d7: 'Día 7',
  reminder_d14: 'Día 14',
  reminder_d30: 'Día 30',
  webapp_invite_10tx: 'Invite webapp',
  feedback_open_30tx: 'Feedback 30 tx',
  nps_inapp: 'NPS in-app',
};

function formatDateTimeLima(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Lima',
  });
}

function userLabel(e: SurveyEvent): string {
  return e.user_nombre || e.user_whatsapp || e.user_id.slice(0, 8);
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        value
          ? 'bg-[rgba(29,158,117,0.14)] text-[#1D9E75]'
          : 'bg-[rgba(255,255,255,0.04)] text-[#8A877D]'
      }`}
    >
      {value ? 'Sí' : 'No'}
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const valueColor =
    tone === 'good'
      ? 'text-[#1D9E75]'
      : tone === 'warn'
      ? 'text-[#EF9F27]'
      : tone === 'bad'
      ? 'text-[#D85A30]'
      : 'text-[#F0EFE8]';
  return (
    <div className="glass-card p-4">
      <p className="text-[11px] uppercase tracking-wider text-[#8A877D]">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[#8A877D]">{hint}</p>}
    </div>
  );
}

function EmptyTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="glass-card flex flex-col items-center justify-center px-6 py-14 text-center">
      <MessageSquare className="mb-3 h-8 w-8 text-[#8A877D]/60" />
      <p className="text-sm font-medium text-[#F0EFE8]">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-[#8A877D]">{hint}</p>
    </div>
  );
}

export default function AdminSurveysPage() {
  const [tab, setTab] = useState<string>('reminders');
  const [conversationEventId, setConversationEventId] = useState<string | null>(
    null,
  );
  const [npsCommentOnly, setNpsCommentOnly] = useState(false);
  const [npsFromDate, setNpsFromDate] = useState<string>('');
  const [reminderFilter, setReminderFilter] = useState<string>('all');

  const { data, isLoading, isError } = useAdminSurveys();
  const events = useMemo(() => data?.events ?? [], [data?.events]);
  const stats = data?.stats;

  const reminders = useMemo(
    () =>
      events
        .filter((e) => REMINDER_TYPES.includes(e.event_type))
        .filter((e) =>
          reminderFilter === 'all' ? true : e.event_type === reminderFilter,
        ),
    [events, reminderFilter],
  );

  const invites = useMemo(
    () => events.filter((e) => e.event_type === 'webapp_invite_10tx'),
    [events],
  );

  const feedback = useMemo(
    () => events.filter((e) => e.event_type === 'feedback_open_30tx'),
    [events],
  );

  const npsEvents = useMemo(() => {
    let list = events.filter((e) => e.event_type === 'nps_inapp');
    if (npsFromDate) {
      const fromTs = new Date(npsFromDate).getTime();
      list = list.filter((e) => {
        const ts = new Date(e.sent_at || e.created_at).getTime();
        return ts >= fromTs;
      });
    }
    if (npsCommentOnly) {
      list = list.filter((e) => {
        const d = e.response_data as Partial<NpsResponseData> | null;
        return !!d?.comment && String(d.comment).trim().length > 0;
      });
    }
    return list;
  }, [events, npsFromDate, npsCommentOnly]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-[#8A877D]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Cargando encuestas…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="glass-card p-6 text-sm text-[#D85A30]">
        Error cargando encuestas. Refresca la página.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-[#F0EFE8]">
          Encuestas & Feedback
        </h2>
        <p className="mt-1 text-sm text-[#8A877D]">
          Recordatorios WhatsApp, invites a webapp, feedback abierto y NPS in-app.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)}>
        <TabsList className="glass-card border-0">
          <TabsTrigger value="reminders">Recordatorios</TabsTrigger>
          <TabsTrigger value="invites">Webapp invites</TabsTrigger>
          <TabsTrigger value="feedback">Feedback abierto</TabsTrigger>
          <TabsTrigger value="nps">NPS in-app</TabsTrigger>
        </TabsList>

        {/* ===== Reminders ===== */}
        <TabsContent value="reminders" className="mt-5 space-y-4">
          <RemindersTab
            stats={stats?.by_event_type}
            reminders={reminders}
            filter={reminderFilter}
            setFilter={setReminderFilter}
          />
        </TabsContent>

        {/* ===== Webapp invites ===== */}
        <TabsContent value="invites" className="mt-5 space-y-4">
          <InvitesTab
            invites={invites}
            stats={stats?.by_event_type.webapp_invite_10tx}
          />
        </TabsContent>

        {/* ===== Feedback ===== */}
        <TabsContent value="feedback" className="mt-5 space-y-4">
          <FeedbackTab
            feedback={feedback}
            stats={stats?.by_event_type.feedback_open_30tx}
            onOpenChat={setConversationEventId}
          />
        </TabsContent>

        {/* ===== NPS ===== */}
        <TabsContent value="nps" className="mt-5 space-y-4">
          <NpsTab
            events={npsEvents}
            stats={stats?.by_event_type.nps_inapp}
            commentOnly={npsCommentOnly}
            setCommentOnly={setNpsCommentOnly}
            fromDate={npsFromDate}
            setFromDate={setNpsFromDate}
          />
        </TabsContent>
      </Tabs>

      <ConversationDialog
        eventId={conversationEventId}
        onClose={() => setConversationEventId(null)}
      />
    </div>
  );
}

// ===================================================================
// Reminders tab
// ===================================================================
function RemindersTab({
  stats,
  reminders,
  filter,
  setFilter,
}: {
  stats?: Partial<Record<SurveyEventType, SurveyTypeStats>>;
  reminders: SurveyEvent[];
  filter: string;
  setFilter: (v: string) => void;
}) {
  const totals = useMemo(() => {
    let sent = 0;
    let conv24 = 0;
    let optOut = 0;
    let today = 0;
    const todayLima = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Lima',
    });
    for (const r of reminders) {
      if (r.sent_at) sent += 1;
      if (r.conversion_within_24h) conv24 += 1;
      if (r.opted_out_after) optOut += 1;
      if (r.sent_at?.slice(0, 10) === todayLima) today += 1;
    }
    return { sent, conv24, optOut, today };
  }, [reminders]);

  const convRate =
    totals.sent > 0 ? Math.round((totals.conv24 / totals.sent) * 1000) / 10 : 0;
  const optRate =
    totals.sent > 0 ? Math.round((totals.optOut / totals.sent) * 1000) / 10 : 0;

  if (reminders.length === 0) {
    return (
      <EmptyTab
        title="Aún no hay recordatorios enviados"
        hint="El cron envía a las 10am Lima cuando un usuario califica para reminder_d3/d7/d14/d30."
      />
    );
  }

  // suppress unused warning when stats prop isn't consumed yet
  void stats;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Enviados" value={totals.sent} />
        <StatCard
          label="Conversión 24h"
          value={`${convRate}%`}
          tone={convRate >= 30 ? 'good' : convRate >= 15 ? 'warn' : 'bad'}
        />
        <StatCard
          label="Opt-out"
          value={`${optRate}%`}
          tone={optRate >= 10 ? 'bad' : optRate >= 5 ? 'warn' : 'good'}
        />
        <StatCard label="Hoy" value={totals.today} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[#8A877D]">Filtrar:</span>
        {(['all', ...REMINDER_TYPES] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              filter === t
                ? 'bg-[rgba(29,158,117,0.16)] text-[#1D9E75]'
                : 'bg-[rgba(255,255,255,0.04)] text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.08)]'
            }`}
          >
            {t === 'all' ? 'Todos' : REMINDER_LABEL[t as SurveyEventType]}
          </button>
        ))}
      </div>

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-xs uppercase tracking-wider text-[#8A877D]">
              <th className="px-4 py-3 font-medium">Usuario</th>
              <th className="px-4 py-3 font-medium">Tipo</th>
              <th className="px-4 py-3 font-medium">Enviado</th>
              <th className="px-4 py-3 font-medium">Respondió</th>
              <th className="px-4 py-3 font-medium">Tx 24h</th>
              <th className="px-4 py-3 font-medium">Opt-out</th>
            </tr>
          </thead>
          <tbody>
            {reminders.map((r) => {
              const reply = r.response_data as Partial<ReminderResponseData> | null;
              return (
                <tr
                  key={r.id}
                  className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                  title={r.message_sent || ''}
                >
                  <td className="px-4 py-3 text-[#F0EFE8]">{userLabel(r)}</td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {REMINDER_LABEL[r.event_type]}
                  </td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {formatDateTimeLima(r.sent_at)}
                  </td>
                  <td className="px-4 py-3">
                    <YesNo value={!!reply?.user_replied || !!r.responded_at} />
                  </td>
                  <td className="px-4 py-3">
                    <YesNo value={r.conversion_within_24h} />
                  </td>
                  <td className="px-4 py-3">
                    <YesNo value={r.opted_out_after} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ===================================================================
// Webapp invites tab
// ===================================================================
function InvitesTab({
  invites,
  stats,
}: {
  invites: SurveyEvent[];
  stats?: SurveyTypeStats;
}) {
  if (invites.length === 0) {
    return (
      <EmptyTab
        title="Sin invitaciones a webapp aún"
        hint="Se envía cuando un usuario llega a 10 transacciones. Se enviará automáticamente cuando alguien califique."
      />
    );
  }
  const sent = invites.length;
  const activated = invites.filter((i) => i.conversion_within_7d).length;
  const pendientes = sent - activated;
  const activatedPct = sent > 0 ? Math.round((activated / sent) * 1000) / 10 : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Invites enviados" value={sent} />
        <StatCard
          label="Activó webapp en 7d"
          value={`${activatedPct}%`}
          hint={`${activated} de ${sent}`}
          tone={activatedPct >= 30 ? 'good' : activatedPct >= 15 ? 'warn' : 'bad'}
        />
        <StatCard label="Pendientes" value={pendientes} />
      </div>

      {stats?.conversion_rate !== undefined && (
        <p className="text-xs text-[#8A877D]">
          Tasa de conversión global: {stats.conversion_rate}%
        </p>
      )}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-xs uppercase tracking-wider text-[#8A877D]">
              <th className="px-4 py-3 font-medium">Usuario</th>
              <th className="px-4 py-3 font-medium">Enviado</th>
              <th className="px-4 py-3 font-medium">Activó webapp</th>
              <th className="px-4 py-3 font-medium">Días para activar</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => {
              const days =
                i.conversion_within_7d && i.responded_at && i.sent_at
                  ? Math.max(
                      0,
                      Math.round(
                        (new Date(i.responded_at).getTime() -
                          new Date(i.sent_at).getTime()) /
                          86400000,
                      ),
                    )
                  : null;
              return (
                <tr
                  key={i.id}
                  className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                >
                  <td className="px-4 py-3 text-[#F0EFE8]">{userLabel(i)}</td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {formatDateTimeLima(i.sent_at)}
                  </td>
                  <td className="px-4 py-3">
                    <YesNo value={i.conversion_within_7d} />
                  </td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {days !== null ? `${days}d` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ===================================================================
// Feedback tab
// ===================================================================
function FeedbackTab({
  feedback,
  stats,
  onOpenChat,
}: {
  feedback: SurveyEvent[];
  stats?: SurveyTypeStats;
  onOpenChat: (id: string) => void;
}) {
  const markRead = useMarkSurveyRead();

  if (feedback.length === 0) {
    return (
      <EmptyTab
        title="Sin feedback abierto enviado aún"
        hint="Se envía a los 30 tx con la pregunta '¿Qué te gustaría que Neto haga mejor?'"
      />
    );
  }
  const sent = feedback.length;
  const responded = feedback.filter((f) => f.responded_at).length;
  const pendientes = sent - responded;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Feedback enviados" value={sent} />
        <StatCard
          label="Pendientes de leer"
          value={pendientes}
          tone={pendientes > 0 ? 'warn' : 'default'}
        />
        <StatCard label="Respondidos" value={responded} />
      </div>

      {stats?.response_rate !== undefined && (
        <p className="text-xs text-[#8A877D]">
          Tasa de respuesta: {stats.response_rate}%
        </p>
      )}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-xs uppercase tracking-wider text-[#8A877D]">
              <th className="px-4 py-3 font-medium">Usuario</th>
              <th className="px-4 py-3 font-medium">Enviado</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {feedback.map((f) => {
              const isRead = !!f.responded_at;
              return (
                <tr
                  key={f.id}
                  className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                >
                  <td className="px-4 py-3 text-[#F0EFE8]">{userLabel(f)}</td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {formatDateTimeLima(f.sent_at)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        isRead
                          ? 'bg-[rgba(29,158,117,0.14)] text-[#1D9E75]'
                          : 'bg-[rgba(239,159,39,0.14)] text-[#EF9F27]'
                      }`}
                    >
                      {isRead ? 'Leído' : 'Pendiente'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onOpenChat(f.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#1A1A17] px-2.5 py-1 text-xs text-[#C8C6BC] transition-colors hover:bg-[#222220] hover:text-[#F0EFE8]"
                      >
                        <Eye className="h-3 w-3" /> Ver chat
                      </button>
                      {!isRead && (
                        <button
                          onClick={async () => {
                            try {
                              await markRead.mutateAsync(f.id);
                              toast.success('Marcado como leído');
                            } catch (err) {
                              toast.error(
                                err instanceof Error
                                  ? err.message
                                  : 'No se pudo marcar como leído',
                              );
                            }
                          }}
                          disabled={markRead.isPending}
                          className="inline-flex items-center gap-1 rounded-lg bg-[rgba(29,158,117,0.14)] px-2.5 py-1 text-xs text-[#1D9E75] transition-colors hover:bg-[rgba(29,158,117,0.22)] disabled:opacity-50"
                        >
                          <Check className="h-3 w-3" /> Marcar leído
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ===================================================================
// NPS tab
// ===================================================================
function NpsTab({
  events,
  stats,
  commentOnly,
  setCommentOnly,
  fromDate,
  setFromDate,
}: {
  events: SurveyEvent[];
  stats?: SurveyTypeStats;
  commentOnly: boolean;
  setCommentOnly: (v: boolean) => void;
  fromDate: string;
  setFromDate: (v: string) => void;
}) {
  const responded = events.filter((e) => e.responded_at);
  const dismissed = events.filter((e) => e.dismissed_at);

  const ease =
    stats?.nps_avg_ease ??
    (responded.length > 0
      ? Math.round(
          (responded.reduce(
            (s, e) =>
              s + ((e.response_data as NpsResponseData)?.ease ?? 0),
            0,
          ) /
            responded.length) *
            10,
        ) / 10
      : 0);
  const usefulness =
    stats?.nps_avg_usefulness ??
    (responded.length > 0
      ? Math.round(
          (responded.reduce(
            (s, e) =>
              s + ((e.response_data as NpsResponseData)?.usefulness ?? 0),
            0,
          ) /
            responded.length) *
            10,
        ) / 10
      : 0);
  const recommend =
    stats?.nps_avg_recommend ??
    (responded.length > 0
      ? Math.round(
          (responded.reduce(
            (s, e) =>
              s + ((e.response_data as NpsResponseData)?.recommend ?? 0),
            0,
          ) /
            responded.length) *
            10,
        ) / 10
      : 0);

  const totalEligible = events.length;
  const respondedRate =
    totalEligible > 0
      ? Math.round((responded.length / totalEligible) * 1000) / 10
      : 0;

  if (events.length === 0) {
    return (
      <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="NPS Score" value="—" hint="Recomendación 1-5" />
          <StatCard label="Facilidad" value="—" />
          <StatCard label="Utilidad" value="—" />
          <StatCard label="% respondidos" value="—" />
        </div>
        <EmptyTab
          title="Sin respuestas NPS aún"
          hint="La card aparece en /dashboard a usuarios con ≥7 días desde su registro."
        />
      </>
    );
  }

  const distribution = [1, 2, 3, 4, 5].map((n) => {
    const easeN = responded.filter(
      (e) => (e.response_data as NpsResponseData)?.ease === n,
    ).length;
    const usefulN = responded.filter(
      (e) => (e.response_data as NpsResponseData)?.usefulness === n,
    ).length;
    const recommendN = responded.filter(
      (e) => (e.response_data as NpsResponseData)?.recommend === n,
    ).length;
    return { score: String(n), Facilidad: easeN, Utilidad: usefulN, Recomendación: recommendN };
  });

  const recommendTone =
    recommend >= 4 ? 'good' : recommend >= 3 ? 'warn' : 'bad';

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="NPS (recomendación)"
          value={recommend.toFixed(1)}
          hint="Promedio 1-5"
          tone={recommendTone}
        />
        <StatCard label="Facilidad promedio" value={ease.toFixed(1)} hint="1-5" />
        <StatCard
          label="Utilidad promedio"
          value={usefulness.toFixed(1)}
          hint="1-5"
        />
        <StatCard
          label="% respondidos"
          value={`${respondedRate}%`}
          hint={`${responded.length} de ${totalEligible} (${dismissed.length} dismiss)`}
        />
      </div>

      <div className="glass-card p-4">
        <p className="mb-3 text-sm font-medium text-[#F0EFE8]">
          Distribución de respuestas (1-5)
        </p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distribution}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="score" stroke="#8A877D" fontSize={12} />
              <YAxis stroke="#8A877D" fontSize={12} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: '#1C1C19',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: '#F0EFE8',
                }}
              />
              <Bar dataKey="Facilidad" fill="#1D9E75" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Utilidad" fill="#3B9DDB" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Recomendación" fill="#EF9F27" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[#C8C6BC]">
          <span>Desde</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="form-input rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#1A1A17] px-2 py-1 text-xs text-[#F0EFE8]"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-[#C8C6BC]">
          <input
            type="checkbox"
            checked={commentOnly}
            onChange={(e) => setCommentOnly(e.target.checked)}
            className="accent-[#1D9E75]"
          />
          Solo con comentario
        </label>
      </div>

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-xs uppercase tracking-wider text-[#8A877D]">
              <th className="px-4 py-3 font-medium">Usuario</th>
              <th className="px-4 py-3 font-medium">Respondido</th>
              <th className="px-4 py-3 font-medium">Facilidad</th>
              <th className="px-4 py-3 font-medium">Utilidad</th>
              <th className="px-4 py-3 font-medium">Recomienda</th>
              <th className="px-4 py-3 font-medium">Comentario</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const d = e.response_data as Partial<NpsResponseData> | null;
              const isPending = !e.responded_at;
              return (
                <tr
                  key={e.id}
                  className="border-b border-[rgba(255,255,255,0.04)] last:border-0"
                >
                  <td className="px-4 py-3 text-[#F0EFE8]">{userLabel(e)}</td>
                  <td className="px-4 py-3 text-[#C8C6BC]">
                    {isPending
                      ? e.dismissed_at
                        ? `Dismiss · ${formatDateTimeLima(e.dismissed_at)}`
                        : 'Pendiente'
                      : formatDateTimeLima(e.responded_at)}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[#C8C6BC]">
                    {d?.ease ?? '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[#C8C6BC]">
                    {d?.usefulness ?? '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[#C8C6BC]">
                    {d?.recommend ?? '—'}
                  </td>
                  <td className="max-w-md px-4 py-3 text-[#C8C6BC]">
                    {d?.comment || (
                      <span className="text-[#5A584F]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ===================================================================
// Conversation dialog (last 10 messages after sent_at)
// ===================================================================
function ConversationDialog({
  eventId,
  onClose,
}: {
  eventId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useSurveyConversation(eventId);

  return (
    <Dialog open={!!eventId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-[#1C1C19] border-[rgba(255,255,255,0.08)] text-[#F0EFE8] max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Conversación post-envío</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[#8A877D]">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : !data || data.messages.length === 0 ? (
          <p className="py-6 text-sm text-[#8A877D]">
            Aún no respondió por chat.
          </p>
        ) : (
          <div className="space-y-2 py-2">
            {data.messages.map((m) => {
              const isUser = m.rol === 'user';
              return (
                <div
                  key={m.id}
                  className={`rounded-lg px-3 py-2 text-sm ${
                    isUser
                      ? 'bg-[rgba(29,158,117,0.10)] text-[#F0EFE8]'
                      : 'bg-[rgba(255,255,255,0.04)] text-[#C8C6BC]'
                  }`}
                >
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-[#8A877D]">
                    {m.rol} · {formatDateTimeLima(m.created_at)}
                  </p>
                  <p className="whitespace-pre-wrap">{m.mensaje}</p>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
