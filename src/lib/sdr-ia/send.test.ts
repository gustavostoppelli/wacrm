import { describe, expect, it, vi } from 'vitest'
import { sendSdrIaFirstContact } from './send'
import * as metaSend from '@/lib/automations/meta-send'

describe('sendSdrIaFirstContact', () => {
  it('sends via engineSendTemplate when send_mode is template', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendTemplate').mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
    const result = await sendSdrIaFirstContact({} as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      config: {
        accountId: 'acct-1',
        enabled: true,
        leadTagId: 'tag-1',
        contactedTagId: 'tag-2',
        whatsappConfigId: 'chan-1',
        sendMode: 'template',
        templateName: 'primeiro_contato',
        templateLanguage: 'pt_BR',
        messageVariants: [],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
      },
    })
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'primeiro_contato', language: 'pt_BR' }),
    )
    expect(result.variantIndex).toBeNull()
  })

  it('sends a random variant via engineSendText when send_mode is text', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'wamid.2' })
    const result = await sendSdrIaFirstContact({} as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      config: {
        accountId: 'acct-1',
        enabled: true,
        leadTagId: 'tag-1',
        contactedTagId: 'tag-2',
        whatsappConfigId: 'chan-1',
        sendMode: 'text',
        templateName: null,
        templateLanguage: null,
        messageVariants: ['Oi! Tudo bem?', 'Olá, posso te ajudar?'],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
      },
    })
    expect(spy).toHaveBeenCalled()
    expect(result.variantIndex).toBeGreaterThanOrEqual(0)
    expect(result.variantIndex).toBeLessThan(2)
  })
})
