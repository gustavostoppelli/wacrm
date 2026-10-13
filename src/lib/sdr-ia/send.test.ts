import { describe, expect, it, vi } from 'vitest'
import {
  findOrCreateConversationForChannel,
  sendSdrIaFirstContact,
  isSendSpacingSatisfied,
  MIN_MINUTES_BETWEEN_SDR_IA_SENDS,
} from './send'
import * as metaSend from '@/lib/automations/meta-send'

describe('isSendSpacingSatisfied', () => {
  const NOW = new Date('2026-10-13T12:00:00.000Z')

  it('is satisfied when the account has never sent anything (lastSentAt null)', () => {
    expect(isSendSpacingSatisfied(null, NOW)).toBe(true)
  })

  it('is not satisfied right after a send', () => {
    expect(isSendSpacingSatisfied(NOW.toISOString(), NOW)).toBe(false)
  })

  it('is not satisfied one minute before the minimum window elapses', () => {
    const lastSentAt = new Date(NOW.getTime() - (MIN_MINUTES_BETWEEN_SDR_IA_SENDS - 1) * 60_000).toISOString()
    expect(isSendSpacingSatisfied(lastSentAt, NOW)).toBe(false)
  })

  it('is satisfied exactly at the minimum window', () => {
    const lastSentAt = new Date(NOW.getTime() - MIN_MINUTES_BETWEEN_SDR_IA_SENDS * 60_000).toISOString()
    expect(isSendSpacingSatisfied(lastSentAt, NOW)).toBe(true)
  })

  it('is satisfied well past the minimum window', () => {
    const lastSentAt = new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString()
    expect(isSendSpacingSatisfied(lastSentAt, NOW)).toBe(true)
  })
})

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
        lastSentDate: null, lastSentAt: null,
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
        lastSentDate: null, lastSentAt: null,
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

import { firstNameOf, countTemplateVariables, customFieldVarKey } from './send'

/**
 * Chainable stub: every filter returns itself. `.maybeSingle()` and
 * directly `await`-ing the chain (no `.maybeSingle()`, matching how
 * `loadContactPersonalizationVars` lists `contact_custom_values`)
 * both resolve from the same `rows[table]` entry — a plain object
 * for the single-row case, an array for the list case.
 */
function fakeDb(rows: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit']) q[m] = () => q
      q.maybeSingle = async () => ({ data: rows[table] ?? null })
      q.then = (resolve: (v: { data: unknown[] }) => unknown) => {
        const value = rows[table]
        return Promise.resolve({ data: Array.isArray(value) ? value : value ? [value] : [] }).then(resolve)
      }
      return q
    },
  } as never
}

const baseConfig = {
  accountId: 'acct-1', enabled: true, leadTagId: 't1', contactedTagId: 't2', exclusionTagId: null,
  whatsappConfigId: 'chan-1', dailyCap: 5, hoursStart: 9, hoursEnd: 18, sentToday: 0, lastSentDate: null, lastSentAt: null,
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

describe('customFieldVarKey', () => {
  it('lowercases and turns spaces into underscores', () => {
    expect(customFieldVarKey('Especialidade')).toBe('especialidade')
    expect(customFieldVarKey('Cidade de Origem')).toBe('cidade_de_origem')
    expect(customFieldVarKey('  Nome  Social  ')).toBe('nome_social')
  })
})

describe('sendSdrIaFirstContact — company and custom field personalisation', () => {
  it('fills {{vars.empresa}} with the contact company', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(
      fakeDb({ contacts: { name: 'Maria', company: 'Clínica Bela Vida' } }),
      args({
        sendMode: 'text', templateName: null, templateLanguage: null,
        messageVariants: ['Oi {{vars.primeiro_nome}}, da {{vars.empresa}}!'],
      }),
    )
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Oi Maria, da Clínica Bela Vida!' }))
  })

  it('fills a token matching an account-defined custom field (e.g. {{vars.especialidade}})', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(
      fakeDb({
        contacts: { name: 'Maria', company: 'Clínica Bela Vida' },
        contact_custom_values: [
          { value: 'Harmonização Facial', custom_fields: { field_name: 'Especialidade' } },
        ],
      }),
      args({
        sendMode: 'text', templateName: null, templateLanguage: null,
        messageVariants: ['Vi que vocês atendem {{vars.especialidade}}.'],
      }),
    )
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Vi que vocês atendem Harmonização Facial.' }),
    )
  })

  it('leaves a custom-field token empty when the account has no such field or value for this contact', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(
      fakeDb({ contacts: { name: 'Maria' }, contact_custom_values: [] }),
      args({
        sendMode: 'text', templateName: null, templateLanguage: null,
        messageVariants: ['Especialidade: {{vars.especialidade}}.'],
      }),
    )
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Especialidade: .' }))
  })

  it('never lets a custom field override the built-in name/company tokens', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendSdrIaFirstContact(
      fakeDb({
        contacts: { name: 'Maria', company: 'Clínica Bela Vida' },
        contact_custom_values: [{ value: 'Outro Nome', custom_fields: { field_name: 'nome' } }],
      }),
      args({
        sendMode: 'text', templateName: null, templateLanguage: null,
        messageVariants: ['{{vars.nome}}'],
      }),
    )
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Maria' }))
  })
})
