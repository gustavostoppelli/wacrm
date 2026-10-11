// src/lib/campaigns/auto-greeting.test.ts
import { describe, expect, it } from 'vitest';
import { isAutoGreeting } from './auto-greeting';

describe('isAutoGreeting', () => {
  it('recognizes common WhatsApp Business away-message phrasings', () => {
    expect(isAutoGreeting('Seja bem-vindo(a) ao consultório da Dra. Ana. Em breve retornaremos.')).toBe(true);
    expect(isAutoGreeting('No momento estamos fora do horário de atendimento.')).toBe(true);
    expect(isAutoGreeting('Nossa equipe já vai te atender.')).toBe(true);
  });

  it('does not flag a real human reply', () => {
    expect(isAutoGreeting('Oi, pode ser sim, me conta mais')).toBe(false);
    expect(isAutoGreeting('Quem é vc?')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAutoGreeting('SEJA BEM-VINDO AO NOSSO CONSULTÓRIO')).toBe(true);
  });
});
