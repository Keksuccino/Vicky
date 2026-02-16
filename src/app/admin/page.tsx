import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

export default async function AdminIndexPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAuthenticated = token ? await verifyAdminSessionToken(token) : false;

  if (isAuthenticated) {
    redirect("/admin/settings");
  }

  redirect("/admin/login?next=%2Fadmin%2Fsettings");
}
