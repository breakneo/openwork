import { randomBytes } from "node:crypto"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { and, eq, gt } from "@openwork-ee/den-db/drizzle"
import {
  SlackAssistantInstallationTable as Installation,
  SlackAssistantOAuthStateTable as State,
  ExternalMcpConnectionTable,
  MemberTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { appLogger } from "../observability/logger.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { paramValidator, jsonValidator, orgMemberRoute, publicRoute, signedWebhookRoute } from "../middleware/index.js"
import {
  idParamSchema,
  ensureOrganizationAdmin,
  ensureOrganizationAdminRole,
  orgAccessFailureStatus,
  type OrgRouteVariables,
} from "../routes/org/shared.js"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { getOpenWorkWebRuntimeAccess } from "../openwork-web-runtime-access.js"
import { organizationHasCapability } from "../organization-capabilities.js"
import { publicRequestUrl } from "../request-url.js"
import { getOrganizationContextForUser } from "../orgs.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import {
  BOT_SCOPES,
  isInvocation,
  scopeKey,
  slackEnvelopeSchema,
  slackManifest,
  verifySlackSignature,
} from "./protocol.js"
import {
  recordSlackFeedback,
  slackAssistantMetrics,
  enqueueSlackEvent,
  getInstallation,
  isSlackConnection,
  slackAssistantEnabledForInstallation,
} from "./repository.js"

const connectionParams = idParamSchema("connectionId", "externalMcpConnection")
const configSchema = z.object({
  enabled: z.boolean(),
  signingSecret: z.string().min(16).max(512).optional(),
  channelIds: z
    .array(z.string().regex(/^[CG][A-Z0-9]+$/))
    .max(100)
    .default([]),
  shadowMode: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(1000).default(100),
})
function publicBase(request: Request) {
  return env.apiPublicUrl ?? publicRequestUrl(request, { trustedOrigins: env.publicUrlTrustedOrigins }).origin
}
const routeDescription = (summary: string, tag = "Authentication") =>
  describeRoute({
    tags: [tag],
    summary,
    responses: {
      200: { description: "Request handled." },
      400: { description: "Invalid request." },
      403: { description: "Access denied." },
    },
  })

export function registerSlackAssistantRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-connections/:connectionId/slack-assistant",
    routeDescription("Read Slack assistant setup"),
    orgMemberRoute(),
    paramValidator(connectionParams),
    async (c) => {
      const org = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace admins can manage the Slack assistant.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      if (!org) return c.json({ error: "forbidden" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection) return c.json({ error: "not_found" }, 404)
      const installation = await getInstallation(connectionId)
      const web = await getOpenWorkWebRuntimeAccess(org.organization.id)
      return c.json({
        enabled: installation?.enabled ?? false,
        installed: Boolean(installation?.botToken),
        teamId: installation?.teamId ?? null,
        rolloutEnabled: organizationHasCapability(org.organization.metadata, "slackAssistant"),
        hasSigningSecret: Boolean(installation?.signingSecret),
        eligible: isSlackConnection(connection),
        webAccess: web.hasAccess,
        channelIds: installation?.channelIds ?? [],
        shadowMode: installation?.shadowMode ?? false,
        dailyLimit: installation?.dailyLimit ?? 100,
        metrics: await slackAssistantMetrics(connectionId),
        manifest: slackManifest(publicBase(c.req.raw), connectionId),
      })
    },
  )
  app.put(
    "/v1/mcp-connections/:connectionId/slack-assistant",
    routeDescription("Configure Slack assistant installation"),
    orgMemberRoute(),
    paramValidator(connectionParams),
    jsonValidator(configSchema),
    async (c) => {
      const admin = ensureOrganizationAdmin(c, "Only workspace admins can configure the Slack assistant.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const org = c.get("organizationContext")
      if (!org || !c.get("session")) return c.json({ error: "browser_session_required" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection || !isSlackConnection(connection))
        return c.json(
          { error: "individual_accounts_required", message: "Choose a Slack connection in Individual accounts mode." },
          400,
        )
      const body = c.req.valid("json")
      if (body.enabled && !organizationHasCapability(org.organization.metadata, "slackAssistant")) {
        return c.json(
          {
            error: "slack_assistant_not_enabled",
            message: "A platform admin must enable Slack Assistant for this workspace in /admin.",
          },
          403,
        )
      }
      if (body.enabled && !(await getOpenWorkWebRuntimeAccess(org.organization.id)).hasAccess)
        return c.json({ error: "openwork_web_access_required" }, 403)
      const previous = await getInstallation(connectionId)
      const signingSecret = body.signingSecret ?? previous?.signingSecret
      if (!signingSecret) return c.json({ error: "signing_secret_required" }, 400)
      const saved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(
            and(
              eq(ExternalMcpConnectionTable.id, connectionId),
              eq(ExternalMcpConnectionTable.organizationId, org.organization.id),
            ),
          )
          .for("update")
        if (!current || !isSlackConnection(current)) return false
        await tx
          .insert(Installation)
          .values({ connectionId, organizationId: org.organization.id, ...body, signingSecret })
          .onDuplicateKeyUpdate({ set: { ...body, signingSecret } })
        return true
      })
      if (!saved) return c.json({ error: "connection_changed" }, 409)
      return c.json({ ok: true })
    },
  )
  app.post(
    "/v1/mcp-connections/:connectionId/slack-assistant/install",
    routeDescription("Start Slack bot installation"),
    orgMemberRoute(),
    paramValidator(connectionParams),
    async (c) => {
      const admin = ensureOrganizationAdmin(c, "Only workspace admins can install the Slack assistant.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const org = c.get("organizationContext")
      if (!org || !c.get("session")) return c.json({ error: "browser_session_required" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection || !isSlackConnection(connection)) return c.json({ error: "individual_accounts_required" }, 400)
      const client = await getOrgOAuthClient(org.organization.id, connectionId)
      if (!client?.clientSecret || !(await getInstallation(connectionId)))
        return c.json(
          {
            error: "setup_required",
            message: "Configure this connector's Slack OAuth client and save its signing secret first.",
          },
          400,
        )
      const nonce = randomBytes(32).toString("base64url")
      await db.insert(State).values({
        id: scopeKey(nonce),
        connectionId,
        memberId: org.currentMember.id,
        expiresAt: new Date(Date.now() + 600_000),
      })
      const url = new URL("https://slack.com/oauth/v2/authorize")
      url.searchParams.set("client_id", client.clientId)
      url.searchParams.set("scope", BOT_SCOPES.join(","))
      url.searchParams.set("state", nonce)
      url.searchParams.set("redirect_uri", `${publicBase(c.req.raw)}/v1/integrations/slack/oauth/callback`)
      return c.json({ url: url.toString() })
    },
  )
  app.get(
    "/v1/integrations/slack/oauth/callback",
    routeDescription("Complete Slack bot installation"),
    publicRoute,
    async (c) => {
      const state = c.req.query("state")
      const code = c.req.query("code")
      if (!state || !code || c.req.query("error")) return c.text("Slack installation was not completed.", 400)
      const transaction = await db.transaction(async (tx) => {
        const row = (
          await tx
            .select()
            .from(State)
            .where(and(eq(State.id, scopeKey(state)), gt(State.expiresAt, new Date())))
            .limit(1)
            .for("update")
        )[0]
        if (row) await tx.delete(State).where(eq(State.id, row.id))
        return row
      })
      if (!transaction) return c.text("This installation link expired. Start again in OpenWork.", 400)
      const installation = await getInstallation(transaction.connectionId)
      const member = (await db.select().from(MemberTable).where(eq(MemberTable.id, transaction.memberId)).limit(1))[0]
      if (!installation || !member?.userId || member.removedAt) return c.text("Access denied.", 403)
      const context = await getOrganizationContextForUser({
        userId: member.userId,
        organizationId: installation.organizationId,
      })
      const admin = ensureOrganizationAdminRole({ get: () => context ?? undefined }, "Access denied.")
      if (!admin.ok) return c.text("Access denied.", 403)
      const connection = await getExternalMcpConnection({
        organizationId: installation.organizationId,
        connectionId: installation.connectionId,
      })
      if (!connection || !isSlackConnection(connection)) return c.text("The connection changed. Start again.", 400)
      const client = await getOrgOAuthClient(installation.organizationId, installation.connectionId)
      if (!client?.clientSecret) return c.text("Slack app setup is incomplete.", 400)
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          redirect_uri: `${publicBase(c.req.raw)}/v1/integrations/slack/oauth/callback`,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      })
      const result = z
        .object({
          ok: z.literal(true),
          app_id: z.string(),
          bot_user_id: z.string(),
          access_token: z.string(),
          team: z.object({ id: z.string() }),
          scope: z.string(),
        })
        .safeParse(await response.json())
      if (!result.success || BOT_SCOPES.some((scope) => !result.data.scope.split(",").includes(scope)))
        return c.text("Slack did not grant the required bot permissions. Check the app manifest and reinstall.", 400)
      const token = result.data
      if (installation.teamId && installation.teamId !== token.team.id)
        return c.text("This connector is already linked to another Slack workspace.", 409)
      const collision = (
        await db
          .select({ id: Installation.connectionId })
          .from(Installation)
          .where(eq(Installation.teamId, token.team.id))
          .limit(1)
      )[0]
      if (collision && collision.id !== installation.connectionId)
        return c.text("This Slack workspace is already connected to OpenWork.", 409)
      await db
        .update(Installation)
        .set({ teamId: token.team.id, appId: token.app_id, botUserId: token.bot_user_id, botToken: token.access_token })
        .where(eq(Installation.connectionId, installation.connectionId))
      return c.redirect(
        new URL(`/dashboard/mcp-connections/${installation.connectionId}`, env.betterAuthUrl).toString(),
      )
    },
  )

  app.post(
    "/v1/integrations/slack/:connectionId/events",
    routeDescription("Receive signed Slack assistant events", "Webhooks"),
    signedWebhookRoute,
    paramValidator(connectionParams),
    bodyLimit({ maxSize: 1_000_000 }),
    async (c) => {
      const startedAt = Date.now()
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const installation = await getInstallation(connectionId)
      if (!installation) return c.json({ ok: false }, 401)
      const raw = await c.req.text()
      if (
        !verifySlackSignature(
          raw,
          c.req.header("x-slack-request-timestamp") ?? "",
          c.req.header("x-slack-signature") ?? "",
          installation.signingSecret,
        )
      )
        return c.json({ ok: false }, 401)
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return c.json({ ok: false }, 400)
      }
      const envelope = slackEnvelopeSchema.safeParse(json)
      if (!envelope.success) return c.json({ ok: false }, 400)
      const value = envelope.data
      if (value.type === "url_verification") return c.json({ challenge: value.challenge })
      if (value.team_id !== installation.teamId || value.api_app_id !== installation.appId)
        return c.json({ ok: false }, 403)
      if (!value.event || !value.event_id) return c.json({ ok: true })
      if (
        !installation.enabled &&
        !["app_uninstalled", "tokens_revoked", "agent_session_stopped"].includes(value.event.type)
      )
        return c.json({ ok: true })
      const event = value.event
      if (isInvocation(event) && !(await slackAssistantEnabledForInstallation(installation)))
        return c.json({ ok: true })
      if (event.bot_id || event.app_id || event.user === installation.botUserId) return c.json({ ok: true })
      if (
        isInvocation(event) ||
        [
          "app_uninstalled",
          "tokens_revoked",
          "agent_session_stopped",
          "app_home_opened",
          "app_context_changed",
          "agent_session_title_changed",
        ].includes(event.type)
      ) {
        if (
          isInvocation(event) &&
          installation.channelIds?.length &&
          event.channel_type !== "im" &&
          !installation.channelIds.includes(event.channel ?? "")
        )
          return c.json({ ok: true })
        const id = await enqueueSlackEvent(installation, value.event_id, event)
        appLogger.info("slack_assistant_event_accepted", { event_id: id, ack_ms: Date.now() - startedAt })
      }
      // Acknowledge only after durable insertion. No provider/runtime calls on ingress.
      return c.json({ ok: true })
    },
  )
  for (const action of ["commands", "interactions"]) {
    app.post(
      `/v1/integrations/slack/:connectionId/${action}`,
      routeDescription(`Receive Slack ${action}`, "Webhooks"),
      signedWebhookRoute,
      paramValidator(connectionParams),
      bodyLimit({ maxSize: 100_000 }),
      async (c) => {
        const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
        const installation = await getInstallation(connectionId)
        const raw = await c.req.text()
        if (
          !installation ||
          !verifySlackSignature(
            raw,
            c.req.header("x-slack-request-timestamp") ?? "",
            c.req.header("x-slack-signature") ?? "",
            installation.signingSecret,
          )
        )
          return c.json({ ok: false }, 401)
        const form = new URLSearchParams(raw)
        if (
          action === "commands" &&
          (form.get("team_id") !== installation.teamId || form.get("api_app_id") !== installation.appId)
        )
          return c.json({ ok: false }, 403)
        if (action === "interactions") {
          let payload: unknown
          try {
            payload = JSON.parse(form.get("payload") ?? "")
          } catch {
            return c.json({ ok: false }, 400)
          }
          const parsed = z
            .object({
              team: z.object({ id: z.string() }),
              user: z.object({ id: z.string() }),
              api_app_id: z.string(),
              actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).optional(),
            })
            .safeParse(payload)
          if (
            !parsed.success ||
            parsed.data.team.id !== installation.teamId ||
            parsed.data.api_app_id !== installation.appId
          )
            return c.json({ ok: false }, 403)
          for (const item of parsed.data.actions ?? [])
            if (
              item.action_id.startsWith("slack_feedback:") &&
              (item.value === "positive" || item.value === "negative")
            ) {
              await recordSlackFeedback(
                installation,
                parsed.data.user.id,
                item.action_id.slice("slack_feedback:".length),
                item.value,
              )
            }
          return c.json({ ok: true })
        }
        return c.json({
          response_type: "ephemeral",
          text: `Connect your own Slack account in OpenWork: <${openworkYourConnectionsUrl(connectionId)}|Connect OpenWork>`,
        })
      },
    )
  }
}
