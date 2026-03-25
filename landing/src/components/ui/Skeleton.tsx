"use client";

import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
  variant?: "rect" | "circle" | "text";
}

export function Skeleton({ className, variant = "rect" }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse bg-neto-bg5",
        variant === "circle" && "rounded-full",
        variant === "rect" && "rounded-lg",
        variant === "text" && "h-4 w-full rounded-lg",
        className
      )}
    />
  );
}
