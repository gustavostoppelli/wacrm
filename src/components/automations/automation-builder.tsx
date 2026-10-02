"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  MousePointerClick,
  List,
  Bell,
  Braces,
  GitMerge,
  Image as ImageIcon,
  Upload,
  X,
  Paperclip,
  Mic,
  Square,
  Smile,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  InteractiveMessagePayload,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import {
  InteractiveBuilder,
  blankButtonsPayload,
  blankListPayload,
} from "@/components/interactive/interactive-builder"
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive"
import { createClient } from "@/lib/supabase/client"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { DEAL_SOURCES } from "@/lib/deals/source"
import { validateStepsForActivation, validateTriggerForActivation } from "@/lib/automations/validate"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "send_message", icon: MessageSquare, border: "border-l-primary" },
  send_media: { label: "send_media", icon: ImageIcon, border: "border-l-primary" },
  send_buttons: { label: "send_buttons", icon: MousePointerClick, border: "border-l-primary" },
  send_list: { label: "send_list", icon: List, border: "border-l-primary" },
  send_template: { label: "send_template", icon: FileText, border: "border-l-primary" },
  add_tag: { label: "add_tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { label: "remove_tag", icon: TagIcon, border: "border-l-primary" },
  assign_conversation: { label: "assign_conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { label: "update_contact_field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { label: "create_deal", icon: Briefcase, border: "border-l-primary" },
  notify_owner: { label: "notify_owner", icon: Bell, border: "border-l-primary" },
  wait: { label: "wait", icon: Hourglass, border: "border-l-border" },
  condition: { label: "condition", icon: GitBranch, border: "border-l-amber-500" },
  send_webhook: { label: "send_webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { label: "close_conversation", icon: CircleSlash, border: "border-l-primary" },
}

const ADDABLE_STEPS: AutomationStepType[] = [
  "send_message",
  "send_media",
  "send_buttons",
  "send_list",
  "send_template",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "notify_owner",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
]

const TRIGGER_OPTIONS: { value: AutomationTriggerType }[] = [
  { value: "new_message_received" },
  { value: "first_inbound_message" },
  { value: "keyword_match" },
  { value: "interactive_reply" },
  { value: "new_contact_created" },
  { value: "conversation_assigned" },
  { value: "tag_added" },
  { value: "time_based" },
  { value: "webhook_received" },
  { value: "instagram_comment_received" },
  { value: "instagram_dm_received" },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

// The send_buttons / send_list step_config IS an InteractiveMessagePayload,
// but step_config is typed generically as Record<string, unknown>. These two
// helpers hold the single unavoidable structural cast in one place so a
// payload-shape change has one seam to update instead of four scattered
// `as unknown as` sites.
function toStepConfig(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}
function asInteractive(cfg: Record<string, unknown>): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_media":
      return { media_type: "image", media_url: "", caption: "" }
    case "send_buttons":
      return toStepConfig(blankButtonsPayload())
    case "send_list":
      return toStepConfig(blankListPayload())
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "notify_owner":
      return { phone: "", message: "" }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
  webhooks: WebhookOption[]
  /** Appends a tag created inline (e.g. from TagSelect's empty-state
   *  "create tag" affordance) so it's immediately selectable without a
   *  full reload. */
  addTag: (tag: TagRecord) => void
}

interface WebhookOption {
  id: string
  name: string
}

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  webhooks: [],
  addTag: () => {},
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [stages, setStages] = useState<PipelineStageOption[]>([])
  const [webhooks, setWebhooks] = useState<WebhookOption[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes, pipelinesRes, stagesRes, webhooksRes] =
        await Promise.all([
          supabase.from("tags").select("*").order("name"),
          supabase
            .from("message_templates")
            .select("*")
            .eq("status", "APPROVED")
            .order("name"),
          supabase.from("custom_fields").select("*").order("field_name"),
          supabase.from("pipelines").select("id, name").order("name"),
          supabase
            .from("pipeline_stages")
            .select("id, name, pipeline_id, position")
            .order("position"),
          supabase.from("inbound_webhooks").select("id, name").order("name"),
        ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? [])
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? [])
      setWebhooks((webhooksRes.data as WebhookOption[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  function addTag(tag: TagRecord) {
    setTags((prev) =>
      prev.some((t) => t.id === tag.id)
        ? prev
        : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
    )
  }

  return (
    <ResourcesContext.Provider
      value={{ tags, members, templates, customFields, pipelines, stages, webhooks, addTag }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

// Fixed vocabulary produced by both inbound-webhook parsers (checkout
// shape and the generic fallback — see src/lib/webhooks/inbound-parse.ts),
// which is the only place today that populates `ctx.vars` with a stable,
// known key set. Shown regardless of the automation's actual trigger
// type (threading trigger_type down to every field that supports
// interpolation isn't worth it yet) — inserting one of these into a
// field on a non-webhook automation is harmless, it just interpolates
// to an empty string at runtime.
const WEBHOOK_VARS: { key: string; label: string }[] = [
  { key: "nome", label: "tags.varNome" },
  { key: "primeiro_nome", label: "tags.varPrimeiroNome" },
  { key: "telefone", label: "tags.varTelefone" },
  { key: "email", label: "tags.varEmail" },
  { key: "produto", label: "tags.varProduto" },
  { key: "valor", label: "tags.varValor" },
  { key: "evento", label: "tags.varEvento" },
]

function appendVariable(current: string, token: string): string {
  if (!current) return token
  return current.endsWith(" ") ? `${current}${token}` : `${current} ${token}`
}

/** Splices `token` into `value` at the field's current cursor position
 *  (not the end of the text) and restores focus + caret right after
 *  it. `inputRef` must point at the actual `<input>`/`<textarea>` DOM
 *  node; falls back to appending when the ref isn't attached yet.
 *  Shared by VariablePicker and EmojiPicker — same insert mechanics,
 *  different token source. */
function insertAtCursor(
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  token: string,
  onChange: (next: string) => void,
): void {
  const el = inputRef.current
  if (!el) {
    onChange(appendVariable(value, token))
    return
  }
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? value.length
  onChange(value.slice(0, start) + token + value.slice(end))
  const caret = start + token.length
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

/** Small helper dropdown next to a title/campaign/message-style field,
 *  listing the `{{ vars.* }}` placeholders available from an inbound
 *  webhook event — added after a user found the raw `{{vars.produto}}`
 *  syntax impossible to guess without reading the source. */
function VariablePicker({
  value,
  onChange,
  inputRef,
  t,
}: {
  value: string
  onChange: (next: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  t: ReturnType<typeof useTranslations>
}) {
  const handleInsert = (token: string) => insertAtCursor(inputRef, value, token, onChange)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:border-primary hover:text-primary data-[popup-open]:border-primary data-[popup-open]:text-primary"
        aria-label={t("tags.insertVariable")}
      >
        <Braces className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {WEBHOOK_VARS.map((v) => (
          <DropdownMenuItem key={v.key} onClick={() => handleInsert(`{{vars.${v.key}}}`)}>
            <span className="font-mono text-xs">{`{{vars.${v.key}}}`}</span>
            <span className="ml-2 text-xs text-muted-foreground">{t(v.label)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// A curated, common-use set rather than a full Unicode picker — same
// "no 300KB emoji library" call already made for message reactions
// (message-actions.tsx's QUICK_EMOJIS), just a bigger grid since this
// is for composing a message body, not a one-tap reaction.
const EMOJI_PICKER_SET = [
  "😀", "😂", "😍", "😉", "😊", "🙂", "😎", "🤩", "🥳", "😢",
  "😮", "🙏", "👍", "👏", "🙌", "💪", "✅", "❌", "⭐", "🔥",
  "🎉", "❤️", "💛", "💚", "💙", "💜", "🧡", "📅", "⏰", "📍",
  "📦", "💰", "💳", "🛍️", "🎁", "✨", "📣", "📲", "✍️", "👋",
]

/** Emoji picker for the message-composition fields — inserts at the
 *  cursor via the same mechanism as VariablePicker (see
 *  insertAtCursor), just with a grid of emoji buttons instead of a
 *  list of variable tokens. */
function EmojiPicker({
  value,
  onChange,
  inputRef,
  t,
}: {
  value: string
  onChange: (next: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:border-primary hover:text-primary data-[popup-open]:border-primary data-[popup-open]:text-primary"
        aria-label={t("tags.insertEmoji")}
      >
        <Smile className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="grid grid-cols-8 gap-0.5 p-1">
          {EMOJI_PICKER_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insertAtCursor(inputRef, value, emoji, onChange)}
              className="flex h-7 w-7 items-center justify-center rounded text-base hover:bg-muted"
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Tag dropdown by name + color, storing the tag's id. When no tags
 *  exist yet, offers inline creation (name + color) instead of asking
 *  for a raw UUID — a brand-new account has no tags to pick from, and
 *  there was previously no way to create one without leaving the
 *  automation builder (Settings → Campos e etiquetas). */
function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { tags, addTag } = useResources()
  const { user, accountId } = useAuth()
  const [newTagName, setNewTagName] = useState("")
  const [creating, setCreating] = useState(false)

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (!name || !user || !accountId) return
    setCreating(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("tags")
        .insert({ user_id: user.id, account_id: accountId, name })
        .select()
        .single()
      if (error || !data) {
        toast.error(t("tags.createFailed"))
        return
      }
      const created = data as TagRecord
      addTag(created)
      onChange(created.id)
      setNewTagName("")
      toast.success(t("tags.created", { name: created.name }))
    } finally {
      setCreating(false)
    }
  }

  if (tags.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <Input
          placeholder={t("tags.newPlaceholder")}
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void handleCreateTag()
            }
          }}
          className="bg-muted text-foreground"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void handleCreateTag()}
          disabled={creating || !newTagName.trim()}
        >
          {t("tags.create")}
        </Button>
      </div>
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("tags.select")}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("tags.unknown", { id: value })}</option>
        )}
      </select>
    </div>
  )
}

/** Webhook-connection dropdown for the webhook_received trigger. Empty
 *  selection means "any connection on this account" (see triggerMatches
 *  in engine.ts) — the sensible default before there's more than one
 *  connection to tell apart. Falls back to a raw id input if no
 *  connections exist yet (Settings → Integrações hasn't been used). */
function WebhookSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { webhooks } = useResources()
  if (webhooks.length === 0) {
    return (
      <Input
        placeholder={t("webhooks.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = webhooks.find((w) => w.id === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
      <option value="">{t("webhooks.any")}</option>
      {webhooks.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
      {value && !selected && <option value={value}>{t("webhooks.unknown", { id: value })}</option>}
    </select>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("fields.customFields")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{t("fields.unknown", { id: customValue })}</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder={t("agents.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("agents.select")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t("agents.unknown", { id: value })}</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t("pipelines.pipelineIdLabel")}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("pipelines.stageIdLabel")}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label={t("pipelines.pipelineLabel")}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("pipelines.selectPipeline")}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{t("pipelines.unknownPipeline", { id: pipelineId })}</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t("pipelines.stageLabel")}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? t("pipelines.selectStage") : t("pipelines.selectPipelineFirst")}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{t("pipelines.unknownStage", { id: stageId })}</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

/** Upload target for automation media sends. Reuses the `chat-media`
 *  bucket (migration 023) rather than creating a dedicated one — it
 *  already allows both image and Meta-accepted audio MIME types, and
 *  every write is account-scoped by the same RLS policy `uploadAccountMedia`
 *  relies on (path `account-<id>/...`). The file never touches the Fuse
 *  VPS: the browser uploads straight to Supabase Storage, so a future
 *  client uploading from their own computer works identically. */
const AUTOMATION_MEDIA_BUCKET = "chat-media"

const MEDIA_ACCEPT: Record<"image" | "audio", string> = {
  image: "image/png,image/jpeg,image/webp",
  audio: "audio/ogg,audio/mpeg,audio/aac,audio/mp4,audio/amr",
}

/** Same encoder worker + cap the Inbox composer's voice-note recorder
 *  uses (src/components/inbox/message-composer.tsx) — recording here
 *  reuses that exact client-side Ogg/Opus pipeline, just wired to this
 *  step's own upload target instead of a live conversation. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js"
const MAX_RECORDING_SECONDS = 5 * 60

function formatRecordingDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** "Testar número de telefone" — sends this step's current content
 *  (text or media) to a real phone number right now, same idea as
 *  ClickFunnels' test-send button. No trigger event needed: `{{
 *  vars.* }}` tokens get filled with readable sample data server-side
 *  (there's no real contact/purchase to pull from for a preview). */
function TestSendButton({
  stepType,
  stepConfig,
  t,
}: {
  stepType: "send_message" | "send_media"
  stepConfig: Record<string, unknown>
  t: ReturnType<typeof useTranslations>
}) {
  const [phone, setPhone] = useState("")
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!phone.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch("/api/automations/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), step_type: stepType, step_config: stepConfig }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? t("config.testSendFailed"))
        return
      }
      toast.success(t("config.testSendSuccess"))
    } catch {
      toast.error(t("config.testSendFailed"))
    } finally {
      setSending(false)
    }
  }

  return (
    <FieldBlock label={t("config.testSendLabel")}>
      <div className="flex items-center gap-2">
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t("config.testSendPlaceholder")}
          className="bg-muted text-foreground"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSend}
          disabled={sending || !phone.trim()}
          className="shrink-0"
        >
          {sending ? t("config.testSendSending") : t("config.testSendButton")}
        </Button>
      </div>
    </FieldBlock>
  )
}

/** Media-type select + upload widget for the `send_media` step. Mirrors
 *  the Flows builder's SendMediaForm (node-config-form.tsx), trimmed to
 *  the two kinds WhatsApp automations need here (image, audio) — video
 *  and document weren't requested and Meta ignores captions on audio
 *  either way, so the caption field only shows for images. Audio also
 *  offers recording straight from the mic (same opus-recorder pipeline
 *  as the inbox composer) as an alternative to picking a file. */
function SendMediaFields({
  mediaType,
  mediaUrl,
  caption,
  onChange,
  t,
}: {
  mediaType: "image" | "audio"
  mediaUrl: string
  caption: string
  onChange: (patch: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const captionRef = useRef<HTMLTextAreaElement>(null)
  const [uploading, setUploading] = useState(false)
  const fileName = mediaUrl ? mediaUrl.split("/").pop() ?? "" : ""

  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recorderRef = useRef<import("opus-recorder").default | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
      cancelledRef.current = true
      void recorderRef.current?.stop().catch(() => {})
    }
  }, [])

  const uploadFile = async (file: File, limit: number) => {
    if (file.size > limit) {
      toast.error(`Arquivo de ${(file.size / 1024 / 1024).toFixed(1)} MB — limite é ${(limit / 1024 / 1024).toFixed(0)} MB.`)
      return
    }
    setUploading(true)
    try {
      const { publicUrl } = await uploadAccountMedia(AUTOMATION_MEDIA_BUCKET, file)
      onChange({ media_url: publicUrl })
      toast.success(t("config.mediaUploaded"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("config.mediaUploadFailed"))
    } finally {
      setUploading(false)
    }
  }

  const handleFile = (file: File) => uploadFile(file, MEDIA_MAX_BYTES_BY_KIND[mediaType])

  const finalizeRecording = async (bytes: Uint8Array) => {
    const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
      type: "audio/ogg",
    })
    if (file.size === 0) return // cancelled / empty take
    await uploadFile(file, MEDIA_MAX_BYTES_BY_KIND.audio)
  }

  const startRecording = async () => {
    if (uploading || recording) return
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("config.mediaMicUnsupported"))
      return
    }
    try {
      const { default: Recorder } = await import("opus-recorder")
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      })
      cancelledRef.current = false
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return
        void finalizeRecording(bytes)
      }
      recorderRef.current = recorder
      await recorder.start()
      setRecording(true)
      setRecordSeconds(0)
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    } catch {
      void recorderRef.current?.stop().catch(() => {})
      recorderRef.current = null
      toast.error(t("config.mediaMicDenied"))
    }
  }

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const stopRecording = () => {
    clearTimer()
    setRecording(false)
    void recorderRef.current?.stop().catch(() => {})
  }

  const cancelRecording = () => {
    cancelledRef.current = true
    clearTimer()
    setRecording(false)
    void recorderRef.current?.stop().catch(() => {})
  }

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) stopRecording()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, recordSeconds])

  return (
    <>
      <FieldBlock label={t("config.mediaTypeLabel")}>
        <select
          value={mediaType}
          onChange={(e) =>
            onChange({ media_type: e.target.value, media_url: "" })
          }
          className={SELECT_CLASS}
        >
          <option value="image">{t("config.mediaImageLabel")}</option>
          <option value="audio">{t("config.mediaAudioLabel")}</option>
        </select>
      </FieldBlock>
      <FieldBlock label={t("config.mediaFileLabel")}>
        {mediaUrl ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
            <a
              href={mediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-primary"
              title={fileName || mediaUrl}
            >
              {fileName || mediaUrl}
            </a>
            <button
              type="button"
              onClick={() => onChange({ media_url: "" })}
              className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={t("config.mediaRemove")}
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : recording ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2">
            <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="flex-1 text-xs text-foreground">
              {t("config.mediaRecording", {
                current: formatRecordingDuration(recordSeconds),
                max: formatRecordingDuration(MAX_RECORDING_SECONDS),
              })}
            </span>
            <button
              type="button"
              onClick={cancelRecording}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
            >
              {t("config.mediaCancel")}
            </button>
            <button
              type="button"
              onClick={stopRecording}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              title={t("config.mediaStopAndAttach")}
            >
              <Square className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("config.mediaUploading")}
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" />
                  {t("config.mediaClickToUpload")}
                </>
              )}
            </button>
            {mediaType === "audio" && (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={uploading}
                className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-4 py-4 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                title={t("config.mediaRecordHint")}
              >
                <Mic className="h-3.5 w-3.5" />
                {t("config.mediaRecord")}
              </button>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ""
          }}
        />
      </FieldBlock>
      {mediaType === "image" && (
        <FieldBlock label={t("config.mediaCaptionLabel")}>
          <div className="flex items-center gap-2">
            <Textarea
              ref={captionRef}
              value={caption}
              onChange={(e) => onChange({ caption: e.target.value })}
              className="min-h-16 bg-muted text-foreground"
              rows={2}
            />
            <VariablePicker
              t={t}
              value={caption}
              onChange={(next) => onChange({ caption: next })}
              inputRef={captionRef}
            />
            <EmojiPicker
              t={t}
              value={caption}
              onChange={(next) => onChange({ caption: next })}
              inputRef={captionRef}
            />
          </div>
        </FieldBlock>
      )}
    </>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  onChange,
  t,
}: {
  templateName: string
  language: string
  onChange: (patch: { template_name: string; language: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { templates } = useResources()

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("templates.templateNameLabel")}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("templates.languageLabel")}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <FieldBlock label={t("templates.templateLabel")}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split("::")
          onChange({ template_name: name ?? "", language: lang ?? "" })
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t("templates.select")}</option>
        {templates.map((tmpl) => {
          const lang = tmpl.language ?? "en_US"
          return (
            <option key={tmpl.id} value={toValue(tmpl.name, lang)}>
              {tmpl.name} ({lang})
            </option>
          )
        })}
        {current && !hasMatch && (
          <option value={current}>
            {t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })}
          </option>
        )}
      </select>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const t = useTranslations("Automations.builder")
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [invalidStepCids, setInvalidStepCids] = useState<Set<string>>(new Set())

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      // Run the same checks the server enforces before letting an
      // automation go active — but here on every save (draft or not),
      // purely for visual feedback: mark the offending card(s) with a
      // red ring instead of leaving the user to guess from a toast
      // after the fact. Never blocks a draft save; only the server's
      // own 400 (handled below) blocks activation.
      const issues = [
        ...validateTriggerForActivation(state.trigger_type, state.trigger_config),
        ...validateStepsForActivation(state.steps),
      ]
      const invalidCids = resolveInvalidStepCids(state.steps, issues)
      setInvalidStepCids(invalidCids)
      // Auto-expand the first flagged card so the red ring is visible
      // without the user having to scroll and click to find it.
      if (invalidCids.size > 0) {
        setExpandedId((prev) => prev ?? invalidCids.values().next().value ?? prev)
      }

      const payload = {
        name: state.name || "Untitled automation",
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("toasts.saveFailed"))
        }
        return
      }
      toast.success(isEditing ? t("toasts.saved") : t("toasts.created"))
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">
            {state.is_active ? t("active") : t("inactive")}
          </span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={state.is_active ? t("active") : t("inactive")}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("save") : t("saveDraft")}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              onTypeChange={(tVal) => patchTop("trigger_type", tVal)}
              onConfigChange={(c) => patchTop("trigger_config", c)}
              t={t}
            />
            <StepList
              steps={state.steps}
              parentPath={[]}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
              invalidStepCids={invalidStepCids}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
  t,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [open, setOpen] = useState(false)
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">{t("trigger")}</div>
            <div className="truncate text-sm font-medium text-foreground">
              {t(`triggers.${type}.label`)}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("triggerType")}
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(`triggers.${o.value}.label`)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t(`triggers.${type}.hint`)}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === "instagram_comment_received" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === "interactive_reply" && (
              <InteractiveReplyConfig config={config} onChange={onConfigChange} t={t} />
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                  t={t}
                />
              </div>
            )}
            {type === "webhook_received" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("webhooks.label")}
                </label>
                <WebhookSelect
                  value={(config.webhook_id as string) ?? ""}
                  onChange={(v) =>
                    onConfigChange(v ? { ...config, webhook_id: v } : { ...config, webhook_id: undefined })
                  }
                  t={t}
                />
              </div>
            )}
            {type === "time_based" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("schedule")}
                </label>
                <Input
                  placeholder="Cron expression or HH:mm"
                  value={(config.schedule as string) ?? ""}
                  onChange={(e) =>
                    onConfigChange({ ...config, schedule: e.target.value })
                  }
                  className="bg-muted text-foreground"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("scheduleHint")}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("keywords")}
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsHint")}
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("config.matchType")}
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) =>
            onChange({
              ...config,
              match_type: e.target.value as "exact" | "contains" | "word",
            })
          }
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">{t("config.matchContains")}</option>
          <option value="word">{t("config.matchWord")}</option>
          <option value="exact">{t("config.matchExact")}</option>
        </select>
        {/* Only worth explaining for `word` — "contains" and "exact" read
            for themselves, and this is the one that changes which messages
            fire an automation in a way that isn't obvious. */}
        {config?.match_type === "word" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("config.matchWordHint")}
          </p>
        )}
      </div>
    </div>
  )
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? []
  // Same local-draft-then-commit pattern as KeywordMatchConfig so
  // commas + spaces survive keystrokes.
  const [draft, setDraft] = useState(ids.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, reply_ids: parsed })
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {t("replyIds")}
      </label>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("replyIdsHint")}
        className="bg-muted font-mono text-foreground"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("replyIdsHelp")}</p>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
  /** Step cids flagged by the last save/activate attempt's validation
   *  (validateStepsForActivation) — rendered with a red ring so the
   *  user can spot exactly which card is incomplete without hunting
   *  through a toast message. Cleared once the step is edited. */
  invalidStepCids?: Set<string>
}

function StepList(props: StepListProps) {
  const { steps, parentPath, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const t = useTranslations("Automations.builder")
  // For a root step, `parentPath` is the path TO this list (so append).
  // For a branch step, `parentPath` already ENDS in the placeholder
  // segment `ConditionBranches` created for this branch (parentCid +
  // branch, with a throwaway index) — replace that last segment with
  // one carrying the real index instead of appending a second one.
  // Appending here used to double up the branch segment, so
  // mapAtPath/walkBranches recursed one level too deep and silently
  // dropped every edit made to a step living inside a condition's
  // Sim/Não branch (e.g. typing in that step's message text did
  // nothing — the keystroke was discarded, not misapplied elsewhere).
  const path: StepPath =
    parentScope.kind === "root"
      ? [...parentPath, { kind: "root", index }]
      : [
          ...parentPath.slice(0, -1),
          { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
        ]
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  // Fixed widths, same as every other card — branch columns now scroll
  // horizontally instead of squeezing to fit (see ConditionBranches),
  // so cards never need to shrink below their normal size.
  const width = isCondition ? "w-full max-w-[400px] sm:w-[400px]" : "w-full max-w-[320px] sm:w-80"
  const isInvalid = props.invalidStepCids?.has(step.cid) ?? false

  return (
    <>
      <div className={cn("z-10 flex min-w-0 flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
            // Flagged by the last save/activate attempt's validation —
            // a visible ring beats a toast the user already dismissed.
            isInvalid && "border-destructive ring-2 ring-destructive",
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {isCondition ? "Condition" : step.step_type === "wait" ? "Wait" : "Action"}
              </div>
              <div className="truncate text-sm font-medium text-foreground">{t(`steps.${meta.label}`)}</div>
              <div className="truncate text-[11px] text-muted-foreground">{previewFor(step)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label="Move up"
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label="Move down"
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("delete", { defaultValue: "Delete" })}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} {...props} />
        )}
      </div>

      {/* A step added here, after the condition, runs regardless of
          which branch (Sim/Não) was taken — the engine's executeStepsFrom
          already resumes the parent list once a branch's own steps are
          done (see engine.ts's `continue` after dispatching a branch).
          Looks like every other "+" until clicked; the dropdown itself
          carries the "Unir caminhos" hint (see AddButton).
          Caveat: if a branch ends in a `wait`, this step currently fires
          immediately rather than after that wait elapses — fine for
          branches that only tag/message/etc., not yet for one that
          waits before merging. */}
      <AddButton
        isMergePoint={isCondition}
        onPick={(t) => props.addStepAt(parentScope, index + 1, t)}
      />
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const t = useTranslations("Automations.builder")
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Branch cards keep their normal fixed width (never shrunk to
    // "fit"). No scrollbar of its own here — the canvas container
    // (AutomationBuilder's "Canvas" div, `overflow-y-auto`) already
    // picks up horizontal scroll by the CSS spec's auto-overflow
    // pairing rule once this content is wider than the centered
    // max-w-2xl column, so the whole flow scrolls as one surface
    // instead of a small boxed-in scrollbar nested inside one card.
    <div className="mt-3">
      <div className="flex w-max gap-12">
        <BranchColumn label={t("branches.yes")} color="text-primary">
          <StepList {...props} steps={yes} parentPath={yesPath} />
        </BranchColumn>
        <BranchColumn label={t("branches.no")} color="text-rose-400">
          <StepList {...props} steps={no} parentPath={noPath} />
        </BranchColumn>
      </div>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({
  onPick,
  isMergePoint = false,
}: {
  onPick: (t: AutomationStepType) => void
  /** True for the "+" right after a condition — same ordinary button
   *  as every other "+" (nothing shown on the canvas until clicked),
   *  but its dropdown opens with an "Unir caminhos" hint on top: a step
   *  picked here runs after EITHER branch (Sim or Não), since the
   *  engine already resumes the parent list once the chosen branch's
   *  own steps finish (executeStepsFrom, engine.ts). */
  isMergePoint?: boolean
}) {
  const t = useTranslations("Automations.builder")
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label={t("addStep")}
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover"
        >
          {isMergePoint && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-primary">
                  <GitMerge className="h-3.5 w-3.5" />
                  {t("mergePaths")}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {ADDABLE_STEPS.map((tp) => {
            const Icon = STEP_META[tp].icon
            return (
              <DropdownMenuItem key={tp} onClick={() => onPick(tp)}>
                <Icon className="h-4 w-4" />
                {t(`steps.${STEP_META[tp].label}`)}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const t = useTranslations("Automations.builder")
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  // Refs for the handful of fields that pair a text input with a
  // VariablePicker — declared unconditionally here (not inside each
  // switch case) since this component always runs the same hooks
  // regardless of which step_type it renders.
  const messageTextRef = useRef<HTMLTextAreaElement>(null)
  const dealTitleRef = useRef<HTMLInputElement>(null)
  const dealCampaignRef = useRef<HTMLInputElement>(null)

  switch (step.step_type) {
    case "send_message":
      return (
        <>
          <FieldBlock label={t("config.messageText")}>
            <div className="flex items-start gap-2">
              <Textarea
                ref={messageTextRef}
                value={(cfg.text as string) ?? ""}
                onChange={(e) => set({ text: e.target.value })}
                placeholder={t("config.placeholderMessageText")}
                className="min-h-24 bg-muted text-foreground"
              />
              <VariablePicker
                t={t}
                value={(cfg.text as string) ?? ""}
                onChange={(next) => set({ text: next })}
                inputRef={messageTextRef}
              />
              <EmojiPicker
                t={t}
                value={(cfg.text as string) ?? ""}
                onChange={(next) => set({ text: next })}
                inputRef={messageTextRef}
              />
            </div>
          </FieldBlock>
          <TestSendButton stepType="send_message" stepConfig={cfg} t={t} />
        </>
      )
    case "send_media":
      return (
        <>
          <SendMediaFields
            mediaType={(cfg.media_type as "image" | "audio") ?? "image"}
            mediaUrl={(cfg.media_url as string) ?? ""}
            caption={(cfg.caption as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <TestSendButton stepType="send_media" stepConfig={cfg} t={t} />
        </>
      )
    case "send_buttons":
    case "send_list":
      // The whole step_config IS the interactive payload; the shared
      // builder edits it in place (and enforces Meta's limits + preview).
      return (
        <InteractiveBuilder
          value={asInteractive(cfg)}
          onChange={(payload) =>
            onChange({ ...step, step_config: toStepConfig(payload) })
          }
        />
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          onChange={(patch) => set(patch)}
          t={t}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("config.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">{t("config.modes.round_robin")}</option>
              <option value="specific">{t("config.modes.specific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("config.agentLabel")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("config.fieldLabel")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t("config.placeholderValue")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t("config.titleLabel")}>
            <div className="flex items-center gap-2">
              <Input
                ref={dealTitleRef}
                value={(cfg.title as string) ?? ""}
                onChange={(e) => set({ title: e.target.value })}
                className="bg-muted text-foreground"
              />
              <VariablePicker
                t={t}
                value={(cfg.title as string) ?? ""}
                onChange={(next) => set({ title: next })}
                inputRef={dealTitleRef}
              />
            </div>
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.sourceLabel")}>
            <select
              value={(cfg.source as string) ?? ""}
              onChange={(e) => set({ source: e.target.value || undefined })}
              className={SELECT_CLASS}
            >
              <option value="">{t("config.sourceUnset")}</option>
              {DEAL_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </FieldBlock>
          <FieldBlock label={t("config.campaignLabel")}>
            <div className="flex items-center gap-2">
              <Input
                ref={dealCampaignRef}
                value={(cfg.campaign as string) ?? ""}
                onChange={(e) => set({ campaign: e.target.value })}
                placeholder={t("config.placeholderValue")}
                className="bg-muted text-foreground"
              />
              <VariablePicker
                t={t}
                value={(cfg.campaign as string) ?? ""}
                onChange={(next) => set({ campaign: next })}
                inputRef={dealCampaignRef}
              />
            </div>
          </FieldBlock>
          <FieldBlock label={t("config.leadScoreLabel")}>
            <Input
              type="number"
              min={0}
              max={100}
              value={(cfg.lead_score as number) ?? ""}
              onChange={(e) =>
                set({ lead_score: e.target.value === "" ? undefined : Number(e.target.value) })
              }
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "notify_owner":
      return (
        <>
          <FieldBlock label={t("config.notifyPhoneLabel")}>
            <Input
              value={(cfg.phone as string) ?? ""}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder={t("config.notifyPhonePlaceholder")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.notifyMessageLabel")}>
            <Textarea
              value={(cfg.message as string) ?? ""}
              onChange={(e) => set({ message: e.target.value })}
              placeholder={t("config.notifyMessagePlaceholder")}
              className="bg-muted text-foreground"
              rows={2}
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("config.amountLabel")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.unitLabel")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">{t("config.units.minutes")}</option>
              <option value="hours">{t("config.units.hours")}</option>
              <option value="days">{t("config.units.days")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label={t("config.subjectLabel")}>
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">{t("config.subjects.tag_presence")}</option>
              <option value="contact_field">{t("config.subjects.contact_field")}</option>
              <option value="message_content">{t("config.subjects.message_content")}</option>
              <option value="time_of_day">{t("config.subjects.time_of_day")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("config.operandLabel")}>
            {cfg.subject === "tag_presence" ? (
              <TagSelect
                value={(cfg.operand as string) ?? ""}
                onChange={(v) => set({ operand: v })}
                t={t}
              />
            ) : (
              <Input
                placeholder={
                  cfg.subject === "time_of_day"
                    ? t("config.placeholderTime")
                    : cfg.subject === "contact_field"
                    ? t("config.placeholderContact")
                    : ""
                }
                value={(cfg.operand as string) ?? ""}
                onChange={(e) => set({ operand: e.target.value })}
                className="bg-muted text-foreground"
              />
            )}
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label="Value">
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t("config.closeConversationHint", { defaultValue: "Sets the conversation status to \"closed\". No configuration needed." })}
        </p>
      )
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || "no text yet"
    case "send_media": {
      const url = step.step_config.media_url as string
      const kind = (step.step_config.media_type as string) || "image"
      return url ? `${kind}: ${url.split("/").pop()}` : "no file yet"
    }
    case "send_buttons":
    case "send_list":
      return interactivePayloadPreviewText(asInteractive(step.step_config)) || "no body yet"
    case "send_template":
      return (step.step_config.template_name as string) || "pick a template"
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return `when ${step.step_config.subject ?? "?"}`
    case "send_webhook":
      return (step.step_config.url as string) || "no url"
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

/** Maps validateStepsForActivation's `steps[0].yes.steps[1].tag_id`-style
 *  paths back to the client-side step's `cid`, so the failing card can
 *  be given a visible red ring instead of a toast the user has to
 *  correlate by hand. Silently returns null for a path that doesn't
 *  resolve (e.g. `path: 'steps'` for "no steps at all" — there's no
 *  single card to blame). */
function pathToStepCid(steps: BuilderStep[], path: string): string | null {
  let current: BuilderStep[] | undefined = steps
  let node: BuilderStep | undefined
  let rest = path
  while (current) {
    const stepMatch = rest.match(/^steps\[(\d+)\]/)
    if (!stepMatch) break
    node = current[Number(stepMatch[1])]
    if (!node) return null
    rest = rest.slice(stepMatch[0].length)
    const branchMatch = rest.match(/^\.(yes|no)\./)
    if (branchMatch && node.branches) {
      current = node.branches[branchMatch[1] as "yes" | "no"]
      rest = rest.slice(branchMatch[0].length)
    } else {
      current = undefined
    }
  }
  return node?.cid ?? null
}

function resolveInvalidStepCids(
  steps: BuilderStep[],
  issues: { path: string }[],
): Set<string> {
  const cids = new Set<string>()
  for (const issue of issues) {
    const cid = pathToStepCid(steps, issue.path)
    if (cid) cids.add(cid)
  }
  return cids
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
