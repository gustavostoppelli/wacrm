'use client';

import { useEffect, useState } from 'react';

interface Campaign {
  id: string;
  name: string;
  created_at: string;
}

interface VariantStatRow {
  variantId: string;
  variantName: string;
  totalAssigned: number;
  totalResponded: number;
  responseRate: number;
  avgDaysPerStage: Record<string, number>;
}

export function CampaignsPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [stats, setStats] = useState<VariantStatRow[]>([]);

  useEffect(() => {
    fetch('/api/campaigns')
      .then((r) => r.json())
      .then((d) => setCampaigns(d.campaigns ?? []));
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/campaigns/${selected}/stats`)
      .then((r) => r.json())
      .then((d) => setStats(d.stats ?? []));
  }, [selected]);

  return (
    <div className="space-y-4">
      <select
        className="rounded border px-3 py-2"
        value={selected ?? ''}
        onChange={(e) => setSelected(e.target.value || null)}
      >
        <option value="">Selecione uma campanha</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {stats.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Variante</th>
              <th>Atribuídos</th>
              <th>Responderam</th>
              <th>Taxa de resposta</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.variantId}>
                <td>{s.variantName}</td>
                <td>{s.totalAssigned}</td>
                <td>{s.totalResponded}</td>
                <td>{(s.responseRate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
