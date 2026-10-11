// src/lib/campaigns/auto-greeting.ts
// ============================================================
// Detecta mensagem automatica de ausencia do WhatsApp Business (do
// NUMERO DO LEAD, nao da Fuse) -- nunca conta como resposta real.
//
// MESMA lista de frases usada no prompt da IA nativa (ai_configs.
// system_prompt, seção "Mensagem de saudação automática") e no
// detector equivalente do opensquad/skills/sdr-frio (repositorio
// separado, sem código compartilhado) -- manter as 3 em sincronia
// manualmente se a lista mudar.
// ============================================================

const AUTO_GREETING_PHRASES = [
  'seja bem-vindo',
  'nossa equipe',
  'em breve retornaremos',
  'fora do horário de atendimento',
  'mensagem automática',
];

export function isAutoGreeting(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTO_GREETING_PHRASES.some((p) => lower.includes(p));
}
