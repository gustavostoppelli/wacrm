import { describe, expect, it, vi } from 'vitest';
import { createUazapiProvider } from './uazapi-provider';
import type { WhatsAppChannel } from './provider';
import * as uazapiApi from './uazapi-api';

const channel: WhatsAppChannel = {
  id: 'chan-1',
  accountId: 'acct-1',
  provider: 'uazapi',
  uazapiBaseUrl: 'https://free.uazapi.com',
  uazapiInstanceToken: 'inst-tok',
};

describe('createUazapiProvider', () => {
  it('throws when the channel is missing UAZAPI credentials', () => {
    expect(() =>
      createUazapiProvider({ id: 'c', accountId: 'a', provider: 'uazapi' })
    ).toThrow(/missing UAZAPI credentials/);
  });

  it('forwards sendText to sendUazapiText with the channel credentials', async () => {
    const spy = vi
      .spyOn(uazapiApi, 'sendUazapiText')
      .mockResolvedValue({ messageId: 'm1' });
    const provider = createUazapiProvider(channel);
    const result = await provider.sendText({ to: '+14155550123', text: 'hi' });
    expect(result).toEqual({ messageId: 'm1' });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'inst-tok',
      to: '+14155550123',
      text: 'hi',
      replyId: undefined,
    });
  });

  it('forwards sendMedia to sendUazapiMedia', async () => {
    const spy = vi
      .spyOn(uazapiApi, 'sendUazapiMedia')
      .mockResolvedValue({ messageId: 'm2' });
    const provider = createUazapiProvider(channel);
    await provider.sendMedia({
      to: '+14155550123',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'look',
    });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'inst-tok',
      to: '+14155550123',
      kind: 'image',
      file: 'https://x/y.jpg',
      caption: 'look',
      docName: undefined,
      replyId: undefined,
    });
  });

  it('throws for template sends — a Meta-only, approval-based feature', async () => {
    const provider = createUazapiProvider(channel);
    await expect(provider.sendTemplate({ to: '+1', templateName: 'promo' })).rejects.toThrow(
      /not supported on UAZAPI/
    );
  });

  it('forwards sendInteractiveButtons to /send/menu with the pipe-delimited choices format', async () => {
    const spy = vi
      .spyOn(uazapiApi, 'sendUazapiMenu')
      .mockResolvedValue({ messageId: 'm3' });
    const provider = createUazapiProvider(channel);
    await provider.sendInteractiveButtons({
      to: '+1',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'Option A' }],
    });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'inst-tok',
      kind: 'button',
      to: '+1',
      bodyText: 'Pick one',
      footerText: undefined,
      replyId: undefined,
      buttons: [{ id: 'a', title: 'Option A' }],
    });
  });

  it('forwards sendInteractiveList to /send/menu', async () => {
    const spy = vi
      .spyOn(uazapiApi, 'sendUazapiMenu')
      .mockResolvedValue({ messageId: 'm4' });
    const provider = createUazapiProvider(channel);
    await provider.sendInteractiveList({
      to: '+1',
      bodyText: 'Choose',
      buttonLabel: 'Open',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'inst-tok',
      kind: 'list',
      to: '+1',
      bodyText: 'Choose',
      footerText: undefined,
      replyId: undefined,
      buttonLabel: 'Open',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    });
  });

  it('forwards sendReaction to sendUazapiReaction', async () => {
    const spy = vi
      .spyOn(uazapiApi, 'sendUazapiReaction')
      .mockResolvedValue({ messageId: 'm5' });
    const provider = createUazapiProvider(channel);
    await provider.sendReaction({ to: '+1', targetMessageId: 'wamid.1', emoji: '👍' });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'https://free.uazapi.com',
      instanceToken: 'inst-tok',
      to: '+1',
      targetMessageId: 'wamid.1',
      emoji: '👍',
    });
  });
});
