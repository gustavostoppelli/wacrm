import type {
  SendTextMessageArgs,
  SendMediaMessageArgs,
  SendTemplateMessageArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendReactionMessageArgs,
  MetaSendResult,
} from '@/lib/whatsapp/meta-api'
import type { WhatsAppConfig } from '@/types'
import { createMetaProvider } from '@/lib/whatsapp/meta-provider'
import { createUazapiProvider } from '@/lib/whatsapp/uazapi-provider'

/**
 * Provider-agnostic WhatsApp channel abstraction.
 *
 * A `WhatsAppChannel` is a decrypted, in-memory view of one
 * `whatsapp_config` row — enough for a provider implementation to send
 * on its behalf without every call site re-fetching + decrypting the
 * row itself. `getProviderForChannel` picks the right implementation
 * (`meta-provider.ts` today; `uazapi-provider.ts` in a later phase)
 * based on `channel.provider`.
 *
 * Method signatures intentionally mirror `meta-api.ts`'s existing
 * `Args` shapes minus `phoneNumberId`/`accessToken` — those are Meta-
 * specific transport details bound to the channel instance instead of
 * threaded through every call site. This keeps the refactor of
 * `send-message.ts` / `flows/meta-send.ts` / `automations/meta-send.ts`
 * mechanical: swap the two bound fields for a channel reference, keep
 * every other argument identical.
 */
export interface WhatsAppChannel {
  id: string
  accountId: string
  provider: WhatsAppConfig['provider']
  /** Decrypted Meta access token. Only set when provider === 'meta'. */
  metaAccessToken?: string
  metaPhoneNumberId?: string
  /** Decrypted UAZAPI instance token. Only set when provider === 'uazapi'. */
  uazapiInstanceToken?: string
  uazapiBaseUrl?: string
}

export type SendTextParams = Omit<SendTextMessageArgs, 'phoneNumberId' | 'accessToken'>
export type SendMediaParams = Omit<SendMediaMessageArgs, 'phoneNumberId' | 'accessToken'>
export type SendTemplateParams = Omit<SendTemplateMessageArgs, 'phoneNumberId' | 'accessToken'>
export type SendInteractiveButtonsParams = Omit<
  SendInteractiveButtonsArgs,
  'phoneNumberId' | 'accessToken'
>
export type SendInteractiveListParams = Omit<
  SendInteractiveListArgs,
  'phoneNumberId' | 'accessToken'
>
export type SendReactionParams = Omit<SendReactionMessageArgs, 'phoneNumberId' | 'accessToken'>

export interface WhatsAppProvider {
  sendText(params: SendTextParams): Promise<MetaSendResult>
  sendMedia(params: SendMediaParams): Promise<MetaSendResult>
  /**
   * Pre-approved template send. UAZAPI has no template-approval concept
   * (Templates UI is hidden for uazapi channels — see Fase 4), so its
   * implementation throws rather than silently degrading to free text.
   */
  sendTemplate(params: SendTemplateParams): Promise<MetaSendResult>
  sendInteractiveButtons(params: SendInteractiveButtonsParams): Promise<MetaSendResult>
  sendInteractiveList(params: SendInteractiveListParams): Promise<MetaSendResult>
  sendReaction(params: SendReactionParams): Promise<MetaSendResult>
}

export function getProviderForChannel(channel: WhatsAppChannel): WhatsAppProvider {
  switch (channel.provider) {
    case 'meta':
      return createMetaProvider(channel)
    case 'uazapi':
      return createUazapiProvider(channel)
    default:
      throw new Error(`Unknown WhatsApp provider "${channel.provider}"`)
  }
}
