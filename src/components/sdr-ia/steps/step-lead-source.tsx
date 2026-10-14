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

interface StageOption {
  id: string;
  name: string;
  pipelineName: string;
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
  const [stages, setStages] = useState<StageOption[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("tags")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTags(data ?? []));

    supabase
      .from("pipeline_stages")
      .select("id, name, position, pipelines(name)")
      .order("position")
      .then(({ data }) => {
        const rows = (data ?? []) as Array<{
          id: string;
          name: string;
          pipelines: { name: string } | { name: string }[] | null;
        }>;
        setStages(
          rows.map((row) => {
            const pipeline = Array.isArray(row.pipelines) ? row.pipelines[0] : row.pipelines;
            return { id: row.id, name: row.name, pipelineName: pipeline?.name ?? "" };
          }),
        );
      });
  }, []);

  const eligibleStageIds = draft.eligibleStageIds ?? [];
  const toggleStage = (stageId: string) => {
    const next = eligibleStageIds.includes(stageId)
      ? eligibleStageIds.filter((id) => id !== stageId)
      : [...eligibleStageIds, stageId];
    onChange({ eligibleStageIds: next });
  };

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

      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor="exclusionTag">{t("exclusionLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("exclusionDescription")}</p>
        <select
          id="exclusionTag"
          value={draft.exclusionTagId ?? ""}
          onChange={(e) => onChange({ exclusionTagId: e.target.value || null })}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <option value="">{t("exclusionPlaceholder")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label>{t("stageFilterLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("stageFilterDescription")}</p>
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {stages.map((stage) => (
            <label
              key={stage.id}
              className="flex items-center gap-2 rounded px-2 py-1 text-sm text-foreground hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={eligibleStageIds.includes(stage.id)}
                onChange={() => toggleStage(stage.id)}
              />
              <span>
                {stage.name}
                {stage.pipelineName && (
                  <span className="ml-1 text-xs text-muted-foreground">({stage.pipelineName})</span>
                )}
              </span>
            </label>
          ))}
        </div>
        {eligibleStageIds.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("stageFilterNoneSelected")}</p>
        )}
      </div>
    </div>
  );
}
