import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn primary",
  secondary: "btn secondary",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "small";
};

/**
 * Themed button. Variants map to the existing `.btn` CSS classes, so the
 * rendered markup is identical to the previous hardcoded class strings.
 */
export function Button({
  variant = "primary",
  size,
  className,
  ...rest
}: ButtonProps) {
  const cls = [
    VARIANT_CLASS[variant],
    size === "small" ? "small" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button className={cls} {...rest} />;
}
