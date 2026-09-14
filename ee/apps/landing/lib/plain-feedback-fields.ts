import type { CreateThreadFieldOnThreadInput, CreateThreadFieldSchemaInput } from "@team-plain/graphql";

export type FeedbackContext = {
  source?: string;
  entrypoint?: string;
  deployment?: string;
  appVersion?: string;
  openworkServerVersion?: string;
  opencodeVersion?: string;
  osName?: string;
  osVersion?: string;
  platform?: string;
};

type FeedbackMetadata = FeedbackContext & {
  mode: "feedback" | "contact";
  submittedAt: string;
};

const fieldDefinitions = [
  { property: "mode", key: "openwork_form_mode", label: "OpenWork form", type: "STRING" },
  { property: "source", key: "openwork_source", label: "OpenWork source", type: "STRING" },
  { property: "entrypoint", key: "openwork_entrypoint", label: "OpenWork entrypoint", type: "STRING" },
  { property: "deployment", key: "openwork_deployment", label: "OpenWork deployment", type: "STRING" },
  { property: "appVersion", key: "openwork_app_version", label: "OpenWork app version", type: "STRING" },
  { property: "openworkServerVersion", key: "openwork_server_version", label: "OpenWork server version", type: "STRING" },
  { property: "opencodeVersion", key: "openwork_opencode_version", label: "OpenWork OpenCode version", type: "STRING" },
  { property: "osName", key: "openwork_os_name", label: "OpenWork OS", type: "STRING" },
  { property: "osVersion", key: "openwork_os_version", label: "OpenWork OS version", type: "STRING" },
  { property: "platform", key: "openwork_platform", label: "OpenWork platform", type: "STRING" },
  { property: "submittedAt", key: "openwork_submitted_at", label: "OpenWork submitted at", type: "DATE" },
] satisfies { property: keyof FeedbackMetadata; key: string; label: string; type: "STRING" | "DATE" }[];

// Shared by the form and the one-time setup script so schema keys/types stay in sync.
export const plainFeedbackFieldSchemas: CreateThreadFieldSchemaInput[] = fieldDefinitions.map((field, order) => ({
  key: field.key,
  label: field.label,
  description: `${field.label} recorded when a contact or feedback form was submitted.`,
  type: field.type,
  enumValues: [],
  order,
  isRequired: false,
  isClientReadonly: true,
  isAiAutoFillEnabled: false,
  isAvailableToAgents: false,
}));

export function buildFeedbackThreadFields(metadata: FeedbackMetadata): CreateThreadFieldOnThreadInput[] {
  return fieldDefinitions.flatMap((field) => {
    const value = metadata[field.property]?.trim();
    if (!value || value.toLowerCase() === "unknown") return [];
    return [{
      key: field.key,
      type: field.type,
      ...(field.type === "DATE" ? { dateValue: value } : { stringValue: value }),
    }];
  });
}
