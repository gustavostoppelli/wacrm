/**
 * A WhatsApp profile name often arrives as "Clínica X | Secretária" or
 * spans two lines ("Elóvia clínic\nELÓVIA CLINIC RECEPÇÃO"). For a
 * greeting ("Oi, <name>!") keep only the first line and drop anything
 * after a " | " or " - " separator.
 */
export function displayNameFor(name: string | null | undefined): string {
  const first = String(name ?? '').split(/\r?\n/)[0] ?? ''
  return first.split(/\s+[|\-–—]\s+/)[0].trim()
}
