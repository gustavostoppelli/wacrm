import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolveChannelForConversation,
  resolveDefaultChannelForAccount,
} from './resolve-channel';
import { encrypt } from './encryption';

// ------------------------------------------------------------
// Minimal chainable Supabase stub. Table-keyed rows are looked up by
// whichever `.eq()` filter was applied last; `.limit(1).maybeSingle()`
// and a bare `.maybeSingle()` both resolve to the single matching row.
// `.update()` on whatsapp_config (the legacy-format self-heal) is a
// no-op thenable so the fire-and-forget call doesn't throw.
// ------------------------------------------------------------
interface Row {
  [key: string]: unknown;
}

function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  const builder = (table: string, mode: 'select' | 'update') => {
    const filters: Record<string, unknown> = {};
    const api = {
      select: () => api,
      update: () => builder(table, 'update'),
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: () => {
        if (mode === 'update') return Promise.resolve({ error: null });
        const rows = tables[table] ?? [];
        const match = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v)
        );
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then: (resolve: (v: { error: null }) => void) =>
        resolve({ error: null }),
    };
    return api;
  };

  return {
    from: (table: string) => builder(table, 'select'),
  } as unknown as SupabaseClient;
}

const metaRow = {
  id: 'chan-meta',
  account_id: 'acct-1',
  provider: 'meta',
  phone_number_id: 'PNID_1',
  access_token: encrypt('meta-secret-token'),
};

const uazapiRow = {
  id: 'chan-uazapi',
  account_id: 'acct-1',
  provider: 'uazapi',
  uazapi_base_url: 'https://free.uazapi.com',
  uazapi_instance_token: encrypt('uazapi-secret-token'),
};

describe('resolveDefaultChannelForAccount', () => {
  it('returns null when the account has no channel', async () => {
    const db = makeDb({ whatsapp_config: [] });
    expect(await resolveDefaultChannelForAccount(db, 'acct-1')).toBeNull();
  });

  it('decrypts a Meta channel', async () => {
    const db = makeDb({ whatsapp_config: [metaRow] });
    const channel = await resolveDefaultChannelForAccount(db, 'acct-1');
    expect(channel).toMatchObject({
      id: 'chan-meta',
      provider: 'meta',
      metaPhoneNumberId: 'PNID_1',
      metaAccessToken: 'meta-secret-token',
    });
  });

  it('decrypts a UAZAPI channel', async () => {
    const db = makeDb({ whatsapp_config: [uazapiRow] });
    const channel = await resolveDefaultChannelForAccount(db, 'acct-1');
    expect(channel).toMatchObject({
      id: 'chan-uazapi',
      provider: 'uazapi',
      uazapiBaseUrl: 'https://free.uazapi.com',
      uazapiInstanceToken: 'uazapi-secret-token',
    });
  });
});

describe('resolveChannelForConversation', () => {
  it('resolves the conversation-stamped channel when present', async () => {
    const db = makeDb({
      conversations: [{ id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: 'chan-meta' }],
      whatsapp_config: [metaRow],
    });
    const channel = await resolveChannelForConversation(db, 'acct-1', 'cv-1');
    expect(channel?.id).toBe('chan-meta');
  });

  it('falls back to the account default when the conversation has no channel stamped (pre-migration row)', async () => {
    const db = makeDb({
      conversations: [{ id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: null }],
      whatsapp_config: [metaRow],
    });
    const channel = await resolveChannelForConversation(db, 'acct-1', 'cv-1');
    expect(channel?.id).toBe('chan-meta');
  });

  it('falls back to the account default when the stamped channel no longer exists', async () => {
    const db = makeDb({
      conversations: [{ id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: 'deleted-chan' }],
      whatsapp_config: [metaRow],
    });
    const channel = await resolveChannelForConversation(db, 'acct-1', 'cv-1');
    expect(channel?.id).toBe('chan-meta');
  });

  it('returns null when the account has no channel at all', async () => {
    const db = makeDb({
      conversations: [{ id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: null }],
      whatsapp_config: [],
    });
    expect(await resolveChannelForConversation(db, 'acct-1', 'cv-1')).toBeNull();
  });
});
