import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { EditorWorkbench } from "@/components/editor-workbench";
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

type EditorPageProps = {
  searchParams?: Promise<{
    path?: string | string[];
  }>;
};

function firstSearchParam(value: string | string[] | undefined): string | null {
  const selected = Array.isArray(value) ? value[0] : value;
  const trimmed = selected?.trim();
  return trimmed || null;
}

function editorHref(path: string | null): string {
  if (!path) {
    return "/editor";
  }

  const params = new URLSearchParams({ path });
  return `/editor?${params.toString()}`;
}

export default async function EditorPage({ searchParams }: EditorPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const initialPath = firstSearchParam(resolvedSearchParams.path);
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAuthenticated = token ? await verifyAdminSessionToken(token) : false;

  if (!isAuthenticated) {
    redirect(`/admin/login?next=${encodeURIComponent(editorHref(initialPath))}`);
  }

  return <EditorWorkbench initialPath={initialPath} />;
}
