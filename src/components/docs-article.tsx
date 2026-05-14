import { DocsPageCopyActions } from "@/components/docs-page-copy-actions";
import { MarkdownCodeCopyController } from "@/components/markdown-code-copy-controller";
import { MaterialIcon } from "@/components/material-icon";
import type { RenderedDocsPageWithSourceHeadings } from "@/lib/docs-server-data";

type DocsArticleProps = {
  page: RenderedDocsPageWithSourceHeadings;
};

function toDocsHref(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized) {
    return "/docs";
  }

  return `/docs/${normalized}`;
}

function toRawDocsHref(path: string): string {
  const href = toDocsHref(path);
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}raw=1`;
}

function formatDate(value?: string): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const hours = String(parsed.getUTCHours()).padStart(2, "0");
  const minutes = String(parsed.getUTCMinutes()).padStart(2, "0");
  const seconds = String(parsed.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

export function DocsArticle({ page }: DocsArticleProps) {
  const rawPageHref = toRawDocsHref(page.path);
  const articleKey = `${page.slug}:${page.sha}`;

  return (
    <div className="docs-main-content">
      <section className="page-header-card" aria-label="Page header">
        <header className="page-heading">
          <h1>{page.title}</h1>
          {page.description ? <p>{page.description}</p> : null}
        </header>

        <div className="metadata-row" aria-label="Page metadata">
          <div className="metadata-items">
            <span className="meta-item">
              <MaterialIcon name="schedule" />
              Updated: {formatDate(page.updatedAt)}
            </span>
          </div>

          <DocsPageCopyActions rawHref={rawPageHref} />
        </div>
      </section>

      <article
        id="docs-article-markdown"
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: page.renderedHtml }}
      />
      <MarkdownCodeCopyController rootId="docs-article-markdown" effectKey={articleKey} />
    </div>
  );
}
