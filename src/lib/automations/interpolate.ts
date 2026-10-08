/**
 * Fill `{{ vars.x }}` / `{{ message.text }}` placeholders. An unknown key
 * renders as empty. Also tolerates the typo of a missing brace on one side
 * (`{vars.x}}`, `{{vars.x}`, `{vars.x}`) for the two known namespaces, so a
 * mistyped template never sends raw braces to a customer. Other single-brace
 * text (e.g. `{foo}`) is left untouched.
 *
 * Pure and dependency-free so both the automation engine and SDR IA can use
 * the same placeholder syntax.
 */
export function interpolateText(
  s: string,
  context: { message_text?: string; vars?: Record<string, unknown> } | undefined,
): string {
  return s.replace(
    /\{\{\s*([\w.]+)\s*\}\}|\{{1,2}\s*((?:vars|message)\.\w+)\s*\}{1,2}/g,
    (_, strict, tolerant) => {
      const [ns, prop] = String(strict ?? tolerant).split('.')
      if (ns === 'message' && prop === 'text') return String(context?.message_text ?? '')
      if (ns === 'vars' && prop) return String(context?.vars?.[prop] ?? '')
      return ''
    },
  )
}
