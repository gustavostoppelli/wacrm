"use client";

import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { supportWhatsAppUrl } from "@/lib/support";

/** Floating WhatsApp support bubble, present on every dashboard page
 *  (rendered once in DashboardShell) — bottom-right, same spot users
 *  already expect this pattern from typical website chat widgets. */
export function FloatingSupportButton() {
  const t = useTranslations("Support");

  return (
    <a
      href={supportWhatsAppUrl(t("prefilledMessage"))}
      target="_blank"
      rel="noopener noreferrer"
      title={t("bubbleLabel")}
      aria-label={t("bubbleLabel")}
      className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105 hover:shadow-xl"
    >
      <MessageCircle className="h-7 w-7" fill="white" strokeWidth={0} />
    </a>
  );
}
