import { redirect } from "next/navigation";

import { DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE } from "@/lib/auto-translate";
import { startPageToDocsHref } from "@/lib/start-page";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await getStore();
  redirect(startPageToDocsHref(store.settings.startPage, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE));
}
