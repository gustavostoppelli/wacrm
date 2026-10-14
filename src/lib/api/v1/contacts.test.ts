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
  setContactCustomFields,
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

describe('setContactCustomFields', () => {
  function fakeDb(existing: Array<{ id: string; field_name: string }>) {
    const inserted: unknown[] = [];
    const upserted: unknown[] = [];
    const db = {
      from: (table: string) => {
        if (table === 'custom_fields') {
          return {
            select: () => ({ eq: () => Promise.resolve({ data: existing, error: null }) }),
            insert: (row: unknown) => {
              inserted.push(row);
              return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-field' }, error: null }) }) };
            },
          };
        }
        return {
          upsert: (rows: unknown) => {
            upserted.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      },
    } as unknown as SupabaseClient;
    return { db, inserted, upserted };
  }

  it('reuses an existing field (case-insensitive) without creating one', async () => {
    const { db, inserted, upserted } = fakeDb([{ id: 'f1', field_name: 'Especialidade' }]);
    await setContactCustomFields(db, 'a1', 'u1', 'c1', { especialidade: 'dermatologia' });
    expect(inserted).toHaveLength(0);
    expect(upserted[0]).toEqual([{ contact_id: 'c1', custom_field_id: 'f1', value: 'dermatologia' }]);
  });

  it('creates a missing field scoped to the account', async () => {
    const { db, inserted, upserted } = fakeDb([]);
    await setContactCustomFields(db, 'a1', 'u1', 'c1', { Cidade: 'SP' });
    expect(inserted[0]).toMatchObject({ account_id: 'a1', user_id: 'u1', field_name: 'Cidade' });
    expect(upserted[0]).toEqual([{ contact_id: 'c1', custom_field_id: 'new-field', value: 'SP' }]);
  });
});
