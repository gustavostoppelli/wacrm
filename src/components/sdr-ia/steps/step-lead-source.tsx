"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { WizardDraft } from "../sdr-ia-wizard";

interface Tag {
  id: string;
  name: string;
}

export function StepLeadSource({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.leadSource");
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("tags")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTags(data ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="leadTag">{t("selectLabel")}</Label>
        <select
          id="leadTag"
          value={draft.leadTagId ?? ""}
          onChange={(e) => onChange({ leadTagId: e.target.value || undefined, leadTagName: undefined })}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <option value="">{t("selectPlaceholder")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="newTag">{t("createLabel")}</Label>
        <Input
          id="newTag"
          placeholder={t("createPlaceholder")}
          value={draft.leadTagId ? "" : (draft.leadTagName ?? "")}
          onChange={(e) => onChange({ leadTagName: e.target.value, leadTagId: undefined })}
        />
      </div>
    </div>
  );
}
