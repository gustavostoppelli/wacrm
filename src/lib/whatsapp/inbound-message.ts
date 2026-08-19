// ============================================================
// Provider-agnostic inbound-message processing.
//
// Both the Meta webhook (`/api/whatsapp/webhook`) and the UAZAPI
// webhook (`/api/uazapi/webhook`) receive completely different wire
// formats, but once a message is parsed into a `NormalizedInboundMessage`
// the rest of the pipeline — contact/conversation find-or-create,
// persisting the message, reopening a closed thread, flagging a
// broadcast reply, and dispatching Flows/automations/AI-auto-reply/the
// public webhook — is identical. This module owns that shared half so
// neither webhook route re-implements it.
//
// Extracted from the Meta webhook route (which used to inline all of
// this in `processMessage`) when UAZAPI support was added — the Meta
// route's `processMessage` is now a thin adapter that parses Meta's
// payload shape and calls `processInboundMessage` here.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { resolvePipelineAndStage, DealError } from '@/lib/api/v1/deals'
import type { ContentType } from '@/types'

export interface NormalizedInboundMessage {
  accountId: string
  /** Sender-of-record for NOT NULL user_id FKs (contacts, conversations). */
  configOwnerUserId: string
  /** Which whatsapp_config row this arrived on (migration 037). */
  channelId: string
  senderPhone: string
  senderName: string
  /** Provider's own message id — stored in messages.message_id. */
  externalMessageId: string
  timestamp: Date
  contentType: ContentType
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
  /** External id of the message this one swipe-replies/quotes, if any. */
  replyToExternalMessageId: string | null
  /** Set only for reaction events — every other content field is ignored. */
  reaction: { emoji: string; targetExternalMessageId: string } | null
  /**
   * Set when this message carries Meta's `referral` object — i.e. it's
   * the opening message of a Click-to-WhatsApp (or ad "Send message")
   * conversation. `null`/omitted for everything else, including every
   * message from providers (UAZAPI) that don't relay this. Only ever
   * used on the *first* inbound message of a conversation — Meta only
   * attaches it there, and `ensureDealForContact` only fires once per
   * contact (no existing open deal), so a later message with no
   * referral never overwrites an attribution already recorded.
   */
  adReferral?: {
    adId: string | null
    ctwaClid: string | null
    headline: string | null
    sourceUrl: string | null
  } | null
}

export interface InboundDispatchResult {
  conversationId: string
  contactId: string
}

// The messages.content_type CHECK constraint (migration 001 + 010) only
// allows these values — a provider's own type must map onto this set
// before the insert, or it fails with a constraint error.
const ALLOWED_CONTENT_TYPES = new Set<ContentType>([
  'text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive',
])

/**
 * Find or create the contact + conversation for a normalized inbound
 * message, persist it, and fan out to every downstream consumer
 * (Flows, automations, AI auto-reply, the public webhook). Returns
 * `null` on an unrecoverable DB failure (already logged) — callers
 * should just drop the message, matching the pre-extraction behaviour.
 */
export async function processInboundMessage(
  msg: NormalizedInboundMessage
): Promise<InboundDispatchResult | null> {
  const db = supabaseAdmin()

  const contactOutcome = await findOrCreateContact(
    msg.accountId,
    msg.configOwnerUserId,
    msg.senderPhone,
    msg.senderName
  )
  if (!contactOutcome) return null
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    msg.accountId,
    msg.configOwnerUserId,
    contactRecord.id,
    msg.channelId
  )
  if (!convResult) return null
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db, msg.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages, never bump
  // unread_count, never update last_message_text. Deal creation still
  // runs for them (native fallback, see ensureDealForContact below) since
  // they don't go through the keyword-match automations a real text
  // message does.
  if (msg.reaction) {
    await ensureDealForContact(
      msg.accountId,
      msg.configOwnerUserId,
      contactRecord.id,
      conversation.id,
      contactRecord.name || msg.senderPhone,
      msg.senderPhone,
      msg.adReferral ?? null,
    )
    await handleReaction(msg.reaction, conversation.id, contactRecord.id)
    return { conversationId: conversation.id, contactId: contactRecord.id }
  }

  let replyToInternalId: string | null = null
  if (msg.replyToExternalMessageId) {
    replyToInternalId = await lookupInternalIdByExternalId(
      msg.replyToExternalMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-message] reply context parent not found:',
        msg.replyToExternalMessageId
      )
    }
  }

  const contentType = ALLOWED_CONTENT_TYPES.has(msg.contentType) ? msg.contentType : 'text'

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: msg.contentText,
    media_url: msg.mediaUrl,
    message_id: msg.externalMessageId,
    status: 'delivered',
    created_at: msg.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: msg.interactiveReplyId,
  })
  if (msgError) {
    console.error('[inbound-message] error inserting message:', msgError)
    return null
  }

  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: msg.contentText || `[${msg.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
  if (convError) {
    console.error('[inbound-message] error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(db, conversation)

  await flagBroadcastReplyIfAny(msg.accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId: msg.accountId,
    userId: msg.configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: msg.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: msg.interactiveReplyId,
          reply_title: msg.contentText ?? '',
          meta_message_id: msg.externalMessageId,
        }
      : {
          kind: 'text',
          text: msg.contentText ?? '',
          meta_message_id: msg.externalMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = msg.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (msg.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId: msg.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: msg.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // Any contact who messages in and doesn't already have an open deal
  // gets one, native regardless of how they arrived (organic WhatsApp,
  // an Instagram bio link, a saved number) -- the Apify/Meta/site-form
  // bridge (POST /api/v1/deals) already creates deals for leads that
  // come through it with a specific source; this is the fallback for
  // everyone else, so every conversation has pipeline visibility, not
  // just leads from the automated bridges. Runs *after* the automation
  // triggers above so an account-configured keyword-match automation
  // (e.g. "message contains the phrase from ad campaign X" -> create_deal
  // with that campaign's source) gets first shot at creating the deal
  // with the right attribution; this call is then just the no-op check.
  await ensureDealForContact(
    msg.accountId,
    msg.configOwnerUserId,
    contactRecord.id,
    conversation.id,
    contactRecord.name || msg.senderPhone,
    msg.senderPhone,
    msg.adReferral ?? null,
  )

  if (!flowConsumed && !msg.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: msg.accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: msg.configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(db, msg.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: msg.externalMessageId,
    content_type: contentType,
    text: msg.contentText,
  })

  return { conversationId: conversation.id, contactId: contactRecord.id }
}

/**
 * Ensures the contact has an open deal, creating one in the account's
 * default pipeline (oldest pipeline, first stage by position -- same
 * default POST /api/v1/deals uses) if it doesn't. Best-effort: a
 * fresh account with no pipeline yet just skips this rather than
 * blocking message ingestion.
 */
async function ensureDealForContact(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  conversationId: string,
  title: string,
  contactPhone: string,
  adReferral?: {
    adId: string | null
    ctwaClid: string | null
    headline: string | null
    sourceUrl: string | null
  } | null,
): Promise<void> {
  const db = supabaseAdmin()

  const { data: existing } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()
  if (existing) return

  // A `referral` object means this contact's first message came from
  // tapping a Click-to-WhatsApp ad (or an ad's "Send message" CTA) —
  // attribute it the same way as the other paid-traffic bridges
  // (see [[project_meta_leads_sync]]) instead of the generic organic
  // fallback, and keep the ad id / click id on the deal since nothing
  // else in this pipeline carries them.
  const source = adReferral ? 'Tráfego Pago (Meta/Google Ads)' : 'WhatsApp Direto'
  const notes = adReferral
    ? [
        'Origem: Click-to-WhatsApp',
        adReferral.headline ? `Anúncio: ${adReferral.headline}` : null,
        adReferral.adId ? `Ad ID: ${adReferral.adId}` : null,
        adReferral.ctwaClid ? `CTWA Click ID: ${adReferral.ctwaClid}` : null,
        adReferral.sourceUrl ? `Origem do clique: ${adReferral.sourceUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : null

  try {
    const { pipelineId, stageId } = await resolvePipelineAndStage(db, accountId)

    const { data: account } = await db
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()

    const { data: deal, error } = await db
      .from('deals')
      .insert({
        user_id: configOwnerUserId,
        account_id: accountId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        conversation_id: conversationId,
        title,
        value: 0,
        currency: account?.default_currency ?? null,
        source,
        notes,
        status: 'open',
      })
      .select('id')
      .single()
    if (error || !deal) {
      console.error('[inbound-message] ensureDealForContact insert failed:', error)
    } else {
      // Not dispatched for deals created via POST /api/v1/deals (site
      // form, Meta Lead Ads sync, Apify) -- those callers already wrote
      // their own record of the lead (spreadsheet row, etc.) before
      // calling the API, so firing this here would double it up. This
      // is specifically the "nobody else logged this lead" fallback
      // path (organic/direct WhatsApp contact, or now Click-to-WhatsApp
      // via the referral object), so it's always safe to notify
      // subscribers here.
      await dispatchWebhookEvent(db, accountId, 'deal.created', {
        deal_id: deal.id,
        title,
        source,
        contact: { id: contactId, name: title, phone: contactPhone },
      })
    }
  } catch (err) {
    if (err instanceof DealError) {
      // Expected on a brand-new account with no pipeline configured
      // yet -- not worth an error-level log.
      console.warn('[inbound-message] ensureDealForContact skipped:', err.message)
      return
    }
    console.error('[inbound-message] ensureDealForContact failed:', err)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByExternalId(
  externalId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', externalId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-message] lookupInternalIdByExternalId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. Reactions are not new messages — they're
 * per-(target, actor) state. Upserts/deletes on `message_reactions`,
 * never writes a row into `messages`.
 */
async function handleReaction(
  reaction: { emoji: string; targetExternalMessageId: string },
  conversationId: string,
  contactId: string
) {
  const targetInternalId = await lookupInternalIdByExternalId(
    reaction.targetExternalMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-message] reaction target message not found; skipping',
      reaction.targetExternalMessageId
    )
    return
  }

  // Empty emoji = removal (matches Meta's Cloud API convention, reused
  // here as the normalized shape's removal signal).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-message] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound-message] reaction upsert failed:', upsertError.message)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-message] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  channelId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', channelId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-message] error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: channelId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('whatsapp_config_id', channelId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound-message] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
