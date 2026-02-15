import Link from "next/link";

const quickLinks = [
  {
    href: "/docs",
    icon: "menu_book",
    title: "Explore docs",
    description: "Browse the docs tree, search by keyword, and read markdown pages with metadata.",
  },
  {
    href: "/editor",
    icon: "edit_square",
    title: "Edit content",
    description: "Use the markdown editor with live preview and commit your updates.",
  },
  {
    href: "/admin/settings",
    icon: "admin_panel_settings",
    title: "Admin settings",
    description: "Configure GitHub sync and manage custom themes for the docs experience.",
  },
];

export default function HomePage() {
  return (
    <main id="main-content" className="home-page">
      <section className="hero-panel">
        <p className="eyebrow">Documentation Workspace</p>
        <h1>Design, publish, and maintain docs from one interface.</h1>
        <p>
          Vicky Docs combines searchable documentation, repository-backed editing, and theme tooling in a
          browser-first workflow.
        </p>
      </section>

      <section className="card-grid" aria-label="Primary actions">
        {quickLinks.map((item) => (
          <Link key={item.href} className="feature-card" href={item.href}>
            <span className="material-symbols-outlined feature-icon" aria-hidden="true">
              {item.icon}
            </span>
            <h2>{item.title}</h2>
            <p>{item.description}</p>
            <span className="feature-link">Open</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
