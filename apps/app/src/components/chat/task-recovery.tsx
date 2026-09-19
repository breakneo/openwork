import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, CirclePause, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
  const Icon = state === "retrying" ? LoaderCircle : state === "paused" ? CirclePause : AlertTriangle;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const details = props.technicalDetails?.trim();
  const hasDetails = details && details.replace(/^Message:\s*/, "") !== props.title.trim();

  return (
    <div className="not-prose mx-auto w-full max-w-3xl px-2 md:px-10" data-testid={props.testId}>
      <Alert appearance="inline" variant={state === "failed" ? "destructive" : "default"} role="group">
        <Icon aria-hidden="true" className={state === "retrying" ? "animate-spin motion-reduce:animate-none" : undefined} />
        <AlertTitle role={state === "failed" ? "alert" : "status"}>
          {props.title}
        </AlertTitle>
        <AlertDescription className="col-start-2 flex min-w-0 flex-col gap-2">
          {props.description ? <p>{props.description}</p> : null}
          {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
          {hasDetails ? (
            <details onToggle={(event) => setOpen(event.currentTarget.open)}>
              <summary data-testid="session-error-details-toggle" aria-expanded={open} className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs">
                <ChevronRight aria-hidden="true" className={open ? "size-3 rotate-90" : "size-3"} />
                Technical details
              </summary>
              {open ? <div data-testid="session-error-details" className="mt-2 flex min-w-0 flex-col items-start gap-2">
                <pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words text-xs">{details}</pre>
                <Button size="xs" variant="ghost" onClick={() => {
                  void navigator.clipboard.writeText(details).then(() => setCopied(true)).catch(() => {});
                }}>{copied ? "Copied" : "Copy details"}</Button>
              </div> : null}
            </details>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}
