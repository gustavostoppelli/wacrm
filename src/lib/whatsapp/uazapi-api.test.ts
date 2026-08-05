import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInstance,
  deleteInstance,
  connectInstance,
  getInstanceStatus,
  registerWebhook,
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiReaction,
  sendUazapiMenu,
} from './uazapi-api';

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('uazapi-api', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createInstance POSTs to /instance/create with admintoken header', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ instance: { id: 'inst-1', status: 'disconnected' }, token: 'tok-1' })
    );
    const result = await createInstance({
      baseUrl: 'https://free.uazapi.com/',
      adminToken: 'admin-tok',
      name: 'wacrm',
    });
    expect(result).toEqual({ id: 'inst-1', token: 'tok-1', status: 'disconnected' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://free.uazapi.com/instance/create');
    expect(init.headers.admintoken).toBe('admin-tok');
    expect(JSON.parse(init.body)).toEqual({ name: 'wacrm' });
  });

  it('createInstance surfaces the UAZAPI error message on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ error: 'Invalid AdminToken Header' }, 403)
    );
    await expect(
      createInstance({ baseUrl: 'https://x.com', adminToken: 'bad' })
    ).rejects.toThrow(/Invalid AdminToken Header/);
  });

  it('deleteInstance DELETEs with the instance token, tolerates 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      deleteInstance({ baseUrl: 'https://x.com', instanceToken: 'tok' })
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.com/instance');
    expect(init.method).toBe('DELETE');
    expect(init.headers.token).toBe('tok');
  });

  it('connectInstance returns qrcode/paircode from the instance object', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        connected: false,
        loggedIn: false,
        instance: { qrcode: 'data:image/png;base64,abc', status: 'connecting' },
      })
    );
    const result = await connectInstance({ baseUrl: 'https://x.com', instanceToken: 'tok' });
    expect(result).toEqual({
      connected: false,
      loggedIn: false,
      qrcode: 'data:image/png;base64,abc',
      paircode: undefined,
      status: 'connecting',
    });
  });

  it('getInstanceStatus reports connected from status.connected', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        instance: { status: 'connected' },
        status: { connected: true, loggedIn: true },
      })
    );
    const result = await getInstanceStatus({ baseUrl: 'https://x.com', instanceToken: 'tok' });
    expect(result.connected).toBe(true);
    expect(result.status).toBe('connected');
  });

  it('registerWebhook POSTs the webhook config with wasSentByApi excluded', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([{ id: 'wh-1' }]));
    await registerWebhook({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      webhookUrl: 'https://crm.example.com/api/uazapi/webhook?ch=1&key=2',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.com/webhook');
    const body = JSON.parse(init.body);
    expect(body.excludeMessages).toEqual(['wasSentByApi']);
    expect(body.url).toBe('https://crm.example.com/api/uazapi/webhook?ch=1&key=2');
  });

  it('sendUazapiText posts number+text and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'msg-1' }));
    const result = await sendUazapiText({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      to: '+14155550123',
      text: 'hi',
    });
    expect(result).toEqual({ messageId: 'msg-1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ number: '+14155550123', text: 'hi' });
  });

  it('sendUazapiMedia posts number+type+file and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'msg-2' }));
    const result = await sendUazapiMedia({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      to: '+14155550123',
      kind: 'image',
      file: 'https://example.com/pic.jpg',
    });
    expect(result).toEqual({ messageId: 'msg-2' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      number: '+14155550123',
      type: 'image',
      file: 'https://example.com/pic.jpg',
    });
  });

  it('sendUazapiReaction posts number+text(emoji)+id and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'msg-3' }));
    const result = await sendUazapiReaction({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      to: '+14155550123',
      targetMessageId: 'wamid.1',
      emoji: '👍',
    });
    expect(result).toEqual({ messageId: 'msg-3' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.com/message/react');
    expect(JSON.parse(init.body)).toEqual({
      number: '+14155550123',
      text: '👍',
      id: 'wamid.1',
    });
  });

  it('sendUazapiMenu builds pipe-delimited choices for buttons', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'msg-4' }));
    await sendUazapiMenu({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      kind: 'button',
      to: '+1',
      bodyText: 'Pick one',
      buttons: [
        { id: 'a', title: 'Option A' },
        { id: 'b', title: 'Option B' },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.com/send/menu');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('button');
    expect(body.choices).toEqual(['Option A|a', 'Option B|b']);
  });

  it('sendUazapiMenu builds section-prefixed choices for lists', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'msg-5' }));
    await sendUazapiMenu({
      baseUrl: 'https://x.com',
      instanceToken: 'tok',
      kind: 'list',
      to: '+1',
      bodyText: 'Choose',
      buttonLabel: 'Open',
      sections: [
        { title: 'Fruits', rows: [{ id: 'r1', title: 'Apple', description: 'Red' }] },
      ],
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.listButton).toBe('Open');
    expect(body.choices).toEqual(['[Fruits]', 'Apple|r1|Red']);
  });

  it('throws on non-OK send responses', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'Rate limit exceeded' }, 429));
    await expect(
      sendUazapiText({ baseUrl: 'https://x.com', instanceToken: 'tok', to: '+1', text: 'hi' })
    ).rejects.toThrow(/Rate limit exceeded/);
  });
});
