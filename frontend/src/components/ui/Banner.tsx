import type { ReactNode } from "react";

/**
 * Status banner for a single error or success notice, styled by the `.banner`
 * CSS classes (`error` / `success`).
 */
export function Banner({
  variant,
  children,
}: {
  variant: "error" | "success";
  children: ReactNode;
}) {
  return <div className={`banner ${variant}`}>{children}</div>;
}
