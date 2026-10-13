import { describe, it, expect } from 'vitest';
import { computeSdrIaMetrics } from './metrics';

/**
 * Generic chainable, awaitable fake query builder: every method
 * (`select`/`eq`/`in`/`gte`) returns `this` and records the call;
 * the chain resolves (via `then`) using `resolve(table, calls)`,
 * which inspects the recorded filter calls to decide which fixture
 * to return -- close enough to the real supabase-js builder for
 * these tests without needing a real client.
 */
function makeChainableDb(resolve: (table: string, calls: Array<{ method: string; args: unknown[] }>) => { data: unknown[] | null }) {
  function chain(table: string, calls: Array<{ method: string; args: unknown[] }>): PromiseLike<{ data: unknown[] | null; error: null }> & Record<string, (...args: unknown[]) => unknown> {
    const self: Record<string, unknown> = {
      select: (...args: unknown[]) => chain(table, [...calls, { method: 'select', args }]),
      eq: (...args: unknown[]) => chain(table, [...calls, { method: 'eq', args }]),
      in: (...args: unknown[]) => chain(table, [...calls, { method: 'in', args }]),
      gte: (...args: unknown[]) => chain(table, [...calls, { method: 'gte', args }]),
      then: (onFulfilled: (v: { data: unknown[] | null; error: null }) => unknown) =>
        Promise.resolve({ ...resolve(table, calls), error: null }).then(onFulfilled),
    };
    return self as never;
  }
  return {
    from: (table: string) => chain(table, []),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function hasEq(calls: Array<{ method: string; args: unknown[] }>, col: string, value: unknown): boolean {
  return calls.some((c) => c.method === 'eq' && c.args[0] === col && c.args[1] === value);
}
function hasGte(calls: Array<{ method: string; args: unknown[] }>): boolean {
  return calls.some((c) => c.method === 'gte');
}

const NOW = new Date('2026-10-13T12:00:00.000Z');

describe('computeSdrIaMetrics', () => {
  it('returns an all-zero series when the sdr-frio tags do not exist yet for this account', async () => {
    const db = makeChainableDb(() => ({ data: [] }));
    const result = await computeSdrIaMetrics(db, 'acct-1', 3, NOW);
    expect(result.days).toHaveLength(3);
    expect(result.days.every((d) => d.contacted === 0)).toBe(true);
    expect(result.totals).toEqual({ contacted: 0, responded: 0, meetingsScheduled: 0, responseRate: 0 });
  });

  it('counts a contacted contact on the day tentativa_1 was tagged', async () => {
    const db = makeChainableDb((table, calls) => {
      if (table === 'tags') return { data: [{ id: 'tag-tentativa1', name: 'sdr_frio_tentativa_1' }] };
      if (table === 'contact_tags') {
        if (hasGte(calls)) return { data: [{ contact_id: 'c1', created_at: '2026-10-13T09:00:00.000Z' }] };
        return { data: [{ contact_id: 'c1' }] }; // "ever tagged" lookup, no date filter
      }
      return { data: [] };
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 3, NOW);
    const today = result.days.find((d) => d.date === '2026-10-13');
    expect(today?.contacted).toBe(1);
    expect(result.totals.contacted).toBe(1);
    expect(result.totals.responseRate).toBe(0);
  });

  it('counts a real reply bucketed by the day sdr_frio_respondeu was tagged', async () => {
    const db = makeChainableDb((table, calls) => {
      if (table === 'tags')
        return {
          data: [
            { id: 'tag-tentativa1', name: 'sdr_frio_tentativa_1' },
            { id: 'tag-respondeu', name: 'sdr_frio_respondeu' },
          ],
        };
      if (table === 'contact_tags') {
        if (hasEq(calls, 'tag_id', 'tag-respondeu')) {
          if (hasGte(calls)) return { data: [{ contact_id: 'c1', created_at: '2026-10-12T15:00:00.000Z' }] };
          return { data: [] };
        }
        if (hasEq(calls, 'tag_id', 'tag-tentativa1')) {
          if (hasGte(calls)) return { data: [{ contact_id: 'c1', created_at: '2026-10-11T09:00:00.000Z' }] };
          return { data: [{ contact_id: 'c1' }] };
        }
      }
      return { data: [] };
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 3, NOW);
    const day11 = result.days.find((d) => d.date === '2026-10-11');
    const day12 = result.days.find((d) => d.date === '2026-10-12');
    expect(day11?.contacted).toBe(1);
    expect(day12?.responded).toBe(1);
    expect(result.totals.contacted).toBe(1);
    expect(result.totals.responded).toBe(1);
    expect(result.totals.responseRate).toBe(1);
  });

  it('counts a meeting scheduled when an sdr-frio contact-linked deal entered a meeting_scheduled stage', async () => {
    const db = makeChainableDb((table, calls) => {
      if (table === 'tags') return { data: [{ id: 'tag-tentativa1', name: 'sdr_frio_tentativa_1' }] };
      if (table === 'contact_tags') {
        if (hasGte(calls)) return { data: [] };
        return { data: [{ contact_id: 'c1' }] };
      }
      if (table === 'pipeline_stages') return { data: [{ id: 'stage-meeting', pipeline_id: 'pipe-1' }] };
      if (table === 'deals') return { data: [{ id: 'deal-1' }] };
      if (table === 'deal_stage_history') return { data: [{ entered_at: '2026-10-13T10:00:00.000Z' }] };
      return { data: [] };
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 3, NOW);
    expect(result.totals.meetingsScheduled).toBe(1);
    const today = result.days.find((d) => d.date === '2026-10-13');
    expect(today?.meetingsScheduled).toBe(1);
  });

  it('never looks up deals/meetings when no contact has ever been tagged tentativa_1', async () => {
    const calledTables: string[] = [];
    const db = makeChainableDb((table) => {
      calledTables.push(table);
      if (table === 'tags') return { data: [{ id: 'tag-tentativa1', name: 'sdr_frio_tentativa_1' }] };
      if (table === 'contact_tags') return { data: [] }; // nobody ever tagged
      return { data: [] };
    });
    await computeSdrIaMetrics(db, 'acct-1', 3, NOW);
    expect(calledTables).not.toContain('deals');
    expect(calledTables).not.toContain('pipeline_stages');
    expect(calledTables).not.toContain('deal_stage_history');
  });
});
