import { describe, expect, it, vi } from 'vitest'
import { findOrCreateConversationForChannel, sendSdrIaFirstContact } from './send'
import * as metaSend from '@/lib/automations/meta-send'

describe('findOrCreateConversationForChannel', () => {
  it('returns existing conversation id without calling insert', async () => {
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'conv-existing' } }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }
    const result = await findOrCreateConversationForChannel(
      mockDb as never,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1',
    )
    expect(result).toBe('conv-existing')
  })

  it('creates new conversation when none exists', async () => {
    const insertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'conv-new' }, error: null }),
      }),
    })
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
            insert: insertMock,
          }
        }
        return {}
      }),
    }
    const result = await findOrCreateConversationForChannel(
      mockDb as never,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1',
    )
    expect(result).toBe('conv-new')
    expect(insertMock).toHaveBeenCalledWith({
      account_id: 'acct-1',
      user_id: 'user-1',
      contact_id: 'contact-1',
      whatsapp_config_id: 'chan-1',
    })
  })
})

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
    expect(spy).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      templateName: 'primeiro_contato',
      language: 'pt_BR',
    })
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
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: expect.stringMatching(/^(Oi! Tudo bem\?|Olá, posso te ajudar\?)$/),
      }),
    )
    expect(result.variantIndex).toBeGreaterThanOrEqual(0)
    expect(result.variantIndex).toBeLessThan(2)
  })
})
