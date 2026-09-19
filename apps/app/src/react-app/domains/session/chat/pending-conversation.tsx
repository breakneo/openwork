import { Message, MessageContent } from "@/components/ui/message";
import { TaskRecovery } from "@/components/chat/task-recovery";
import { presentOpencodeSessionError } from "../sync/session-error";
import { persistableComposerDraftText } from "../surface/composer-state-store";
import { resolvePastedTextPlaceholders } from "../surface/composer/pasted-text";
import { retryPendingConversation, type PendingConversation } from "./pending-conversation-store";

export function PendingConversationView({ conversation }: { conversation: PendingConversation }) {
  const failed = conversation.phase === "creation-failed";
  const text = persistableComposerDraftText(resolvePastedTextPlaceholders(conversation.submitted.draft, conversation.submitted.pasteParts));
  const error = failed ? presentOpencodeSessionError(conversation.error, "Couldn’t create conversation") : null;
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8" data-pending-conversation={conversation.id}>
    <Message className="justify-end">
      <MessageContent>
        {text}
        {conversation.submitted.attachments.map((attachment) => <div key={attachment.id} className="text-xs text-muted-foreground">{attachment.name}</div>)}
      </MessageContent>
    </Message>
    <TaskRecovery compact state={failed ? "failed" : "retrying"}
      title={failed ? "Couldn’t create conversation" : conversation.sessionId ? "Opening conversation…" : "Creating conversation…"}
      description="Message not sent"
      technicalDetails={error?.technicalDetails}
      retryLabel="Retry creating conversation"
      onRetry={failed ? () => { void retryPendingConversation(conversation.id); } : undefined}
    />
  </div>;
}
