import type { VerificationDictionary, VerificationEvaluator } from "@openwork/testkit";

// Synthetic fixture only. No provider prompts, identities, or router IDs enter compilation.
export const routingIntent = "Verify the Edit router heading is visible; the editor name is Daily work revised; category 1 is Code review and debugging; category 2 is Clear business writing; minimum confidence is 0.75; the saved API router revision is 2; the saved API router name is Daily work revised; the saved API categories are Code review and debugging and Clear business writing; the saved API minimum confidence is 0.75; the Gateway administrative link is absent; and the saved-configuration-only notice says no live request has been tested here.";
export const unsupportedRoutingIntent = "Verify a PDF invoice was exported to disk.";
export const routingDictionary: VerificationDictionary = {
  id: "gateway-routing-saved-editor", version: "2",
  checks: [
    { id: "editor", description: "The Edit router heading is visible", assertion: { kind: "see", target: { role: "heading", text: "Edit router" } } },
    ...[
      ["name", "Name", "Daily work revised"],
      ["category-1", "Prompt category 1", "Code review and debugging"],
      ["category-2", "Prompt category 2", "Clear business writing"],
      ["confidence", "Minimum confidence", "0.75"],
    ].map(([id, label, value]) => ({ id: `editor-${id}`, description: `The editor ${label} is ${value}`, assertion: { kind: "see", target: { label }, options: { value } } } satisfies VerificationDictionary["checks"][number])),
    { id: "api-revision", description: "The saved API router revision is 2", assertion: { kind: "observe", observation: { id: "saved-router", version: "1" }, path: [0, "revision"], predicate: { kind: "equals", value: 2 } } },
    { id: "api-name", description: "The saved API router name is Daily work revised", assertion: { kind: "observe", observation: { id: "saved-router", version: "1" }, path: [0, "name"], predicate: { kind: "equals", value: "Daily work revised" } } },
    { id: "api-category-1", description: "The saved API category 1 is Code review and debugging", assertion: { kind: "observe", observation: { id: "saved-router", version: "1" }, path: [0, "routes", 0, "description"], predicate: { kind: "equals", value: "Code review and debugging" } } },
    { id: "api-category-2", description: "The saved API category 2 is Clear business writing", assertion: { kind: "observe", observation: { id: "saved-router", version: "1" }, path: [0, "routes", 1, "description"], predicate: { kind: "equals", value: "Clear business writing" } } },
    { id: "api-confidence", description: "The saved API minimum confidence is 0.75", assertion: { kind: "observe", observation: { id: "saved-router", version: "1" }, path: [0, "minConfidence"], predicate: { kind: "equals", value: 0.75 } } },
    { id: "no-admin", description: "The Gateway administrative link is absent", assertion: { kind: "notSee", target: { role: "link", label: "Gateway" } } },
    { id: "not-live-verified", description: "The saved-configuration-only notice says no live request has been tested here", assertion: { kind: "see", target: { text: "Saved configuration only. No live request has been tested here." } } },
  ],
};
export const routingCheckIds = routingDictionary.checks.map(check => check.id);

// CI selection fixture, NOT live Jev evidence. Unknown intents abstain.
export const offlineRoutingEvaluator: VerificationEvaluator = async ({ state, questions }) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, {
    type: "boolean", probability: Number(state.intent === routingIntent),
  }])),
});
