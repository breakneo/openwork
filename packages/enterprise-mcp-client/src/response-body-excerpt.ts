const SENSITIVE_RESPONSE_KEY = /token|secret|password|assertion|code|key|authorization/i
const QUOTED_PAIR = /((["'])([\w.-]+)\2\s*:\s*)("(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|[^,\s"'{}\[\]]+)/g
const TEXT_PAIR = /\b([\w.-]+)(\s*[=:]\s*)("(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|[^&,;\s"'<>(){}\[\]]+|\[redacted(?::[a-z-]+)?\])/g
const REDACTION_MARKER = /^["']?\[redacted(?::[a-z-]+)?\]["']?$/
const JWT_CREDENTIAL = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const SLACK_CREDENTIAL = /\bxox[a-z]-[A-Za-z0-9-]+|\bxoxe(?:-\d)?-[A-Za-z0-9-]+/gi
const BEARER_CREDENTIAL = /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi
const GITHUB_CREDENTIAL = /\bgh[pousr]_[A-Za-z0-9]{20,}/gi
const OPENWORK_CREDENTIAL = /\bow[thc]_[A-Za-z0-9_-]+\b/g
const LONG_OPAQUE_CREDENTIAL = /[A-Za-z0-9_~+/=-]{40,}/g

type CredentialPolicy = "conservative" | "selective"

export function isSensitiveCredentialKey(key: string): boolean {
  const normalized = key.trim().replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.\s-]+/g, "_").toLowerCase()
  return /(?:^|_)(?:token|grant|secret|password|passwd|authorization|cookie)$/.test(normalized)
    || /(?:^|_)(?:api|access|private|signing|encryption)_key(?:_id)?$/.test(normalized)
    || /(?:^|_)(?:authorization|auth)_code$/.test(normalized)
    || /^(?:key|code|(?:api|access|refresh|session|client)(?:key|token|secret))$/.test(normalized)
}

function credentialKey(key: string, policy: CredentialPolicy): boolean {
  return isSensitiveCredentialKey(key) || (policy === "conservative" && SENSITIVE_RESPONSE_KEY.test(key))
}

function redactCredentialText(text: string, policy: CredentialPolicy): string {
  const redacted = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, (url) => {
      const start = url.indexOf("//") + 2
      const end = url.slice(start).search(/[/?#]/)
      const authorityEnd = end === -1 ? url.length : start + end
      const safe = url.slice(0, start) + url.slice(start, authorityEnd).replace(/^.*(@|%40)/i, "") + url.slice(authorityEnd)
      const cut = safe.search(/[?#]/)
      return cut === -1 ? safe : safe.slice(0, cut) + (/(:\d+){1,2}$/.exec(safe)?.[0] ?? "")
    })
    .replace(JWT_CREDENTIAL, "[redacted]")
    .replace(SLACK_CREDENTIAL, "[redacted]")
    .replace(BEARER_CREDENTIAL, "$1[redacted]")
    .replace(GITHUB_CREDENTIAL, "[redacted]")
    .replace(OPENWORK_CREDENTIAL, "[redacted]")
    .replace(QUOTED_PAIR, (assignment: string, prefix: string, _quote: string, key: string, value: string) =>
      !credentialKey(key, policy) ? prefix + redactCredentialText(value, policy)
        : REDACTION_MARKER.test(value) ? assignment : `${prefix}"[redacted]"`)
    .replace(TEXT_PAIR, (assignment: string, key: string, separator: string, value: string) =>
      !credentialKey(key, policy) ? key + separator + redactCredentialText(value, policy)
        : REDACTION_MARKER.test(value) ? assignment : `${key}${separator}[redacted]`)
  return policy === "conservative" ? redacted.replace(LONG_OPAQUE_CREDENTIAL, "[redacted]") : redacted
}

export function redactSensitiveText(text: string): string {
  return redactCredentialText(text, "selective")
}

export const ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function redactedSensitiveResponseString(value: string): string {
  return redactCredentialText(value, "conservative")
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue)
  if (typeof value === "string") return redactedSensitiveResponseString(value)
  if (!isRecord(value)) return value

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    credentialKey(key, "conservative") ? "[redacted]" : redactJsonValue(entry),
  ]))
}

export function redactedResponseBodyExcerpt(text: string, limit = ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS): string {
  let redacted = redactedSensitiveResponseString(text)
  try {
    const parsed: unknown = JSON.parse(text)
    const serialized = JSON.stringify(redactJsonValue(parsed))
    if (serialized !== undefined) redacted = serialized
  } catch {
    // A bounded excerpt may end mid-JSON. The conservative regex above still
    // removes values whose sensitive key is visible in the excerpt.
  }
  return redacted.slice(0, limit)
}

async function responseTextExcerpt(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (text.length < limit) {
      const next = await reader.read()
      if (next.done) {
        text += decoder.decode()
        return text.slice(0, limit)
      }
      text += decoder.decode(next.value, { stream: true })
      if (text.length >= limit) {
        void reader.cancel().catch(() => undefined)
        return text.slice(0, limit)
      }
    }
    return text.slice(0, limit)
  } catch {
    return null
  }
}

export async function boundedRedactedResponseBodyExcerpt(
  response: Response,
  limit = ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS,
): Promise<string | undefined> {
  try {
    const text = await responseTextExcerpt(response.clone(), limit)
    return text === null ? undefined : redactedResponseBodyExcerpt(text, limit)
  } catch {
    return undefined
  }
}
