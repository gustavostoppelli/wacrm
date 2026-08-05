/**
 * UAZAPI HTTP client — an unofficial WhatsApp API (QR-code connection,
 * no Meta approval needed). See `uazapi-openapi-spec.yaml` for the full
 * surface; this file only wraps the endpoints wacrm actually uses:
 * instance lifecycle (create/connect/status/delete/webhook config) and
 * plain send (text/media). There is no template-approval concept on
 * this provider — `uazapi-provider.ts` throws for `sendTemplate`.
 *
 * Same named-params convention as `meta-api.ts`: every function takes
 * one options object so a typo in argument order surfaces as a
 * TypeScript error rather than a runtime failure against a live server.
 */

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorResponse {
  error?: string
  message?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.error) message = data.error
    else if (data.message) message = data.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

// ============================================================
// Instance lifecycle. `/instance/create` is the one endpoint that
// authenticates with the SERVER's `admintoken` rather than an
// instance `token` — the admin token is supplied once by the user
// when connecting a channel and is never persisted (see
// `/api/uazapi/channels` route); every other call here uses the
// instance token stored (encrypted) on the whatsapp_config row.
// ============================================================

export interface CreateInstanceArgs {
  baseUrl: string
  adminToken: string
  name?: string
}

export interface UazapiInstance {
  id: string
  token: string
  status: string
}

export async function createInstance(args: CreateInstanceArgs): Promise<UazapiInstance> {
  const { baseUrl, adminToken, name } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/instance/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', admintoken: adminToken },
    body: JSON.stringify({ name: name || 'wacrm' }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error creating instance: ${response.status}`)
  }
  const data = await response.json()
  return {
    id: data.instance?.id ?? data.id,
    token: data.token ?? data.instance?.token,
    status: data.instance?.status ?? 'disconnected',
  }
}

export interface InstanceTokenArgs {
  baseUrl: string
  instanceToken: string
}

export async function deleteInstance(args: InstanceTokenArgs): Promise<void> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/instance`, {
    method: 'DELETE',
    headers: { token: instanceToken },
  })
  if (!response.ok && response.status !== 404) {
    await throwUazapiError(response, `UAZAPI error deleting instance: ${response.status}`)
  }
}

export interface ConnectInstanceResult {
  connected: boolean
  loggedIn: boolean
  qrcode?: string
  paircode?: string
  status: string
}

export async function connectInstance(
  args: InstanceTokenArgs & { phone?: string }
): Promise<ConnectInstanceResult> {
  const { baseUrl, instanceToken, phone } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/instance/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify(phone ? { phone } : {}),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error connecting instance: ${response.status}`)
  }
  const data = await response.json()
  return {
    connected: !!data.connected,
    loggedIn: !!data.loggedIn,
    qrcode: data.instance?.qrcode,
    paircode: data.instance?.paircode,
    status: data.instance?.status ?? 'connecting',
  }
}

export interface InstanceStatusResult {
  connected: boolean
  loggedIn: boolean
  status: string
  qrcode?: string
  paircode?: string
}

export async function getInstanceStatus(args: InstanceTokenArgs): Promise<InstanceStatusResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/instance/status`, {
    headers: { token: instanceToken },
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error fetching instance status: ${response.status}`)
  }
  const data = await response.json()
  return {
    connected: !!data.status?.connected,
    loggedIn: !!data.status?.loggedIn,
    status: data.instance?.status ?? 'disconnected',
    qrcode: data.instance?.qrcode,
    paircode: data.instance?.paircode,
  }
}

export interface RegisterWebhookArgs extends InstanceTokenArgs {
  webhookUrl: string
}

/**
 * Point this instance's webhook at wacrm's `/api/uazapi/webhook`.
 * `excludeMessages: ['wasSentByApi']` mirrors the recommendation in
 * the UAZAPI docs — without it, every message wacrm itself sends
 * would loop back in as an inbound webhook event.
 */
export async function registerWebhook(args: RegisterWebhookArgs): Promise<void> {
  const { baseUrl, instanceToken, webhookUrl } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({
      enabled: true,
      url: webhookUrl,
      events: ['messages', 'connection'],
      excludeMessages: ['wasSentByApi'],
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error registering webhook: ${response.status}`)
  }
}

// ============================================================
// Send
// ============================================================

export interface UazapiSendTextArgs extends InstanceTokenArgs {
  to: string
  text: string
  replyId?: string
}

export async function sendUazapiText(args: UazapiSendTextArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, text, replyId } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/send/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ number: to, text, ...(replyId ? { replyid: replyId } : {}) }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error sending text: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}

export type UazapiMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface UazapiSendMediaArgs extends InstanceTokenArgs {
  to: string
  kind: UazapiMediaKind
  file: string
  caption?: string
  docName?: string
  replyId?: string
}

export async function sendUazapiMedia(args: UazapiSendMediaArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, kind, file, caption, docName, replyId } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/send/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({
      number: to,
      type: kind,
      file,
      ...(caption ? { text: caption } : {}),
      ...(docName ? { docName } : {}),
      ...(replyId ? { replyid: replyId } : {}),
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error sending media: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}

export interface UazapiSendReactionArgs extends InstanceTokenArgs {
  to: string
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

export async function sendUazapiReaction(args: UazapiSendReactionArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, targetMessageId, emoji } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/message/react`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ number: to, text: emoji, id: targetMessageId }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error sending reaction: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid ?? targetMessageId }
}

export interface UazapiMenuButton {
  id: string
  title: string
}

export interface UazapiMenuListRow {
  id: string
  title: string
  description?: string
}

export interface UazapiMenuListSection {
  title?: string
  rows: UazapiMenuListRow[]
}

interface UazapiSendMenuBaseArgs extends InstanceTokenArgs {
  to: string
  bodyText: string
  footerText?: string
  replyId?: string
}

export type UazapiSendMenuArgs =
  | (UazapiSendMenuBaseArgs & { kind: 'button'; buttons: UazapiMenuButton[]; imageButton?: string })
  | (UazapiSendMenuBaseArgs & {
      kind: 'list'
      buttonLabel: string
      sections: UazapiMenuListSection[]
    })

/**
 * Send an interactive menu via UAZAPI's `/send/menu` — the closest
 * equivalent to Meta's reply-buttons/list messages. `choices` uses
 * UAZAPI's own pipe-delimited mini-format (see `uazapi-openapi-spec.yaml`):
 *   buttons: `"title|id"`
 *   list:    `"[Section title]"` then `"title|id|description"` rows
 */
export async function sendUazapiMenu(args: UazapiSendMenuArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, bodyText, footerText, replyId } = args

  const choices: string[] =
    args.kind === 'button'
      ? args.buttons.map((b) => `${b.title}|${b.id}`)
      : args.sections.flatMap((section) => [
          ...(section.title ? [`[${section.title}]`] : []),
          ...section.rows.map(
            (row) => `${row.title}|${row.id}${row.description ? `|${row.description}` : ''}`
          ),
        ])

  const response = await fetch(`${trimBaseUrl(baseUrl)}/send/menu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({
      number: to,
      type: args.kind,
      text: bodyText,
      choices,
      ...(footerText ? { footerText } : {}),
      ...(replyId ? { replyid: replyId } : {}),
      ...(args.kind === 'button' && args.imageButton ? { imageButton: args.imageButton } : {}),
      ...(args.kind === 'list' ? { listButton: args.buttonLabel } : {}),
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error sending menu: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}
