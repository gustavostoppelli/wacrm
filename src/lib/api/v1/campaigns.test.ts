import { describe, expect, it } from 'vitest';
import { findOrCreateCampaign, findOrCreateVariant, listVariantsWithCounts } from './campaigns';

function makeDb(opts: {
  existing?: { id: string } | null;
  inserted?: { id: string };
  insertError?: { code?: string };
  racedAfterInsertFail?: { id: string };
}) {
  let selectCalls = 0;
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => {
              selectCalls++;
              if (selectCalls === 1) return Promise.resolve({ data: opts.existing ?? null, error: null });
              return Promise.resolve({ data: opts.racedAfterInsertFail ?? null, error: null });
            },
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () =>
            opts.insertError
              ? Promise.resolve({ data: null, error: opts.insertError })
              : Promise.resolve({ data: opts.inserted, error: null }),
        }),
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('findOrCreateCampaign', () => {
  it('returns the existing campaign when the name matches', async () => {
    const db = makeDb({ existing: { id: 'camp-1' } });
    const res = await findOrCreateCampaign(db, 'acct-1', 'Contato Frio Outbound');
    expect(res).toEqual({ id: 'camp-1', created: false });
  });

  it('creates a new campaign when none exists', async () => {
    const db = makeDb({ existing: null, inserted: { id: 'camp-2' } });
    const res = await findOrCreateCampaign(db, 'acct-1', 'Nova Campanha');
    expect(res).toEqual({ id: 'camp-2', created: true });
  });

  it('re-resolves when the insert loses a unique-constraint race', async () => {
    const db = makeDb({
      existing: null,
      insertError: { code: '23505' },
      racedAfterInsertFail: { id: 'camp-raced' },
    });
    const res = await findOrCreateCampaign(db, 'acct-1', 'Corrida');
    expect(res).toEqual({ id: 'camp-raced', created: false });
  });
});

describe('findOrCreateVariant', () => {
  it('returns the existing variant when the name matches', async () => {
    const db = makeDb({ existing: { id: 'var-1' } });
    const res = await findOrCreateVariant(db, 'camp-1', 'A');
    expect(res).toEqual({ id: 'var-1', created: false });
  });

  it('creates a new variant when none exists', async () => {
    const db = makeDb({ existing: null, inserted: { id: 'var-2' } });
    const res = await findOrCreateVariant(db, 'camp-1', 'B');
    expect(res).toEqual({ id: 'var-2', created: true });
  });
});

describe('listVariantsWithCounts', () => {
  it('returns each variant with how many assignments it has', async () => {
    const db = {
      from: (table: string) => {
        if (table === 'campaign_variants') {
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [{ id: 'var-a', name: 'A' }, { id: 'var-b', name: 'B' }],
                  error: null,
                }),
            }),
          };
        }
        if (table === 'campaign_assignments') {
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [{ variant_id: 'var-a' }, { variant_id: 'var-a' }, { variant_id: 'var-b' }],
                  error: null,
                }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const result = await listVariantsWithCounts(db, 'camp-1');
    expect(result).toEqual([
      { id: 'var-a', name: 'A', assignedCount: 2 },
      { id: 'var-b', name: 'B', assignedCount: 1 },
    ]);
  });
});
