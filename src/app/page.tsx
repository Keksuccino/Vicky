import { redirect } from "next/navigation";

import { startPageToDocsHref } from "@/lib/start-page";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await getStore();
  redirect(startPageToDocsHref(store.settings.startPage));
}
