import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminSettingsPanel } from "@/components/admin-settings-panel";
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

export default async function AdminSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAuthenticated = token ? await verifyAdminSessionToken(token) : false;

  if (!isAuthenticated) {
    redirect("/admin/login?next=%2Fadmin%2Fsettings");
  }

  return (
    <main id="main-content">
      <AdminSettingsPanel />
    </main>
  );
}
