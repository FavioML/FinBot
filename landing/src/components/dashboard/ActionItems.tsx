"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";
import { Pill } from "@/components/ui/Pill";

interface ActionItemsProps {
  acciones: DashboardData["acciones"];
}

const badgeGradients: Record<string, string> = {
  green: "from-[#1D9E75] to-[#0F6E56]",
  amber: "from-[#EF9F27] to-[#c47d1d]",
  red: "from-[#D85A30] to-[#a83f1e]",
};

export default function ActionItems({ acciones }: ActionItemsProps) {
  const items = acciones.slice(0, 3);

  return (
    <DashCard>
      <h3 className="mb-4 text-[15px] font-semibold text-neto-txt">
        Acciones Concretas
      </h3>

      <div>
        {items.map((action, i) => (
          <div
            key={i}
            className={`flex py-3 ${
              i < items.length - 1 ? "border-b border-white/[0.06]" : ""
            }`}
          >
            {/* Number badge */}
            <div
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[12px] font-semibold text-white ${
                badgeGradients[action.color] ?? badgeGradients.green
              }`}
            >
              {i + 1}
            </div>

            {/* Content */}
            <div className="ml-3 flex-1">
              <p className="text-[13px] text-neto-txt2">{action.texto}</p>
              <div className="mt-1.5">
                <Pill color={action.color as "green" | "amber" | "red"}>
                  {action.pill}
                </Pill>
              </div>
            </div>
          </div>
        ))}
      </div>
    </DashCard>
  );
}
