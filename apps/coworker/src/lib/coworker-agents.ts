export const COWORKER_AGENT_PREFIX = "coworker-owner-";
export const COWORKER_ROLE_SEPARATOR = ":";
export const COORDINATOR_AGENT_ID = "coworker-coordinator";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isCoworkerSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

/** The primary native agent a coworker's sessions are bound to. */
export function coworkerAgent(slug: string): string {
  if (!isCoworkerSlug(slug)) throw new Error("A coworker slug is required for its native agent.");
  return `${COWORKER_AGENT_PREFIX}${slug}`;
}

/** A role variant (`coworker-<slug>:<role>`) of one coworker's agent from a generic role id (`coworker-<role>`). */
export function coworkerRoleAgentId(slug: string, genericRoleId: string): string {
  if (!genericRoleId.startsWith("coworker-")) throw new Error("Unknown native turn role.");
  return `${coworkerAgent(slug)}${COWORKER_ROLE_SEPARATOR}${genericRoleId.slice("coworker-".length)}`;
}

/**
 * The slug an agent id names, or null for the coordinator, the generic
 * build-derived roles and foreign agents. With `genericRoles` the role suffix is
 * also checked against the known set.
 */
export function coworkerAgentOwner(agent: unknown, genericRoles?: Iterable<string>): string | null {
  if (typeof agent !== "string" || !agent.startsWith(COWORKER_AGENT_PREFIX) || agent === COORDINATOR_AGENT_ID) return null;
  const known = genericRoles ? new Set(genericRoles) : null;
  if (known?.has(agent)) return null;
  const [slug, ...rest] = agent.slice(COWORKER_AGENT_PREFIX.length).split(COWORKER_ROLE_SEPARATOR);
  if (!isCoworkerSlug(slug) || rest.length > 1) return null;
  if (rest.length === 1 && known && !known.has(`coworker-${rest[0]}`)) return null;
  return slug;
}

/** The metadata every session the app creates for a coworker carries. */
export function coworkerSessionMetadata(coworker: { slug: string; createdAt?: string }): Record<string, unknown> {
  return { coworker: coworker.slug, ...(coworker.createdAt ? { coworkerCreatedAt: coworker.createdAt } : {}) };
}
