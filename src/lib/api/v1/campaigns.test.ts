import { describe, expect, it } from 'vitest';
import { findOrCreateCampaign, findOrCreateVariant, listVariantsWithCounts, createAssignment } from './campaigns';

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

// Table-dispatched mock for the variant functions, which now look up
// the owning campaign (campaigns.id + campaigns.account_id) before
// touching campaign_variants/campaign_assignments.
function makeVariantDb(opts: {
  campaignOwned?: boolean; // default true — campaign belongs to the caller's account
  existingVariant?: { id: string } | null;
  insertedVariant?: { id: string };
  variants?: Array<{ id: string; name: string }>;
  assignments?: Array<{ variant_id: string }>;
}) {
  const ownershipEq = () => ({
    eq: () => ({
      maybeSingle: () =>
        Promise.resolve({
          data: opts.campaignOwned === false ? null : { id: 'camp-1' },
          error: null,
        }),
    }),
  });
  return {
    from: (table: string) => {
      if (table === 'campaigns') {
        return { select: () => ({ eq: ownershipEq }) };
      }
      if (table === 'campaign_variants') {
        return {
          select: () => ({
            eq: (column: string) => {
              // listVariantsWithCounts calls .eq('campaign_id', id) and awaits
              // the result directly; findOrCreateVariant chains a second
              // .eq('name', name).maybeSingle(). Disambiguate via `variants`,
              // which only the listVariantsWithCounts tests set.
              if (column === 'campaign_id' && opts.variants) {
                return Promise.resolve({ data: opts.variants, error: null });
              }
              return {
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: opts.existingVariant ?? null, error: null }),
                }),
              };
            },
          }),
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: opts.insertedVariant, error: null }),
            }),
          }),
        };
      }
      if (table === 'campaign_assignments') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: opts.assignments ?? [], error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('findOrCreateVariant', () => {
  it('returns the existing variant when the name matches', async () => {
    const db = makeVariantDb({ existingVariant: { id: 'var-1' } });
    const res = await findOrCreateVariant(db, 'camp-1', 'acct-1', 'A');
    expect(res).toEqual({ id: 'var-1', created: false });
  });

  it('creates a new variant when none exists', async () => {
    const db = makeVariantDb({ existingVariant: null, insertedVariant: { id: 'var-2' } });
    const res = await findOrCreateVariant(db, 'camp-1', 'acct-1', 'B');
    expect(res).toEqual({ id: 'var-2', created: true });
  });

  it('throws a 404 CampaignError when the campaign belongs to a different account', async () => {
    const db = makeVariantDb({ campaignOwned: false, existingVariant: { id: 'var-1' } });
    await expect(findOrCreateVariant(db, 'camp-1', 'acct-other', 'A')).rejects.toMatchObject({
      name: 'CampaignError',
      status: 404,
    });
  });
});

describe('listVariantsWithCounts', () => {
  it('returns each variant with how many assignments it has', async () => {
    const db = makeVariantDb({
      variants: [{ id: 'var-a', name: 'A' }, { id: 'var-b', name: 'B' }],
      assignments: [{ variant_id: 'var-a' }, { variant_id: 'var-a' }, { variant_id: 'var-b' }],
    });

    const result = await listVariantsWithCounts(db, 'camp-1', 'acct-1');
    expect(result).toEqual([
      { id: 'var-a', name: 'A', assignedCount: 2 },
      { id: 'var-b', name: 'B', assignedCount: 1 },
    ]);
  });

  it('throws a 404 CampaignError when the campaign belongs to a different account', async () => {
    const db = makeVariantDb({ campaignOwned: false });
    await expect(listVariantsWithCounts(db, 'camp-1', 'acct-other')).rejects.toMatchObject({
      name: 'CampaignError',
      status: 404,
    });
  });
});

// Table-dispatched mock for createAssignment, which looks up the owning
// campaign (campaigns.id + campaigns.account_id) before touching
// campaign_assignments, same ownership-check pattern as findOrCreateVariant.
function makeAssignmentDb(opts: {
  campaignOwned?: boolean; // default true — campaign belongs to the caller's account
  existingAssignment?: { id: string } | null;
  insertedAssignment?: { id: string };
}) {
  return {
    from: (table: string) => {
      if (table === 'campaigns') {
        return {
          select: () => ({
            eq: () => ({
              eq: () =>
                ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.campaignOwned === false ? null : { id: 'camp-1' },
                      error: null,
                    }),
                }),
            }),
          }),
        };
      }
      if (table === 'campaign_assignments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: opts.existingAssignment ?? null, error: null }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: opts.insertedAssignment, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('createAssignment', () => {
  it('creates a new assignment', async () => {
    const db = makeAssignmentDb({ existingAssignment: null, insertedAssignment: { id: 'assign-1' } });

    const res = await createAssignment(db, {
      accountId: 'acct-1', campaignId: 'camp-1', variantId: 'var-1', contactId: 'c1',
    });
    expect(res).toEqual({ id: 'assign-1', created: true });
  });

  it('returns the existing assignment without erroring when one already exists', async () => {
    const db = makeAssignmentDb({ existingAssignment: { id: 'assign-old' } });

    const res = await createAssignment(db, {
      accountId: 'acct-1', campaignId: 'camp-1', variantId: 'var-1', contactId: 'c1',
    });
    expect(res).toEqual({ id: 'assign-old', created: false });
  });

  it('throws a 404 CampaignError when the campaign belongs to a different account', async () => {
    const db = makeAssignmentDb({ campaignOwned: false });

    await expect(
      createAssignment(db, {
        accountId: 'acct-other', campaignId: 'camp-1', variantId: 'var-1', contactId: 'c1',
      })
    ).rejects.toMatchObject({ name: 'CampaignError', status: 404 });
  });
});
