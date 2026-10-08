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
        exclusionTagId: null,
        whatsappConfigId: 'chan-1',
        sendMode: 'template',
        templateName: 'primeiro_contato',
        templateLanguage: 'pt_BR',
        messageVariants: [],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
        sentToday: 0,
        lastSentDate: null,
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
        exclusionTagId: null,
        whatsappConfigId: 'chan-1',
        sendMode: 'text',
        templateName: null,
        templateLanguage: null,
        messageVariants: ['Oi! Tudo bem?', 'Olá, posso te ajudar?'],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
        sentToday: 0,
        lastSentDate: null,
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

// ---- first-name personalisation ------------------------------------------

import { firstNameOf, countTemplateVariables } from './send'

/** Chainable stub: every filter returns itself; maybeSingle resolves the table's row. */
function fakeDb(rows: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit']) q[m] = () => q
      q.maybeSingle = async () => ({ data: rows[table] ?? null })
      return q
    },
  } as never
}

const baseConfig = {
  accountId: 'acct-1', enabled: true, leadTagId: 't1', contactedTagId: 't2', exclusionTagId: null,
  whatsappConfigId: 'chan-1', dailyCap: 5, hoursStart: 9, hoursEnd: 18, sentToday: 0, lastSentDate: null,
}
const args = (config: object) => ({
  accountId: 'acct-1', userId: 'user-1', contactId: 'contact-1', conversationId: 'conv-1',
  config: { ...baseConfig, ...config } as never,
})

describe('first-name helpers', () => {
  it('takes the first word of a name', () => {
    expect(firstNameOf('Maria da Silva')).toBe('Maria')
    expect(firstNameOf('  Ana  ')).toBe('Ana')
    expect(firstNameOf('')).toBe('')
    expect(firstNameOf(null)).toBe('')
  })

  it('counts distinct numbered variables in a template body', () => {
    expect(countTemplateVariables('Olá!')).toBe(0)
    expect(countTemplateVariables('Olá {{1}}!')).toBe(1)
    expect(countTemplateVariables('Olá {{1}}, {{1}} de novo')).toBe(1)
    expect(countTemplateVariables('{{1}} e {{2}}')).toBe(2)
  })
})

describe('sendSdrIaFirstContact — personalisation', () => {
  it('fills {{vars.primeiro_nome}} in a text variant with the contact first name', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(fakeDb({ contacts: { name: 'Maria da Silva' } }), args({
      sendMode: 'text', templateName: null, templateLanguage: null,
      messageVariants: ['Oi {{vars.primeiro_nome}}, tudo bem?'],
    }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Oi Maria, tudo bem?' }))
  })

  it('does not break the text when the contact has no real name (name is a phone number)', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(fakeDb({ contacts: { name: '5511999998888' } }), args({
      sendMode: 'text', templateName: null, templateLanguage: null,
      messageVariants: ['Oi {{vars.primeiro_nome}}!'],
    }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Oi !' }))
  })

  it('passes the first name as the template parameter when the template has exactly one variable', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendTemplate').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(fakeDb({ contacts: { name: 'Maria da Silva' }, message_templates: { body_text: 'Olá {{1}}, tudo bem?' } }), args({
      sendMode: 'template', templateName: 'primeiro_contato', templateLanguage: 'pt_BR', messageVariants: [],
    }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ params: ['Maria'] }))
  })

  it('uses a neutral word instead of an empty template parameter when there is no name', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendTemplate').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(fakeDb({ contacts: { name: '' }, message_templates: { body_text: 'Olá {{1}}!' } }), args({
      sendMode: 'template', templateName: 'primeiro_contato', templateLanguage: 'pt_BR', messageVariants: [],
    }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ params: ['você'] }))
  })

  it('sends NO template parameters when the template has no variable or several', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendTemplate').mockResolvedValue({ whatsapp_message_id: 'w' })
    for (const body of ['Olá, tudo bem?', 'Olá {{1}}, {{2}}']) {
      await sendSdrIaFirstContact(fakeDb({ contacts: { name: 'Maria' }, message_templates: { body_text: body } }), args({
        sendMode: 'template', templateName: 'primeiro_contato', templateLanguage: 'pt_BR', messageVariants: [],
      }))
      expect((spy.mock.calls.at(-1)?.[0] as { params?: string[] }).params).toBeUndefined()
    }
  })
})
