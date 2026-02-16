import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { EditorWorkbench } from "@/components/editor-workbench";
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

export default async function EditorPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAuthenticated = token ? await verifyAdminSessionToken(token) : false;

  if (!isAuthenticated) {
    redirect("/admin/login?next=%2Feditor");
  }

  return <EditorWorkbench />;
}
