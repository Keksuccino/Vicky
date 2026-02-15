import Link from "next/link";

import { MaterialIcon } from "@/components/material-icon";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

type BreadcrumbsProps = {
  items: BreadcrumbItem[];
};

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <span key={`${item.label}-${index}`} className="crumb-item">
            {item.href && !isLast ? (
              <Link className="crumb-link" href={item.href}>
                {item.label}
              </Link>
            ) : (
              <span className="crumb-label" aria-current={isLast ? "page" : undefined}>
                {item.label}
              </span>
            )}
            {!isLast ? <MaterialIcon className="crumb-separator" name="chevron_right" /> : null}
          </span>
        );
      })}
    </nav>
  );
}
