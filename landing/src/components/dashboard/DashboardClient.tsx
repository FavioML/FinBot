"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { DashboardData } from "@/types/dashboard";
import DashboardShell from "@/components/dashboard/DashboardShell";
import BalanceCard from "@/components/dashboard/BalanceCard";
import KPICards from "@/components/dashboard/KPICards";
import MoneyFlow from "@/components/dashboard/MoneyFlow";
import CategoryBreakdown from "@/components/dashboard/CategoryBreakdown";
import TopMerchants from "@/components/dashboard/TopMerchants";
import PaymentMethods from "@/components/dashboard/PaymentMethods";
import HealthScore from "@/components/dashboard/HealthScore";
import Projections from "@/components/dashboard/Projections";
import ActionItems from "@/components/dashboard/ActionItems";
import TransactionList from "@/components/dashboard/TransactionList";
import SubscriptionCard from "@/components/dashboard/SubscriptionCard";
import MonthSelector from "@/components/dashboard/MonthSelector";

const PDFDownload = dynamic(
  () => import("@/components/dashboard/PDFDownload"),
  { ssr: false }
);

type Status = "loading" | "ready" | "error" | "expired";

function getIdFromPath(): string {
  if (typeof window === "undefined") return "";
  const parts = window.location.pathname.split("/").filter(Boolean);
  // /mi-reporte/{id} → parts = ["mi-reporte", "{id}"]
  return parts.length >= 2 ? parts[1] : "";
}

export default function DashboardClient() {
  const [id, setId] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const dashboardRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(
    async (mes?: number, anio?: number) => {
      if (!id) return;
      setStatus("loading");
      try {
        const url =
          mes && anio
            ? `/api/reporte/${id}/mes/${mes}/${anio}`
            : `/api/reporte/${id}`;
        const res = await fetch(url);
        if (res.status === 410) {
          setStatus("expired");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || "Error cargando el dashboard");
          setStatus("error");
          return;
        }
        const json = await res.json();
        if (json.empty) {
          setErrorMsg("No hay transacciones para ese mes.");
          setStatus("error");
          return;
        }
        setData(json);
        setStatus("ready");
      } catch {
        setErrorMsg("No se pudo conectar al servidor.");
        setStatus("error");
      }
    },
    [id]
  );

  useEffect(() => {
    setId(getIdFromPath());
  }, []);

  useEffect(() => {
    if (id) fetchData();
  }, [id, fetchData]);

  const handleMonthSelect = (mes: number, anio: number) => {
    fetchData(mes, anio);
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-neto-bg flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-neto-green border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-neto-txt3 text-sm">Cargando tu dashboard...</p>
        </div>
      </div>
    );
  }

  if (status === "expired") {
    return (
      <div className="min-h-screen bg-neto-bg flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="text-[48px] mb-4">&#x23F0;</div>
          <h2 className="font-heading text-xl font-bold text-neto-txt mb-2">
            Link expirado
          </h2>
          <p className="text-neto-txt3 text-sm mb-6">
            Este dashboard ya no está disponible. Genera uno nuevo escribiendo{" "}
            <span className="text-neto-green font-medium">/reporte</span> en
            WhatsApp.
          </p>
          <a
            href="https://wa.me/51933014505?text=/reporte"
            className="inline-flex items-center gap-2 bg-neto-green hover:bg-neto-green-dark text-white font-medium text-sm px-6 py-3 rounded-full transition-all"
          >
            Abrir WhatsApp
          </a>
        </div>
      </div>
    );
  }

  if (status === "error" || !data) {
    return (
      <div className="min-h-screen bg-neto-bg flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="text-[48px] mb-4">&#x1F615;</div>
          <h2 className="font-heading text-xl font-bold text-neto-txt mb-2">
            No pudimos cargar el dashboard
          </h2>
          <p className="text-neto-txt3 text-sm mb-6">{errorMsg}</p>
          <button
            onClick={() => fetchData()}
            className="inline-flex items-center gap-2 bg-neto-bg4 hover:bg-neto-bg5 text-neto-txt font-medium text-sm px-6 py-3 rounded-full transition-all"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={dashboardRef}>
    <DashboardShell data={data}>
      <div>
        <MonthSelector
          mesesDisponibles={data.mesesDisponibles}
          mesActual={data.mes}
          anioActual={data.anio}
          onSelect={handleMonthSelect}
        />

        <div className="mt-5">
          <BalanceCard kpis={data.kpis} historial={data.historial} />
        </div>
        <div className="mt-4">
          <KPICards kpis={data.kpis} />
        </div>

        <div className="mt-4 grid grid-cols-1 min-[860px]:grid-cols-[2fr_1fr] gap-4">
          <MoneyFlow historial={data.historial} />
          <TransactionList transacciones={data.transacciones} />
        </div>

        <div className="mt-6">
          <CategoryBreakdown categorias={data.categorias} />
        </div>

        <div className="mt-4 grid grid-cols-1 min-[640px]:grid-cols-2 min-[860px]:grid-cols-3 gap-4">
          <TopMerchants comercios={data.comercios} />
          <PaymentMethods metodosPago={data.metodosPago} />
          <SubscriptionCard
            suscripciones={data.suscripciones}
            totalSuscripciones={data.totalSuscripciones}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 min-[640px]:grid-cols-2 gap-4">
          <HealthScore score={data.score} />
          <Projections proyeccion={data.proyeccion} kpis={data.kpis} />
        </div>

        <div className="mt-4">
          <ActionItems acciones={data.acciones} />
        </div>

        {data.insightMes.texto && (
          <div className="mt-4">
            <div
              className={`rounded-r-xl p-4 text-[13px] leading-relaxed border-l-[3px] ${
                data.insightMes.tipo === "alert"
                  ? "bg-[#D85A30]/8 border-neto-red text-[#E8A088]"
                  : "bg-[#1D9E75]/8 border-neto-green text-[#7DCEAE]"
              }`}
            >
              {data.insightMes.texto}
            </div>
          </div>
        )}
      </div>

      <div className="sticky bottom-4 mt-8 flex justify-center z-40">
        <PDFDownload dashboardRef={dashboardRef} />
      </div>
    </DashboardShell>
    </div>
  );
}
