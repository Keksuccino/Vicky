import { cn } from "@/components/cn";
import { DEFAULT_CIRCLE_FLAG_ICON_ID, getCircleFlagIcon, getCircleFlagIconLabel } from "@/lib/circle-flags";

type CircleFlagIconProps = {
  className?: string;
  decorative?: boolean;
  iconId: string;
  label?: string;
};

export function CircleFlagIcon({ className, decorative = true, iconId, label }: CircleFlagIconProps) {
  const icon = getCircleFlagIcon(iconId) ?? getCircleFlagIcon(DEFAULT_CIRCLE_FLAG_ICON_ID);

  if (!icon) {
    return null;
  }

  return (
    <svg
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label ?? getCircleFlagIconLabel(icon.id)}
      className={cn("circle-flag-icon", className)}
      focusable="false"
      role={decorative ? undefined : "img"}
      viewBox={`0 0 ${icon.width} ${icon.height}`}
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}
