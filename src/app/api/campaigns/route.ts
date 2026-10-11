import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

// Rota interna do dashboard (nao /v1) -- lista as campanhas da conta
// logada pra alimentar o seletor da aba "Campanhas" em Agentes de IA.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, name, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: 'Failed to list campaigns' }, { status: 500 });
    return NextResponse.json({ campaigns: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
