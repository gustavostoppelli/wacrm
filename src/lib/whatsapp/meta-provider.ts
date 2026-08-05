import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import type {
  WhatsAppChannel,
  WhatsAppProvider,
  SendTextParams,
  SendMediaParams,
  SendTemplateParams,
  SendInteractiveButtonsParams,
  SendInteractiveListParams,
  SendReactionParams,
} from '@/lib/whatsapp/provider'

/**
 * Thin adapter over the existing `meta-api.ts` functions. Every method
 * just re-attaches `phoneNumberId`/`accessToken` from the channel and
 * forwards — no behaviour change from the pre-refactor direct calls.
 */
export function createMetaProvider(channel: WhatsAppChannel): WhatsAppProvider {
  if (!channel.metaPhoneNumberId || !channel.metaAccessToken) {
    throw new Error(
      `WhatsApp channel ${channel.id} is missing Meta credentials (phone_number_id / access_token).`
    )
  }
  const phoneNumberId = channel.metaPhoneNumberId
  const accessToken = channel.metaAccessToken

  return {
    sendText(params: SendTextParams) {
      return sendTextMessage({ phoneNumberId, accessToken, ...params })
    },
    sendMedia(params: SendMediaParams) {
      return sendMediaMessage({ phoneNumberId, accessToken, ...params })
    },
    sendTemplate(params: SendTemplateParams) {
      return sendTemplateMessage({ phoneNumberId, accessToken, ...params })
    },
    sendInteractiveButtons(params: SendInteractiveButtonsParams) {
      return sendInteractiveButtons({ phoneNumberId, accessToken, ...params })
    },
    sendInteractiveList(params: SendInteractiveListParams) {
      return sendInteractiveList({ phoneNumberId, accessToken, ...params })
    },
    sendReaction(params: SendReactionParams) {
      return sendReactionMessage({ phoneNumberId, accessToken, ...params })
    },
  }
}
