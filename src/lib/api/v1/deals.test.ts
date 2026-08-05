import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { serializeDeal, resolveSource, resolvePipelineAndStage, DealError } from './deals';

describe('serializeDeal', () => {
  it('flattens a deal row and nulls missing optional fields', () => {
    const row = {
      id: 'd1',
      title: 'Acme deal',
      value: '1500',
      currency: 'USD',
      source: 'Apify',
      notes: null,
      status: 'open',
      pipeline_id: 'p1',
      stage_id: 's1',
      contact_id: 'c1',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(serializeDeal(row)).toEqual({
      id: 'd1',
      title: 'Acme deal',
      value: 1500,
      currency: 'USD',
      source: 'Apify',
      notes: null,
      status: 'open',
      pipeline_id: 'p1',
      stage_id: 's1',
      contact_id: 'c1',
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('defaults value to 0 when missing', () => {
    const row = {
      id: 'd2',
      title: 'No value',
      pipeline_id: 'p1',
      stage_id: 's1',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(serializeDeal(row).value).toBe(0);
  });
});

describe('resolveSource', () => {
  it('returns null for omitted, null, or empty-string input', () => {
    expect(resolveSource(undefined)).toBeNull();
    expect(resolveSource(null)).toBeNull();
    expect(resolveSource('')).toBeNull();
  });

  it('passes through a known source value', () => {
    expect(resolveSource('Apify')).toBe('Apify');
  });

  it('rejects an unknown value with a 400 DealError', () => {
    expect(() => resolveSource('Cold Call')).toThrow(DealError);
    try {
      resolveSource('Cold Call');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DealError);
      expect((err as DealError).status).toBe(400);
    }
  });
});

describe('resolvePipelineAndStage', () => {
  // Minimal fake of the chainable Supabase query builder — enough
  // surface for resolvePipelineAndStage's two queries, nothing more.
  function fakeDb(pipelineRows: unknown[], stageRows: unknown[]) {
    let call = 0;
    const chain = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      builder.select = self;
      builder.eq = self;
      builder.ilike = self;
      builder.order = self;
      builder.limit = () => Promise.resolve({ data: rows, error: null });
      return builder;
    };
    return {
      from: () => {
        call += 1;
        return chain(call === 1 ? pipelineRows : stageRows);
      },
    } as unknown as SupabaseClient;
  }

  it('resolves the named pipeline and stage', async () => {
    const db = fakeDb(
      [{ id: 'p1', name: 'Sales Pipeline' }],
      [{ id: 's1', name: 'Novo Lead' }]
    );
    await expect(
      resolvePipelineAndStage(db, 'acc', 'Sales Pipeline', 'Novo Lead')
    ).resolves.toEqual({ pipelineId: 'p1', stageId: 's1' });
  });

  it('throws a 400 DealError when no pipeline matches', async () => {
    const db = fakeDb([], []);
    await expect(
      resolvePipelineAndStage(db, 'acc', 'Ghost Pipeline', undefined)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws a 400 DealError when the pipeline has no stages', async () => {
    const db = fakeDb([{ id: 'p1', name: 'Sales Pipeline' }], []);
    await expect(
      resolvePipelineAndStage(db, 'acc', undefined, undefined)
    ).rejects.toBeInstanceOf(DealError);
  });
});
