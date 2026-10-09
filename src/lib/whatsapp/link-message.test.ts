import { afterEach, describe, expect, it, vi } from 'vitest'

import { validateLinkPayload } from './interactive'
import { sendInteractiveLink } from './meta-api'
import { createUazapiProvider } from './uazapi-provider'
import * as uazapiApi from './uazapi-api'

const valid = {
  body: 'Your spot is reserved',
  button_label: 'Buy now',
  url: 'https://checkout.example.com/p?e=a@b.com',
}

describe('validateLinkPayload', () => {
  it('accepts body + label + https url', () => {
    expect(validateLinkPayload(valid).ok).toBe(true)
  })

  it('accepts {{ vars }} placeholders (with spaces) in the url', () => {
    expect(
      validateLinkPayload({ ...valid, url: 'https://x.com/?e={{ vars.email }}' }).ok,
    ).toBe(true)
  })

  it('rejects a missing body, label or non-http url', () => {
    expect(validateLinkPayload({ ...valid, body: ' ' }).ok).toBe(false)
    expect(validateLinkPayload({ ...valid, button_label: '' }).ok).toBe(false)
    expect(validateLinkPayload({ ...valid, url: 'checkout.com' }).ok).toBe(false)
    expect(validateLinkPayload({ ...valid, url: 'javascript:alert(1)' }).ok).toBe(false)
  })

  it('caps the label at 20 chars', () => {
    expect(validateLinkPayload({ ...valid, button_label: 'x'.repeat(21) }).ok).toBe(false)
    expect(validateLinkPayload({ ...valid, button_label: 'x'.repeat(20) }).ok).toBe(true)
  })
})

describe('sendInteractiveLink', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts a cta_url interactive message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.9' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await sendInteractiveLink({
      phoneNumberId: 'PN',
      accessToken: 'tok',
      to: '5511999999999',
      bodyText: valid.body,
      buttonLabel: valid.button_label,
      url: valid.url,
      footerText: 'foot',
    })
    expect(r).toEqual({ messageId: 'wamid.9' })
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.type).toBe('interactive')
    expect(sent.interactive).toEqual({
      type: 'cta_url',
      body: { text: valid.body },
      action: { name: 'cta_url', parameters: { display_text: 'Buy now', url: valid.url } },
      footer: { text: 'foot' },
    })
  })

  it('rejects a bad url before any network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      sendInteractiveLink({
        phoneNumberId: 'PN',
        accessToken: 'tok',
        to: '1',
        bodyText: 'b',
        buttonLabel: 'go',
        url: 'not-a-url',
      }),
    ).rejects.toThrow(/http/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('uazapi sendInteractiveLink', () => {
  it('sends a "label|url" button through /send/menu', async () => {
    const spy = vi.spyOn(uazapiApi, 'sendUazapiMenu').mockResolvedValue({ messageId: 'm1' })
    const provider = createUazapiProvider({
      id: 'c',
      accountId: 'a',
      provider: 'uazapi',
      uazapiBaseUrl: 'https://free.uazapi.com',
      uazapiInstanceToken: 'tok',
    })
    await provider.sendInteractiveLink({
      to: '+1',
      bodyText: 'hi',
      buttonLabel: 'Buy now',
      url: 'https://x.com',
    })
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'tok',
      kind: 'button',
      to: '+1',
      bodyText: 'hi',
      footerText: undefined,
      replyId: undefined,
      buttons: [{ id: 'https://x.com', title: 'Buy now' }],
    })
  })
})
