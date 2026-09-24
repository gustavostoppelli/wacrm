import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Termos de Uso",
};

const sections: LegalSection[] = [
  {
    heading: "1. Identificação e aceite",
    blocks: [
      {
        type: "p",
        text: 'Estes Termos de Uso ("Termos") regem o uso da plataforma FuseHub ("Plataforma", "Serviço"), de titularidade de FUSE ECOM NEGOCIOS DIGITAIS LTDA, inscrita no CNPJ sob o nº 47.876.980/0001-54, com sede em R. Mistral, nº 332, Edifício The Point, Sala 209A EMX, Bairro Despraiado, CEP 78.048-222, Cuiabá/MT ("Fuse", "nós").',
      },
      {
        type: "p",
        text: 'Ao criar uma conta, contratar um plano ou utilizar a Plataforma, o usuário ("Cliente", "você"), pessoa física ou jurídica, declara ter lido, compreendido e aceitado integralmente estes Termos e a Política de Privacidade. Caso o aceite seja feito em nome de uma empresa, a pessoa que aceita declara ter poderes para vincular essa empresa.',
      },
      {
        type: "p",
        text: "Se você não concorda com qualquer disposição destes Termos, não utilize a Plataforma.",
      },
    ],
  },
  {
    heading: "2. Descrição do serviço",
    blocks: [
      {
        type: "p",
        text: "O FuseHub é uma plataforma de CRM (Customer Relationship Management) multi-tenant, oferecida como Software as a Service (SaaS), que permite a gestão de leads, contatos, conversas (incluindo integração com WhatsApp), funis de venda e automações de marketing.",
      },
      {
        type: "p",
        text: "A Fuse pode alterar, adicionar ou remover funcionalidades a qualquer momento, mediante aviso razoável quando a mudança afetar materialmente o uso já contratado.",
      },
    ],
  },
  {
    heading: "3. Cadastro e conta",
    blocks: [
      {
        type: "list",
        items: [
          "O Cliente deve fornecer informações verdadeiras, completas e atualizadas no cadastro.",
          "O Cliente é responsável por manter a confidencialidade de suas credenciais de acesso e por todas as atividades realizadas em sua conta, incluindo sub-usuários que ele mesmo cadastrar.",
          "É proibido compartilhar credenciais de acesso com terceiros não autorizados ou ceder a conta sem prévia autorização da Fuse.",
          "A Fuse pode recusar, suspender ou encerrar cadastros que contenham informações falsas ou que violem estes Termos.",
        ],
      },
    ],
  },
  {
    heading: "4. Isolamento e propriedade dos dados",
    blocks: [
      {
        type: "p",
        text: 'Ambiente multi-tenant: o FuseHub hospeda múltiplos clientes ("tenants") em uma infraestrutura compartilhada, com isolamento lógico dos dados de cada tenant (segregação por conta, com controle de acesso a nível de linha). A Fuse adota medidas técnicas razoáveis para impedir que um tenant acesse dados de outro.',
      },
      {
        type: "p",
        text: "Propriedade dos dados: todo o conteúdo inserido pelo Cliente na Plataforma (leads, contatos, conversas, arquivos, configurações) é de propriedade do Cliente. A Fuse não utiliza, vende ou compartilha esses dados para finalidades diferentes da prestação do Serviço, salvo autorização expressa do Cliente ou obrigação legal.",
      },
      {
        type: "p",
        text: "Exportação de dados: o Cliente pode solicitar a exportação de seus dados, em formato estruturado e de uso comum (ex.: CSV/JSON), a qualquer momento durante a vigência do contrato e em até 30 dias após o encerramento da conta.",
      },
      {
        type: "p",
        text: "Retenção e exclusão pós-cancelamento: após o cancelamento ou encerramento da conta, os dados do Cliente serão mantidos por até 30 dias para eventual reativação ou exportação, sendo posteriormente excluídos de forma definitiva, salvo obrigação legal de guarda por prazo maior.",
      },
    ],
  },
  {
    heading: "5. Proteção de dados pessoais (LGPD)",
    blocks: [
      {
        type: "p",
        text: "Papéis das partes: para os dados pessoais de terceiros (leads, contatos, clientes finais do Cliente) inseridos na Plataforma, o Cliente atua como Controlador e a Fuse atua como Operadora, nos termos da Lei nº 13.709/2018 (LGPD). Para os dados cadastrais do próprio Cliente (usuário da Plataforma), a Fuse atua como Controladora.",
      },
      {
        type: "p",
        text: "Obrigações da Fuse como Operadora:",
      },
      {
        type: "list",
        items: [
          "Tratar os dados pessoais exclusivamente conforme as instruções documentadas do Cliente e para a finalidade de prestação do Serviço;",
          "Adotar medidas técnicas e administrativas de segurança compatíveis com o mercado (controle de acesso, criptografia em trânsito, backups, isolamento por conta);",
          "Não transferir os dados a terceiros sem base contratual ou legal, exceto aos sub-operadores listados abaixo;",
          "Notificar o Cliente em prazo razoável (até 72 horas da ciência) em caso de incidente de segurança que possa acarretar risco ou dano relevante aos titulares;",
          "Auxiliar o Cliente no atendimento a requisições de titulares de dados (acesso, correção, exclusão, portabilidade) e da ANPD;",
          "Excluir ou devolver os dados pessoais ao final da relação contratual, salvo obrigação legal de retenção.",
        ],
      },
      {
        type: "p",
        text: "Obrigações do Cliente como Controlador: possuir base legal válida para a coleta e o tratamento dos dados pessoais que inserir na Plataforma; obter os consentimentos necessários para contato via WhatsApp/e-mail/SMS com seus leads e clientes; atender requisições de titulares de dados que lhe sejam direcionadas; não inserir dados sensíveis (saúde, biometria etc.) além do estritamente necessário à sua atividade, sob sua exclusiva responsabilidade.",
      },
      {
        type: "p",
        text: "Categorias de sub-operadores utilizados pela Fuse (lista sujeita a atualização, sem necessidade de citar fornecedores específicos, que podem ser substituídos ao longo do tempo):",
      },
      {
        type: "list",
        items: [
          "Provedor de banco de dados, autenticação e armazenamento de arquivos em nuvem;",
          "Provedor de infraestrutura de hospedagem em nuvem, com servidores localizados no Brasil;",
          "Provedor de integração com WhatsApp Business API e plataformas de anúncios;",
          "Provedor de enriquecimento/coleta de leads, quando contratado pelo Cliente;",
          "Processador de pagamentos, para cobrança das assinaturas.",
        ],
      },
      {
        type: "p",
        text: "Transferência internacional: caso dados sejam processados por provedores localizados fora do Brasil, a transferência observará as hipóteses do art. 33 da LGPD, incluindo cláusulas contratuais e garantias adequadas de proteção.",
      },
      {
        type: "p",
        text: "Direitos dos titulares: os titulares de dados podem exercer seus direitos (confirmação, acesso, correção, anonimização, portabilidade, eliminação, informação sobre compartilhamento, revogação de consentimento) mediante contato com o Controlador (o Cliente) ou, para dados cadastrais próprios da conta, diretamente com a Fuse pelo canal indicado na seção 12.",
      },
      {
        type: "p",
        text: "Encarregado (DPO): dúvidas sobre proteção de dados podem ser dirigidas a Gustavo Stoppelli (gustavostoppelli@gmail.com) — encarregado provisório até definição de canal dedicado.",
      },
    ],
  },
  {
    heading: "6. Planos, pagamento e cancelamento",
    blocks: [
      {
        type: "list",
        items: [
          "O Serviço é oferecido mediante assinatura recorrente, nos planos e valores apresentados ao Cliente no momento da contratação.",
          "Os pagamentos são processados por processador de pagamentos terceirizado, com cobrança mensal antecipada, podendo haver planos com cobrança anual conforme proposta comercial.",
          "Em caso de atraso no pagamento superior a 7 dias, a Fuse poderá suspender o acesso à conta, mediante aviso prévio, até a regularização.",
          "O Cliente pode cancelar a assinatura a qualquer momento, com efeitos ao final do período já pago. Não há reembolso de valores pagos referentes ao período em curso, salvo disposição em contrário prevista em proposta comercial específica.",
          "Reajustes de preço serão comunicados com antecedência mínima de 30 dias.",
        ],
      },
    ],
  },
  {
    heading: "7. Uso aceitável",
    blocks: [
      {
        type: "p",
        text: "O Cliente compromete-se a não utilizar a Plataforma para:",
      },
      {
        type: "list",
        items: [
          "Envio de mensagens em massa não solicitadas (spam) ou em desacordo com as políticas do WhatsApp e demais canais integrados;",
          "Armazenar ou distribuir conteúdo ilícito, discriminatório, difamatório ou que viole direitos de terceiros;",
          "Tentar acessar dados de outros tenants, realizar engenharia reversa ou testes de invasão não autorizados, ou sobrecarregar a infraestrutura da Plataforma;",
          "Revender ou sublicenciar o acesso à Plataforma sem autorização prévia por escrito da Fuse.",
        ],
      },
      {
        type: "p",
        text: "O descumprimento pode acarretar suspensão ou encerramento da conta. A Fuse não se responsabiliza por bloqueios ou banimentos aplicados por terceiros (ex.: WhatsApp) em decorrência de uso indevido pelo Cliente.",
      },
    ],
  },
  {
    heading: "8. Integrações com terceiros",
    blocks: [
      {
        type: "p",
        text: "A Plataforma pode se integrar a serviços de terceiros (WhatsApp Business API, ferramentas de enriquecimento de leads, agenda/calendário, gateways de pagamento, entre outros). O funcionamento dessas integrações depende da disponibilidade e das políticas dos respectivos provedores, sobre as quais a Fuse não tem controle. Eventuais instabilidades, mudanças de API ou suspensões de conta por parte desses terceiros não geram responsabilidade da Fuse, que envidará esforços razoáveis para mitigar impactos.",
      },
    ],
  },
  {
    heading: "9. Disponibilidade e suporte",
    blocks: [
      {
        type: "list",
        items: [
          "A Fuse envida esforços comercialmente razoáveis para manter a Plataforma disponível, podendo realizar manutenções programadas com aviso prévio quando possível.",
          "Não há garantia de disponibilidade ininterrupta (100% uptime), salvo Acordo de Nível de Serviço (SLA) específico contratado à parte.",
          "O suporte ao Cliente é prestado pelos canais indicados na seção 12, em horário comercial, salvo disposição diversa em contrato específico.",
        ],
      },
    ],
  },
  {
    heading: "10. Propriedade intelectual",
    blocks: [
      {
        type: "p",
        text: 'O código-fonte, design, marca "FuseHub" e demais elementos da Plataforma são de propriedade exclusiva da Fuse (ou licenciados a ela), sendo vedada sua cópia, engenharia reversa, modificação ou exploração comercial não autorizada. O uso da Plataforma não transfere ao Cliente qualquer direito de propriedade intelectual sobre o software.',
      },
    ],
  },
  {
    heading: "11. Limitação de responsabilidade",
    blocks: [
      {
        type: "p",
        text: "Na máxima extensão permitida pela legislação aplicável, a responsabilidade da Fuse por danos decorrentes do uso da Plataforma fica limitada ao valor pago pelo Cliente nos 12 meses anteriores ao evento. A Fuse não se responsabiliza por danos indiretos, lucros cessantes, perda de dados decorrente de mau uso pelo Cliente, ou por falhas de serviços de terceiros integrados (seção 8).",
      },
      {
        type: "p",
        text: "Nada nesta cláusula exclui responsabilidades que não possam ser limitadas por lei, incluindo obrigações relativas à proteção de dados pessoais nos termos da LGPD.",
      },
    ],
  },
  {
    heading: "12. Contato",
    blocks: [
      {
        type: "list",
        items: [
          "E-mail: gustavostoppelli@gmail.com",
          "Encarregado de Dados (DPO): Gustavo Stoppelli (gustavostoppelli@gmail.com)",
        ],
      },
    ],
  },
  {
    heading: "13. Alterações destes Termos",
    blocks: [
      {
        type: "p",
        text: "A Fuse pode alterar estes Termos a qualquer momento, comunicando o Cliente com antecedência mínima de 15 dias por e-mail ou aviso na Plataforma, quando a alteração for material. O uso continuado após a vigência das mudanças implica aceite.",
      },
    ],
  },
  {
    heading: "14. Rescisão",
    blocks: [
      {
        type: "p",
        text: "A Fuse pode suspender ou encerrar o acesso do Cliente em caso de descumprimento destes Termos, inadimplência não sanada ou por decisão comercial, mediante aviso prévio, salvo em casos de violação grave (ex.: uso ilícito), em que a suspensão pode ser imediata.",
      },
    ],
  },
  {
    heading: "15. Legislação aplicável e foro",
    blocks: [
      {
        type: "p",
        text: "Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o foro da comarca de Cuiabá/MT para dirimir quaisquer controvérsias decorrentes destes Termos, com renúncia a qualquer outro, por mais privilegiado que seja.",
      },
    ],
  },
];

// Publicado sem revisão jurídica formal — decisão consciente do
// responsável pela Fuse (Gustavo), que optou por não bloquear o
// lançamento do fluxo de vendas por isso. Vendors/sub-operadores são
// descritos por categoria (não por nome), justamente para não exigir
// nova revisão sempre que uma ferramenta interna for trocada.
export default function TermosDeUsoPage() {
  return (
    <LegalPage
      title="Termos de Uso — FuseHub"
      updatedAt="24 de setembro de 2026"
      intro={[]}
      sections={sections}
      otherDocHref="/legal/politica-de-privacidade"
      otherDocLabel="Ver Política de Privacidade →"
    />
  );
}
