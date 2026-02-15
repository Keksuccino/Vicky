import { cn } from "@/components/cn";

type MaterialIconProps = {
  name: string;
  className?: string;
  filled?: boolean;
};

export function MaterialIcon({ name, className, filled = false }: MaterialIconProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("material-symbols-outlined material-icon", filled && "material-icon-filled", className)}
    >
      {name}
    </span>
  );
}
