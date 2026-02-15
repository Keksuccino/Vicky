import ReactMarkdown from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { remarkGitHubAlerts } from "@/lib/remark-github-alerts";

type MarkdownRendererProps = {
  content: string;
};

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames || []), "aside"],
  attributes: {
    ...(defaultSchema.attributes || {}),
    "*": [...((defaultSchema.attributes && defaultSchema.attributes["*"]) || []), "className", "id", "data-alert"],
    a: [...((defaultSchema.attributes && defaultSchema.attributes.a) || []), "target", "rel"],
    code: [...((defaultSchema.attributes && defaultSchema.attributes.code) || []), "className"],
    pre: [...((defaultSchema.attributes && defaultSchema.attributes.pre) || []), "className"],
    span: [...((defaultSchema.attributes && defaultSchema.attributes.span) || []), "className"],
    aside: ["className", "data-alert"],
    input: [...((defaultSchema.attributes && defaultSchema.attributes.input) || []), "checked", "disabled", "type"],
  },
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkGitHubAlerts]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "append",
              properties: { className: ["heading-anchor"] },
              content: {
                type: "element",
                tagName: "span",
                properties: { className: ["material-symbols-outlined", "anchor-icon"] },
                children: [{ type: "text", value: "link" }],
              },
            },
          ],
          rehypeHighlight,
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={{
          a: ({ href, children, ...props }) => {
            const safeHref =
              href && /^(https?:|mailto:|\/|#)/i.test(href.trim()) ? href : href ? "#" : undefined;
            const external = safeHref?.startsWith("http://") || safeHref?.startsWith("https://");

            return (
              <a
                href={safeHref}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer noopener" : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
