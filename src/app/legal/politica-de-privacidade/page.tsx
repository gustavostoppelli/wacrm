import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Política de Privacidade",
};

const sections: LegalSection[] = [
  {
    heading: "Quem esta política se aplica",
    blocks: [
      {
        type: "p",
        text: "Esta Política se aplica a dois grupos de titulares de dados pessoais, tratados de formas diferentes: os Clientes da Plataforma (pessoas que criam conta e usam o FuseHub), para os quais a Fuse é Controladora; e os titulares finais (leads, contatos e clientes inseridos no CRM pelos Clientes da Plataforma), para os quais a Fuse é Operadora, atuando sob instrução do Cliente (Controlador). Requisições desses titulares finais devem ser direcionadas ao Cliente que os cadastrou; a Fuse presta suporte técnico quando necessário.",
      },
    ],
  },
  {
    heading: "1. Quem trata os dados",
    blocks: [
      {
        type: "p",
        text: "FUSE ECOM NEGOCIOS DIGITAIS LTDA, CNPJ 47.876.980/0001-54, sede em R. Mistral, nº 332, Edifício The Point, Sala 209A EMX, Bairro Despraiado, CEP 78.048-222, Cuiabá/MT (\"Fuse\"). Encarregado de Dados (DPO): Gustavo Stoppelli — gustavostoppelli@gmail.com.",
      },
    ],
  },
  {
    heading: "2. Dados coletados",
    blocks: [
      {
        type: "p",
        text: "Do Cliente da Plataforma (usuário do CRM): dados cadastrais (nome, e-mail, telefone, empresa, CNPJ/CPF); dados de pagamento (processados por gateway de pagamento terceirizado — a Fuse não armazena dados completos de cartão); dados de uso e navegação (logs de acesso, IP, ações na Plataforma, para segurança e suporte).",
      },
      {
        type: "p",
        text: "Dos titulares finais (inseridos pelo Cliente no CRM): dados que o próprio Cliente cadastra ou importa — nome, telefone, e-mail, histórico de conversas (ex.: WhatsApp), origem do lead, interações com anúncios/formulários. Esses dados são de responsabilidade do Cliente quanto à base legal de coleta.",
      },
    ],
  },
  {
    heading: "3. Finalidade do tratamento",
    blocks: [
      {
        type: "list",
        items: [
          "Viabilizar o funcionamento do CRM (armazenamento, organização de funil, automações, integração com WhatsApp e ferramentas de enriquecimento de leads);",
          "Processar pagamentos e gerenciar assinaturas;",
          "Prestar suporte técnico;",
          "Cumprir obrigações legais e regulatórias;",
          "Prevenir fraude e garantir a segurança da Plataforma;",
          "Comunicação sobre o Serviço (avisos, atualizações, faturas). Comunicações de marketing só são enviadas mediante consentimento prévio, com opção de descadastro a qualquer momento.",
        ],
      },
      {
        type: "p",
        text: "A Fuse não utiliza os dados dos titulares finais (leads/contatos dos Clientes) para treinar modelos, revender, ou qualquer finalidade além da prestação do Serviço ao Cliente que os inseriu.",
      },
    ],
  },
  {
    heading: "4. Base legal",
    blocks: [
      {
        type: "list",
        items: [
          "Execução de contrato (art. 7º, V, LGPD) — para prestação do Serviço ao Cliente da Plataforma;",
          "Cumprimento de obrigação legal/regulatória (art. 7º, II) — dados fiscais, contábeis;",
          "Legítimo interesse (art. 7º, IX) — segurança, prevenção a fraude, melhoria do Serviço;",
          "Consentimento (art. 7º, I) — comunicações de marketing.",
        ],
      },
      {
        type: "p",
        text: "Para os titulares finais, a base legal da coleta original é definida e de responsabilidade do Cliente (Controlador), não da Fuse.",
      },
    ],
  },
  {
    heading: "5. Compartilhamento de dados",
    blocks: [
      {
        type: "list",
        items: [
          "Provedor de banco de dados, autenticação e armazenamento de arquivos em nuvem;",
          "Provedor de infraestrutura de hospedagem em nuvem, com servidores localizados no Brasil;",
          "Provedor de integração com WhatsApp Business API / plataformas de anúncios, quando o Cliente ativa essas integrações;",
          "Provedor de enriquecimento/coleta de leads, quando o Cliente utiliza essas funcionalidades;",
          "Processador de pagamentos, para processamento de cobranças;",
          "Autoridades públicas, mediante ordem judicial ou requisição legal.",
        ],
      },
      {
        type: "p",
        text: "Os fornecedores acima são descritos por categoria, e não por nome, justamente para que a troca de uma ferramenta por outra equivalente não exija nova versão desta Política. A lista de fornecedores específicos em uso pode ser solicitada ao Encarregado de Dados (seção 11).",
      },
      { type: "p", text: "A Fuse não vende dados pessoais a terceiros." },
    ],
  },
  {
    heading: "6. Transferência internacional",
    blocks: [
      {
        type: "p",
        text: "Alguns sub-operadores (por exemplo, provedores de integração com plataformas de anúncios/mensageria) podem processar dados fora do Brasil. Nesses casos, a Fuse busca garantir salvaguardas adequadas nos termos do art. 33 da LGPD (cláusulas contratuais padrão, adequação do país de destino, ou consentimento específico quando aplicável).",
      },
    ],
  },
  {
    heading: "7. Armazenamento e segurança",
    blocks: [
      {
        type: "list",
        items: [
          "Isolamento lógico dos dados por tenant (segregação por conta, controle de acesso a nível de linha);",
          "Controle de acesso por autenticação e permissões;",
          "Backups periódicos;",
          "Dados de tenants (leads/conversas de Clientes) nunca são versionados em repositórios de código nem expostos publicamente;",
          "Toda comunicação entre o navegador do usuário e a Plataforma é criptografada em trânsito via HTTPS/TLS;",
          "Credenciais sensíveis de integração (ex.: tokens de conexão com WhatsApp) são criptografadas em repouso no banco de dados;",
          "O banco de dados subjacente também aplica criptografia em repouso por padrão.",
        ],
      },
    ],
  },
  {
    heading: "8. Retenção e exclusão",
    blocks: [
      {
        type: "list",
        items: [
          "Dados são mantidos enquanto a conta estiver ativa;",
          "Após cancelamento, retidos por até 30 dias para exportação/reativação, depois excluídos definitivamente, salvo obrigação legal de guarda (ex.: dados fiscais, prazo de 5 anos);",
          "O titular final pode solicitar exclusão antecipada de seus dados diretamente ao Cliente (Controlador) que os cadastrou.",
        ],
      },
    ],
  },
  {
    heading: "9. Direitos dos titulares",
    blocks: [
      {
        type: "p",
        text: "Nos termos do art. 18 da LGPD, o titular pode solicitar: confirmação da existência de tratamento, acesso, correção, anonimização, bloqueio, eliminação, portabilidade, informação sobre compartilhamento, revogação do consentimento e revisão de decisões automatizadas.",
      },
      {
        type: "list",
        items: [
          "Cliente da Plataforma: exerce diretamente pelo canal da seção 11.",
          "Titular final (lead/contato): deve procurar o Cliente que o cadastrou (Controlador). A Fuse pode ser acionada como suporte técnico para viabilizar o atendimento quando o Cliente solicitar.",
        ],
      },
    ],
  },
  {
    heading: "10. Cookies e tecnologias de rastreamento",
    blocks: [
      {
        type: "p",
        text: "A Plataforma utiliza apenas cookies essenciais, necessários para manter a sessão de login e o funcionamento básico do sistema. Não são utilizados cookies de rastreamento, analytics ou publicidade.",
      },
    ],
  },
  {
    heading: "11. Contato",
    blocks: [
      {
        type: "list",
        items: [
          "Encarregado de Dados (DPO): Gustavo Stoppelli",
          "E-mail: gustavostoppelli@gmail.com",
        ],
      },
    ],
  },
  {
    heading: "12. Alterações desta Política",
    blocks: [
      {
        type: "p",
        text: "Esta Política pode ser atualizada periodicamente. Alterações materiais serão comunicadas com antecedência mínima de 15 dias por e-mail ou aviso na Plataforma.",
      },
    ],
  },
];

// Publicado sem revisão jurídica formal — decisão consciente do
// responsável pela Fuse (Gustavo), que optou por não bloquear o
// lançamento do fluxo de vendas por isso. Fornecedores/sub-operadores
// são descritos por categoria (não por nome), justamente para não
// exigir nova revisão sempre que uma ferramenta interna for trocada.
export default function PoliticaDePrivacidadePage() {
  return (
    <LegalPage
      title="Política de Privacidade — FuseHub"
      updatedAt="24 de setembro de 2026"
      intro={[]}
      sections={sections}
      otherDocHref="/legal/termos-de-uso"
      otherDocLabel="Ver Termos de Uso →"
    />
  );
}
