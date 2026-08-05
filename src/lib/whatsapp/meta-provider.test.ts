import { describe, expect, it, vi } from 'vitest';
import { createMetaProvider } from './meta-provider';
import type { WhatsAppChannel } from './provider';
import * as metaApi from './meta-api';

const channel: WhatsAppChannel = {
  id: 'chan-1',
  accountId: 'acct-1',
  provider: 'meta',
  metaPhoneNumberId: 'PNID_1',
  metaAccessToken: 'tok-1',
};

describe('createMetaProvider', () => {
  it('throws when the channel is missing Meta credentials', () => {
    expect(() =>
      createMetaProvider({ id: 'c', accountId: 'a', provider: 'meta' })
    ).toThrow(/missing Meta credentials/);
  });

  it('re-attaches phoneNumberId/accessToken and forwards to sendTextMessage', async () => {
    const spy = vi
      .spyOn(metaApi, 'sendTextMessage')
      .mockResolvedValue({ messageId: 'wamid.1' });
    const provider = createMetaProvider(channel);
    const result = await provider.sendText({ to: '+14155550123', text: 'hi' });
    expect(result).toEqual({ messageId: 'wamid.1' });
    expect(spy).toHaveBeenCalledWith({
      phoneNumberId: 'PNID_1',
      accessToken: 'tok-1',
      to: '+14155550123',
      text: 'hi',
    });
  });

  it('forwards sendMedia to sendMediaMessage', async () => {
    const spy = vi
      .spyOn(metaApi, 'sendMediaMessage')
      .mockResolvedValue({ messageId: 'wamid.2' });
    const provider = createMetaProvider(channel);
    await provider.sendMedia({ to: '+14155550123', kind: 'image', link: 'https://x/y.jpg' });
    expect(spy).toHaveBeenCalledWith({
      phoneNumberId: 'PNID_1',
      accessToken: 'tok-1',
      to: '+14155550123',
      kind: 'image',
      link: 'https://x/y.jpg',
    });
  });

  it('forwards sendTemplate to sendTemplateMessage', async () => {
    const spy = vi
      .spyOn(metaApi, 'sendTemplateMessage')
      .mockResolvedValue({ messageId: 'wamid.3' });
    const provider = createMetaProvider(channel);
    await provider.sendTemplate({ to: '+14155550123', templateName: 'promo' });
    expect(spy).toHaveBeenCalledWith({
      phoneNumberId: 'PNID_1',
      accessToken: 'tok-1',
      to: '+14155550123',
      templateName: 'promo',
    });
  });

  it('forwards sendReaction to sendReactionMessage', async () => {
    const spy = vi
      .spyOn(metaApi, 'sendReactionMessage')
      .mockResolvedValue({ messageId: 'wamid.4' });
    const provider = createMetaProvider(channel);
    await provider.sendReaction({ to: '+14155550123', targetMessageId: 'wamid.1', emoji: '👍' });
    expect(spy).toHaveBeenCalledWith({
      phoneNumberId: 'PNID_1',
      accessToken: 'tok-1',
      to: '+14155550123',
      targetMessageId: 'wamid.1',
      emoji: '👍',
    });
  });
});
