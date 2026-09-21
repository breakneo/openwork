import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  DEPLOYMENT_CLIENT_ID,
  OAUTH_APP_PRESET_ID,
  PRE_REGISTERED_PRESET_ID,
  connectorQuickAddPresetAuth,
} from "../worlds/connector-quick-add.ts";

// A provider that registers OpenWork by hand hands back one client id for the
// whole deployment. The admin adding that provider should get plain OAuth
// sign-in, not a form asking for credentials the deployment already holds;
// a provider the deployment holds nothing for still asks. Choosing the API-key
// alternative keeps its key field, and a custom server is still classified by
// the live probe.
const test = spec.world(connectorQuickAddPresetAuth, { timeout: 600_000 });

test("an admin adds a provider whose OAuth client OpenWork already holds without being asked for an OAuth app, while other providers still are", async ({ world, user, probe, step, evidence }) => {
  // The connections page behind the dialog also mentions API keys, so every
  // field claim reads the dialog itself rather than the whole page.
  const DIALOG = '[data-testid="add-mcp-connection-dialog"]';
  const dialog = async () => {
    const [root, keyField, clientIdField, alert, enabledButtons] = await Promise.all([
      probe.dom(DIALOG),
      probe.dom(`${DIALOG} input[name="mcp-api-key"]`),
      probe.dom(`${DIALOG} input[name="mcp-oauth-client-id"]`),
      probe.dom(`${DIALOG} [role="alert"]`),
      probe.dom(`${DIALOG} button:not([disabled])`),
    ]);
    const text = root.elements[0]?.text;
    if (text === undefined) return null;
    return {
      text,
      alert: alert.elements.length > 0,
      keyField: keyField.elements.length > 0,
      clientIdField: clientIdField.elements.length > 0,
      // The form heading and the opt-in link both mention an OAuth app; the
      // client ID field tells the form apart, the link only shows without it.
      oauthAppLink: text.includes("Use a pre-registered OAuth app instead"),
      additionalSetup: text.includes("needs additional setup"),
      credentialMode: text.includes("Whose account does the AI use?"),
      addEnabled: enabledButtons.elements.some(button => button.text === "Add connection"),
    };
  };
  const openQuickAdd = async (presetId: string, presetName: string) => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?quickAdd=${presetId}`);
    await user.see({ testId: "add-mcp-connection-dialog" }, { timeoutMs: 90_000 });
    await user.see({ text: `Add ${presetName}` });
  };
  const closeDialog = async () => {
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ testId: "add-mcp-connection-dialog" });
  };

  // Den's own discovery must still see a provider that refuses automatic
  // registration; otherwise nothing below depends on the deployment client.
  expect(world.discovered).toEqual({ kind: "oauth", registration: "pre_registered" });

  await step(`before: a provider OpenWork holds no client for still asks the admin for an OAuth app`, async () => {
    await openQuickAdd(OAUTH_APP_PRESET_ID, world.oauthAppPresetName);
    const state = await dialog();
    if (!state) throw new Error("The quick-add dialog disappeared.");
    const asksForApp = state.clientIdField && !state.oauthAppLink;
    expect(asksForApp, JSON.stringify({ clientIdField: state.clientIdField, oauthAppLink: state.oauthAppLink })).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      `Adding ${world.oauthAppPresetName} still shows the OAuth app form with a client ID field`,
      `quickAdd=${OAUTH_APP_PRESET_ID}: OAuth app section and client ID field present; the deployment supplies no client for this server`,
      asksForApp,
    );
    await closeDialog();
  });

  await step(`after: ${world.presetName} offers plain OAuth sign-in with the client OpenWork already holds`, async () => {
    await openQuickAdd(PRE_REGISTERED_PRESET_ID, world.presetName);
    // Discovery must finish (the submit button only enables on a ready probe)
    // before the claim means anything: an unfinished probe never flips the form.
    const state = await probe.eventually(dialog, {
      within: 60_000,
      label: "requirements discovery finished for the quick add",
      until: current => current?.addEnabled === true,
    });
    if (!state) throw new Error("The quick-add dialog disappeared.");
    const plainOAuth = !state.alert && !state.additionalSetup && !state.keyField && !state.clientIdField && state.oauthAppLink && state.credentialMode;
    expect(plainOAuth, JSON.stringify({
      alert: state.alert,
      additionalSetup: state.additionalSetup,
      keyField: state.keyField,
      clientIdField: state.clientIdField,
      oauthAppLink: state.oauthAppLink,
      credentialMode: state.credentialMode,
    })).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      `Adding ${world.presetName} asks whose account to use and nothing else`,
      `Den discovery for ${world.presetUrl}: kind=${world.discovered.kind}, registration=${world.discovered.registration}. quickAdd=${PRE_REGISTERED_PRESET_ID}: Add connection enabled with no setup warning, no API key field, and no OAuth app form (only the optional link to use one)`,
      plainOAuth,
    );
  });

  await step(`the admin adds ${world.presetName} and the connection already carries the deployment's client`, async () => {
    await user.click({ role: "button", label: "Add connection" });
    // The dialog closes once Den has saved the connection; only then does the
    // configured list carry the row.
    await probe.eventually(dialog, {
      within: 60_000,
      label: "the add dialog closed after saving",
      until: current => current === null,
    });
    await user.notSee({ testId: "add-mcp-connection-dialog" });
    await user.see({ text: "Configured (1)" }, { timeoutMs: 30_000 });
    const listed = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(listed.response.ok).toBe(true);
    const connections = typeof listed.body === "object" && listed.body !== null && "connections" in listed.body && Array.isArray(listed.body.connections)
      ? listed.body.connections
      : [];
    const created = connections.find((entry): entry is Record<string, unknown> => (
      typeof entry === "object" && entry !== null && "url" in entry && entry.url === world.presetUrl
    ));
    if (!created) throw new Error(`No ${world.presetName} connection was created.`);
    const carriesClient = created.oauthClientId === DEPLOYMENT_CLIENT_ID
      && created.oauthClientConfigured === true
      && created.oauthClientRequired === false
      && created.oauthRegistrationSource === "pre-registered";
    expect(carriesClient, JSON.stringify({
      oauthClientId: created.oauthClientId,
      oauthClientConfigured: created.oauthClientConfigured,
      oauthClientRequired: created.oauthClientRequired,
      oauthRegistrationSource: created.oauthRegistrationSource,
    })).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      `The new ${world.presetName} connection is ready for members to sign in with the deployment's client`,
      `Manageable connection for ${world.presetUrl}: oauthClientId=${String(created.oauthClientId)}, registration=${String(created.oauthRegistrationSource)}, no admin setup outstanding`,
      carriesClient,
    );
  });

  await step(`choosing the API-key alternative for ${world.presetName} still asks for the org key`, async () => {
    await openQuickAdd(PRE_REGISTERED_PRESET_ID, world.presetName);
    await user.click({ role: "button", label: "API key" });
    await user.type({ placeholder: "sk-..." }, "synthetic-org-api-key");
    const state = await probe.eventually(dialog, {
      within: 60_000,
      label: "requirements discovery finished for the API-key alternative",
      until: current => current?.addEnabled === true,
    });
    if (!state) throw new Error("The quick-add dialog disappeared.");
    const keyOnly = !state.alert && state.keyField && !state.clientIdField && !state.oauthAppLink && !state.credentialMode;
    expect(keyOnly, JSON.stringify({ alert: state.alert, keyField: state.keyField, clientIdField: state.clientIdField, oauthAppLink: state.oauthAppLink, credentialMode: state.credentialMode })).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      `The API-key alternative asks for the org key although Den's discovery classified the server as OAuth`,
      `quickAdd=${PRE_REGISTERED_PRESET_ID} with API key chosen: key field present, no OAuth app, client ID, or credential-mode fields`,
      keyOnly,
    );
    await closeDialog();
  });

  await step("a custom OAuth server OpenWork holds no client for is still classified by Den's live probe", async () => {
    // Without a curated preset only the probe can decide the form: the
    // synthetic OAuth-only server has no deployment client and no preset.
    await user.click({ role: "button", label: "Advanced setup" });
    await user.see({ testId: "add-mcp-connection-dialog" });
    await user.see({ text: "Add a custom MCP server" });
    await user.type({ placeholder: "https://mcp.example.com/mcp" }, world.oauthOnlyServerUrl);
    const custom = await probe.eventually(dialog, {
      within: 60_000,
      label: "requirements discovery finished for the custom server",
      // The custom form has no name yet, so the submit button stays disabled;
      // the probe is done once the spinner is gone and the form settled.
      until: state => state !== null && !state.text.includes("Checking") && (state.credentialMode || state.alert),
    });
    if (!custom) throw new Error("The custom server dialog disappeared.");
    const customOk = !custom.alert && !custom.additionalSetup && !custom.keyField && !custom.clientIdField && custom.credentialMode;
    expect(customOk, JSON.stringify({ alert: custom.alert, additionalSetup: custom.additionalSetup, keyField: custom.keyField, clientIdField: custom.clientIdField, credentialMode: custom.credentialMode })).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A custom OAuth server is probed live and asks whose account the AI uses",
      `Custom server ${world.oauthOnlyServerUrl}: the dialog offers OAuth sign-in with no API-key field, no setup warning, and no client ID field`,
      customOk,
    );
    await closeDialog();
  });
});
