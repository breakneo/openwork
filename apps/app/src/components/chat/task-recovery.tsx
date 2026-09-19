import { useEffect, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** One presentation for task failures, interruptions and engine-owned retries. */
export function TaskRecovery(props: {
  title: string;
  state?: "failed" | "paused" | "retrying";
  description?: ReactNode;
  actions?: ReactNode;
  technicalDetails?: string | null;
  testId?: string;
}) {
  const state = props.state ?? "failed";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const details = props.technicalDetails?.trim();
  const hasDetails = details && details.replace(/^Message:\s*/, "") !== props.title.trim();

  return (
    <Collapsible className="not-prose mx-auto w-full max-w-3xl px-2 py-2 md:px-10" data-testid={props.testId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p role={state === "failed" ? "alert" : "status"} className="min-w-0 text-sm leading-6 text-muted-foreground">{props.title}</p>
        <div className="flex shrink-0 items-center gap-1 text-foreground">
          {props.actions}
          {hasDetails ? <span className="text-muted-foreground">
            <CollapsibleTrigger data-testid="session-error-details-toggle"
              render={<Button variant="ghost" size="icon-xs" aria-label="Technical details" title="Technical details" />}>
              <Ellipsis aria-hidden="true" />
            </CollapsibleTrigger>
          </span> : null}
        </div>
      </div>
      {props.description ? <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
      {hasDetails ? <CollapsibleContent data-testid="session-error-details"
        className="overflow-hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-150 motion-reduce:animate-none">
        <div className="mt-3 flex min-w-0 flex-col items-start gap-2 border-s border-border ps-3 text-muted-foreground">
          <pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{details}</pre>
          <Button size="xs" variant="ghost" onClick={() => {
            void navigator.clipboard.writeText(details).then(() => setCopied(true)).catch(() => {});
          }}>{copied ? "Copied" : "Copy details"}</Button>
        </div>
      </CollapsibleContent> : null}
    </Collapsible>
  );
}
