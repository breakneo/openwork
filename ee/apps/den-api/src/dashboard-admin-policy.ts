import { compareStableVersions } from "./desktop-releases.js"
import { env } from "./env.js"
import { MIN_SUPPORTED_DESKTOP_VERSION } from "./generated/desktop-versions.js"

export type DashboardAdminPolicyInput = {
  /** First desktop release whose dashboard controls follow the member's role; unset leaves the policy off. */
  fromDesktopVersion: string | null
  /** Oldest desktop release this Den still serves. */
  minSupportedDesktopVersion: string
}

/**
 * Administrator-only app management is enforced only when every desktop build
 * this Den still supports already carries the matching controls. A deployment
 * names the first compatible release; until Den's own support floor reaches it,
 * a published client that still offers app management to Workflow managers can
 * never receive the stricter 403 responses, whatever an operator sets.
 */
export function dashboardAdminOnlyEnforcedFor(input: DashboardAdminPolicyInput) {
  if (!input.fromDesktopVersion) return false
  return compareStableVersions(input.minSupportedDesktopVersion, input.fromDesktopVersion) >= 0
}

export function dashboardAdminOnlyEnforced() {
  return dashboardAdminOnlyEnforcedFor({
    fromDesktopVersion: env.dashboardAdminOnlyFromDesktopVersion,
    minSupportedDesktopVersion: MIN_SUPPORTED_DESKTOP_VERSION,
  })
}
