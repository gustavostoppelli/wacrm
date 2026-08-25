"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";
import { Label } from "@/components/ui/label";
import { Loader2, MessageSquare } from "lucide-react";

interface DealConversationHistoryProps {
  /** Looked up by contact, not deals.conversation_id -- that column is
   *  only ever populated by the AI-agent flow (never the public API
   *  bridge), so a deal from the site form/Meta sync/Apify would show
   *  nothing even after the same contact later messages in on WhatsApp.
   *  Finding by contact_id always finds the real thread if one exists. */
  contactId: string | null;
}

/**
 * Read-only WhatsApp thread, embedded in the deal detail so a Pipelines
 * user can see conversation context and decide which stage to move a
 * deal to without leaving the board to check the inbox separately. No
 * send box, no actions -- purely for orientation.
 */
export function DealConversationHistory({ contactId }: DealConversationHistoryProps) {
  const t = useTranslations("Pipelines.conversationHistory");
  const supabase = createClient();

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contactId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      // Most recently active conversation for this contact -- in
      // practice there's only ever one per channel, and a contact
      // rarely has more than one channel.
      const { data: conv } = await supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (!conv) {
        if (!cancelled) {
          setMessages([]);
          setLoading(false);
        }
        return;
      }

      const { data: msgs } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true });

      if (!cancelled) {
        setMessages((msgs ?? []) as Message[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, supabase]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <Label className="text-muted-foreground">{t("title")}</Label>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : !messages || messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md bg-muted/40 p-2">
          {messages.map((m) => {
            const fromCustomer = m.sender_type === "customer";
            const body = messageBodyPreview(m, t("nonTextPlaceholder"));
            return (
              <div
                key={m.id}
                className={`flex ${fromCustomer ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-1.5 text-xs ${
                    fromCustomer
                      ? "bg-muted text-foreground"
                      : "bg-primary/15 text-foreground"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{body}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Date(m.created_at).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && messages && messages.length > 0 && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {t("viewFullInInbox")}
        </p>
      )}
    </div>
  );
}

function messageBodyPreview(m: Message, nonTextPlaceholder: string): string {
  if (m.content_type === "text" && m.content_text) return m.content_text;
  if (m.content_type === "interactive" && m.content_text) return m.content_text;
  return `${nonTextPlaceholder} (${m.content_type})`;
}
