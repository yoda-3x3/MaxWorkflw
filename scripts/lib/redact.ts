// Scrubs secret values out of any text before it is logged or thrown.
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***')
  }
  return out
}
