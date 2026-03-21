"use client";

import { useEffect, useState } from "react";
import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface HealthScoreProps {
  score: DashboardData["score"];
}

const estadoColor: Record<string, string> = {
  bien: "#1D9E75",
  regular: "#EF9F27",
  mal: "#D85A30",
};

const scoreAccent = (color: string): "green" | "amber" | "red" => {
  if (color === "#1D9E75" || color === "green") return "green";
  if (color === "#EF9F27" || color === "amber") return "amber";
  return "red";
};

const RADIUS = 48;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function HealthScore({ score }: HealthScoreProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const offset = CIRCUMFERENCE * (1 - score.valor / 100);

  return (
    <DashCard accent={scoreAccent(score.color)}>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        {/* SVG Ring */}
        <div className="relative h-[120px] w-[120px] flex-shrink-0">
          <svg width={120} height={120} viewBox="0 0 120 120">
            <circle
              cx={60}
              cy={60}
              r={RADIUS}
              fill="none"
              className="stroke-neto-bg5"
              strokeWidth={8}
            />
            <circle
              cx={60}
              cy={60}
              r={RADIUS}
              fill="none"
              stroke={score.color}
              strokeWidth={8}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={mounted ? offset : CIRCUMFERENCE}
              style={{
                transition: "stroke-dashoffset 1.5s ease-out",
                transform: "rotate(-90deg)",
                transformOrigin: "center",
              }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[28px] font-bold text-neto-txt">
              {score.valor}
            </span>
            <span className="text-[11px] text-neto-txt3">{score.label}</span>
          </div>
        </div>

        {/* Factors */}
        <div className="flex flex-col gap-3">
          {score.factores.map((factor, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="h-[6px] w-[6px] flex-shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    estadoColor[factor.estado] ?? estadoColor.regular,
                }}
              />
              <span className="text-[13px] text-neto-txt2">
                {factor.texto}
              </span>
            </div>
          ))}
        </div>
      </div>
    </DashCard>
  );
}
