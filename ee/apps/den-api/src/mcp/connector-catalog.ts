import { z } from "zod"
import { EXTERNAL_MCP_PRESETS } from "../capability-sources/external-mcp-presets.js"
import { openworkOrganizationConnectionsUrl } from "./connection-navigation.js"

export const connectorSetupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  serviceUrl: z.string().url().optional(),
  setup: z.enum(["suite", "oauth_client", "api_key", "instant", "oauth"]),
  setupUrl: z.string().url(),
})

export function connectorSetupList(): z.infer<typeof connectorSetupSchema>[] {
  const setupUrl = (id: string) => {
    const url = new URL(openworkOrganizationConnectionsUrl())
    url.searchParams.set("quickAdd", id)
    return url.toString()
  }
  return [
    { id: "google-workspace", name: "Google Workspace", description: "Gmail, Calendar, and Drive with your work account.", setup: "suite", setupUrl: setupUrl("google-workspace") },
    { id: "microsoft-365", name: "Microsoft 365", description: "Outlook, Calendar, and OneDrive with your work account.", setup: "suite", setupUrl: setupUrl("microsoft-365") },
    ...EXTERNAL_MCP_PRESETS.map(preset => ({
      id: preset.presetId,
      name: preset.displayName,
      description: preset.description,
      serviceUrl: preset.url,
      setup: preset.requiresOAuthClient ? "oauth_client" : preset.authType === "apikey" ? "api_key" : preset.authType === "none" ? "instant" : "oauth",
      setupUrl: setupUrl(preset.presetId),
    } satisfies z.infer<typeof connectorSetupSchema>)),
  ]
}
