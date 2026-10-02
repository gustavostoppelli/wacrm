import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const addedTagIds: string[] = [];
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: vi.fn(async ({ tagId }: { tagId: string }) => {
    addedTagIds.push(tagId);
    return { added: true, dispatched: true };
  }),
}));

import {
  serializeContact,
  findOrCreateContact,
  setContactTags,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});

describe('setContactTags', () => {
  // Account already holds three tags; the contact currently has none.
  function fakeDb(): SupabaseClient {
    const accountTags = [
      { id: 't-a', name: 'compraaprovada_cpot20' },
      { id: 't-b', name: 'carrinhoabandonado_cpot20' },
      { id: 't-c', name: 'pedidodereembolso_cpot20' },
    ];
    return {
      from: (table: string) => ({
        select: () => ({
          eq: async () =>
            table === 'tags'
              ? { data: accountTags, error: null }
              : { data: [], error: null },
        }),
      }),
    } as unknown as SupabaseClient;
  }

  it('attaches only the requested tags, not every tag in the account', async () => {
    addedTagIds.length = 0;
    await setContactTags(fakeDb(), 'acc', 'user', 'contact-1', [
      'Compraaprovada_CPOT20',
    ]);
    expect(addedTagIds).toEqual(['t-a']);
  });
});
