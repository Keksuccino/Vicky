import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminSettingsPanel } from "@/components/admin-settings-panel";
import { getActiveSessionForToken } from "@/lib/active-auth";
import { ADMIN_COOKIE_NAME } from "@/lib/auth";

export default async function AdminSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const session = token ? await getActiveSessionForToken(token) : null;

  if (session?.role !== "admin") {
    redirect("/admin/login?next=%2Fadmin%2Fsettings");
  }

  return (
    <main id="main-content">
      <AdminSettingsPanel />
    </main>
  );
}
