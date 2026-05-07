import { DocsClient } from "@/components/docs-client";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";

export async function generateMetadata() {
  return generateDocsPageMetadata();
}

export default function DocsIndexPage() {
  return <DocsClient initialPath="/" />;
}
