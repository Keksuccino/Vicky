import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getActiveSessionForToken } from "@/lib/active-auth";
import { ADMIN_COOKIE_NAME } from "@/lib/auth";

export default async function AdminIndexPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const session = token ? await getActiveSessionForToken(token) : null;

  if (session?.role === "admin") {
    redirect("/admin/settings");
  }

  redirect("/admin/login?next=%2Fadmin%2Fsettings");
}
