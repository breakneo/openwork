export class GatewayUsageError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message)
  }
}

export function isGatewayUsageDeadlock(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) return false
    if ("code" in current && current.code === "ER_LOCK_DEADLOCK") return true
    if ("errno" in current && current.errno === 1213) return true
    current = "cause" in current ? current.cause : null
  }
  return false
}
