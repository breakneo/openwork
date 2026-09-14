import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { McpAppApprovalRequest } from "./mcp-app-origin";

let pendingOwner: object | null = null;

type PendingApproval = {
  request: McpAppApprovalRequest;
  settle: (allowed: boolean) => void;
};

export function useMcpAppApproval() {
  const [target, setTarget] = useState<PendingApproval | null>(null);
  const pending = useRef<PendingApproval | null>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.settle(false);
    };
  }, []);

  const requestApproval = useCallback((request: McpAppApprovalRequest, signal: AbortSignal): Promise<boolean> => {
    if (!mounted.current || signal.aborted || pending.current || pendingOwner) return Promise.resolve(false);
    const owner = {};
    pendingOwner = owner;
    return new Promise<boolean>(resolve => {
      const cancel = () => approval.settle(false);
      const approval: PendingApproval = {
        request,
        settle: allowed => {
          if (pending.current !== approval) return;
          pending.current = null;
          signal.removeEventListener("abort", cancel);
          if (pendingOwner === owner) pendingOwner = null;
          if (mounted.current) setTarget(null);
          resolve(allowed && mounted.current && !signal.aborted);
        },
      };
      pending.current = approval;
      signal.addEventListener("abort", cancel, { once: true });
      setTarget(approval);
    });
  }, []);

  return {
    requestApproval,
    approvalDialog: target ? (
      <AlertDialog open onOpenChange={open => { if (!open) target.settle(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow App action?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              This app wants to run an action that may change data. Review the request before allowing it.
              <br />Server: {target.request.serverName}<br />Tool: {target.request.toolName}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <details>
            <summary className="cursor-pointer">Arguments</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{JSON.stringify(target.request.arguments ?? {}, null, 2)}</pre>
          </details>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => target.settle(true)}>Allow once</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ) : null,
  };
}
