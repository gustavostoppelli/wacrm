import Link from "next/link";

export type LegalBlock =
  | { type: "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "checklist"; items: string[] };

export interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

interface LegalPageProps {
  title: string;
  updatedAt: string;
  intro: string[];
  sections: LegalSection[];
  otherDocHref: string;
  otherDocLabel: string;
}

// Shared renderer for the two static legal documents (Termos de Uso /
// Política de Privacidade). Both are still drafts pending company data
// (CNPJ, endereço, etc.) — see the checklist block at the end of each
// page — so this stays a plain server component with no CMS/markdown
// dependency until the text is finalized.
export function LegalPage({
  title,
  updatedAt,
  intro,
  sections,
  otherDocHref,
  otherDocLabel,
}: LegalPageProps) {
  return (
    <div className="min-h-screen bg-background px-4 py-12 text-foreground">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Voltar ao FuseHub
          </Link>
          <Link
            href={otherDocHref}
            className="text-sm text-primary hover:text-primary/80"
          >
            {otherDocLabel}
          </Link>
        </div>

        <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Última atualização: {updatedAt}
        </p>

        {intro.length > 0 && (
          <div className="mt-6 space-y-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-400">
            {intro.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}

        <div className="mt-10 space-y-10">
          {sections.map((section, i) => (
            <section key={i}>
              <h2 className="text-lg font-semibold text-foreground">
                {section.heading}
              </h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
                {section.blocks.map((block, j) => {
                  if (block.type === "p") {
                    return <p key={j}>{block.text}</p>;
                  }
                  if (block.type === "list") {
                    return (
                      <ul key={j} className="list-disc space-y-1 pl-5">
                        {block.items.map((item, k) => (
                          <li key={k}>{item}</li>
                        ))}
                      </ul>
                    );
                  }
                  return (
                    <ul key={j} className="space-y-1.5 pl-1">
                      {block.items.map((item, k) => (
                        <li key={k} className="flex gap-2">
                          <span aria-hidden>☐</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
