import type { ReactNode } from "react";

/**
 * Small pill label. `in` marks a stream the wallet is receiving; `out` marks
 * one it is sending.
 */
export function Tag({
  variant,
  children,
}: {
  variant: "in" | "out";
  children: ReactNode;
}) {
  return <span className={`tag ${variant}`}>{children}</span>;
}
