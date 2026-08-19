"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Profile } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";

interface DealTask {
  id: string;
  title: string;
  due_at: string;
  completed_at: string | null;
  assigned_to: string;
}

interface DealTasksProps {
  dealId: string;
  accountId: string;
  contactId: string | null;
  profiles: Profile[];
}

/**
 * Reminders for a human teammate, distinct from the AI agent's own
 * re-engagement follow-ups -- "call this lead back by 3pm" rather than
 * anything the lead ever sees. Notified via the existing notifications
 * bell (see drainDueTasks, migration 050) once due.
 */
export function DealTasks({ dealId, accountId, contactId, profiles }: DealTasksProps) {
  const t = useTranslations("Pipelines.tasks");
  const supabase = createClient();
  const { user } = useAuth();

  const [tasks, setTasks] = useState<DealTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  const [newAssignee, setNewAssignee] = useState("");

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("tasks")
      .select("id, title, due_at, completed_at, assigned_to")
      .eq("deal_id", dealId)
      .order("due_at", { ascending: true });
    setTasks((data ?? []) as DealTask[]);
    setLoading(false);
  }, [dealId, supabase]);

  useEffect(() => {
    fetchTasks();
    setNewAssignee(user?.id ?? "");
  }, [fetchTasks, user?.id]);

  async function handleAdd() {
    if (!newTitle.trim() || !newDueAt || !newAssignee || !user) {
      toast.error(t("toastRequired"));
      return;
    }
    setAdding(true);
    const { error } = await supabase.from("tasks").insert({
      account_id: accountId,
      user_id: user.id,
      assigned_to: newAssignee,
      deal_id: dealId,
      contact_id: contactId,
      title: newTitle.trim(),
      due_at: new Date(newDueAt).toISOString(),
    });
    setAdding(false);
    if (error) {
      toast.error(t("toastFailedCreate"));
      return;
    }
    setNewTitle("");
    setNewDueAt("");
    fetchTasks();
  }

  async function toggleComplete(task: DealTask) {
    const { error } = await supabase
      .from("tasks")
      .update({ completed_at: task.completed_at ? null : new Date().toISOString() })
      .eq("id", task.id);
    if (error) {
      toast.error(t("toastFailedSave"));
      return;
    }
    fetchTasks();
  }

  async function handleDelete(taskId: string) {
    const { error } = await supabase.from("tasks").delete().eq("id", taskId);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    fetchTasks();
  }

  function assigneeLabel(userId: string): string {
    return profiles.find((p) => p.user_id === userId)?.full_name || t("unknownAssignee");
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Label className="text-muted-foreground">{t("title")}</Label>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-2"
            >
              <button
                type="button"
                onClick={() => toggleComplete(task)}
                title={t("toggleComplete")}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  task.completed_at
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                }`}
              >
                {task.completed_at && <Check className="h-3 w-3" />}
              </button>
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm ${
                    task.completed_at
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  }`}
                >
                  {task.title}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(task.due_at).toLocaleString("pt-BR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {assigneeLabel(task.assigned_to)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(task.id)}
                title={t("delete")}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t("newTaskPlaceholder")}
          className="h-9"
        />
        <Input
          type="datetime-local"
          value={newDueAt}
          onChange={(e) => setNewDueAt(e.target.value)}
          className="h-9"
        />
        <select
          value={newAssignee}
          onChange={(e) => setNewAssignee(e.target.value)}
          className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          {profiles.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.full_name}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" onClick={handleAdd} disabled={adding}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
