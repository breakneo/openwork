import { InferenceProviderEditorScreen } from "../../../_components/inference-provider-editor-screen";
import { InferenceProviderPickerScreen } from "../../../_components/inference-provider-picker-screen";

export default async function NewGatewayProviderPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  if (!provider) return <InferenceProviderPickerScreen />;
  return <InferenceProviderEditorScreen catalogProviderId={provider} />;
}
