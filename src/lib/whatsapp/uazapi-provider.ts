import {
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiReaction,
  sendUazapiMenu,
  type UazapiMediaKind,
} from '@/lib/whatsapp/uazapi-api'
import type {
  WhatsAppChannel,
  WhatsAppProvider,
  SendTextParams,
  SendMediaParams,
  SendInteractiveButtonsParams,
  SendInteractiveListParams,
  SendReactionParams,
} from '@/lib/whatsapp/provider'

const UNSUPPORTED = (feature: string) => async (): Promise<never> => {
  throw new Error(
    `${feature} is not supported on UAZAPI channels — this is a Meta-only feature.`
  )
}

/**
 * UAZAPI has no template-approval flow (freeform WhatsApp Web session,
 * not the Cloud API), so `sendTemplate` throws rather than silently
 * degrading — Templates UI is hidden for uazapi-only accounts (Fase 4).
 * Interactive buttons/list and reactions map onto UAZAPI's own
 * `/send/menu` and `/message/react` endpoints.
 */
export function createUazapiProvider(channel: WhatsAppChannel): WhatsAppProvider {
  if (!channel.uazapiBaseUrl || !channel.uazapiInstanceToken) {
    throw new Error(
      `WhatsApp channel ${channel.id} is missing UAZAPI credentials (base_url / instance_token).`
    )
  }
  const baseUrl = channel.uazapiBaseUrl
  const instanceToken = channel.uazapiInstanceToken

  return {
    async sendText(params: SendTextParams) {
      const result = await sendUazapiText({
        baseUrl,
        instanceToken,
        to: params.to,
        text: params.text,
        replyId: params.contextMessageId,
      })
      return { messageId: result.messageId }
    },
    async sendMedia(params: SendMediaParams) {
      const result = await sendUazapiMedia({
        baseUrl,
        instanceToken,
        to: params.to,
        kind: params.kind as UazapiMediaKind,
        file: params.link,
        caption: params.caption,
        docName: params.filename,
        replyId: params.contextMessageId,
      })
      return { messageId: result.messageId }
    },
    sendTemplate: UNSUPPORTED('Approved templates'),
    async sendInteractiveButtons(params: SendInteractiveButtonsParams) {
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        kind: 'button',
        to: params.to,
        bodyText: params.bodyText,
        footerText: params.footerText,
        replyId: params.contextMessageId,
        buttons: params.buttons,
      })
      return { messageId: result.messageId }
    },
    async sendInteractiveList(params: SendInteractiveListParams) {
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        kind: 'list',
        to: params.to,
        bodyText: params.bodyText,
        footerText: params.footerText,
        replyId: params.contextMessageId,
        buttonLabel: params.buttonLabel,
        sections: params.sections,
      })
      return { messageId: result.messageId }
    },
    async sendReaction(params: SendReactionParams) {
      const result = await sendUazapiReaction({
        baseUrl,
        instanceToken,
        to: params.to,
        targetMessageId: params.targetMessageId,
        emoji: params.emoji,
      })
      return { messageId: result.messageId }
    },
  }
}
