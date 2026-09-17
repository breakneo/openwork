import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createDenClient } from "@/app/lib/den";
import { readGatewayUsageScope as readScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useDenAuth } from "./den-auth-provider";
import { corroboratesGatewayUsageError, gatewayUsageResetDelay, gatewayUsageQueryPrefix, type GatewayUsageErrorEvidence } from "./gateway-usage-state";
import { refreshGatewayUsageAfterCompletion } from "./gateway-usage-refresh";
import type { GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
function subscribeScope(listener: () => void) {
  let previous = readScope();
  return subscribeGatewayUsageScope(() => {
    const next = readScope();
    if (previous !== next) {
      previous = next;
      const client = getReactQueryClient();
      void client.cancelQueries({ queryKey: gatewayUsageQueryPrefix });
      client.removeQueries({ queryKey: gatewayUsageQueryPrefix });
    }
    listener();
  });
}

export function useGatewayUsageErrorHandled(input: {
  scopeKey: string;
  sessionOwner: string;
  errorKey: string | null;
  gatewaySelected: boolean;
  evidence: GatewayUsageErrorEvidence | null;
  status?: GatewayUsageStatus;
}) {
  const key = input.evidence ? JSON.stringify([input.scopeKey, input.sessionOwner, input.errorKey, input.evidence]) : null;
  const corroborated = input.gatewaySelected && corroboratesGatewayUsageError(input.evidence, input.status);
  const [handledKey, setHandledKey] = useState<string | null>(null);
  useEffect(() => {
    if (corroborated && key) setHandledKey(key);
  }, [corroborated, key]);
  return input.gatewaySelected && key !== null && (corroborated || handledKey === key);
}

export function useGatewayUsage(requested: boolean, panelOpen = false, refreshKey?: string, settled = false, providerScope?: number | null) {
  const auth = useDenAuth();
  const scope = useSyncExternalStore(subscribeScope, readScope, readScope);
  const queryClient = useQueryClient();
  const enabled = requested && (providerScope === undefined || providerScope === scope.generation);
  const authorized = Boolean(auth.isSignedIn && scope.token && scope.organizationId && auth.verifiedIdentity?.organizationId === scope.organizationId);
  const queryKey = [...gatewayUsageQueryPrefix, scope.generation, scope.organizationId, auth.verifiedIdentity?.principalId ?? null];
  const assertCurrent = () => {
    if (!authorized || readScope() !== scope || !scope.organizationId) throw new Error("The signed-in organization changed. Reopen usage limits.");
    return scope.organizationId;
  };
  const client = createDenClient({ baseUrl: scope.baseUrl, apiBaseUrl: scope.apiBaseUrl, token: scope.token });
  const query = useQuery({
    queryKey,
    enabled: authorized && enabled,
    queryFn: async ({ signal }) => {
      const data = await client.getGatewayUsageStatus(assertCurrent());
      assertCurrent();
      signal.throwIfAborted();
      return data;
    },
    gcTime: 0,
    staleTime: 5000,
    refetchOnMount: panelOpen ? "always" : true,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: (state) => enabled && (panelOpen || state.state.data?.state === "blocked" || state.state.data?.state === "over_limit" || state.state.data?.buckets.some((bucket) => bucket.resetRequestStatus === "pending")) ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = query;
  const refreshScope = `${scope.generation}:${auth.verifiedIdentity?.principalId ?? ""}`;
  const previousRefresh = useRef({ refreshScope, refreshKey, enabled });
  useEffect(() => {
    const previous = previousRefresh.current;
    previousRefresh.current = { refreshScope, refreshKey, enabled };
    if (!authorized || !enabled || previous.refreshScope !== refreshScope || (previous.enabled && previous.refreshKey === refreshKey)) return;
    void refetch({ cancelRefetch: false });
  }, [authorized, enabled, refreshKey, refreshScope, refetch]);
  const previousSettlement = useRef({ refreshScope, settled });
  useEffect(() => {
    const previous = previousSettlement.current;
    previousSettlement.current = { refreshScope, settled };
    if (!authorized || !enabled || previous.refreshScope !== refreshScope || !settled || previous.settled) return;
    refreshGatewayUsageAfterCompletion(scope.generation, JSON.stringify([refreshScope, refreshKey]));
  }, [authorized, enabled, refreshScope, scope.generation, refreshKey, settled]);
  useEffect(() => {
    if (!authorized || !enabled || !query.data) return;
    const delay = gatewayUsageResetDelay(query.data, query.dataUpdatedAt, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => { void refetch({ cancelRefetch: false }); }, query.isError ? Math.max(30_000, delay) : delay);
    return () => window.clearTimeout(timer);
  }, [authorized, enabled, query.data, query.dataUpdatedAt, query.isError, query.errorUpdatedAt, refetch]);

  const reset = useMutation({
    mutationKey: [...queryKey, "reset"],
    retry: false,
    mutationFn: async (input: { bucketId: string; reason: string }) => {
      const organizationId = assertCurrent();
      const bucket = query.data?.buckets.find((item) => item.id === input.bucketId);
      if (query.isError || !bucket?.canRequestReset || bucket.resetRequestStatus === "pending") throw new Error("Refresh usage limits to check increase eligibility.");
      const result = await client.requestGatewayUsageReset(organizationId, input);
      assertCurrent();
      return result;
    },
    onSuccess: (request) => {
      if (readScope() !== scope) return;
      queryClient.setQueryData(queryKey, query.data ? {
        ...query.data,
        buckets: query.data.buckets.map((bucket) => bucket.id === request.bucketId ? { ...bucket, canRequestReset: false, resetRequestStatus: request.status } : bucket),
      } : undefined);
    },
    onSettled: async () => {
      if (readScope() === scope) await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });
  return { query, reset, authorized, active: enabled && authorized, scopeKey: `${scope.generation}:${auth.verifiedIdentity?.principalId ?? ""}`, data: authorized ? query.data : undefined };
}
