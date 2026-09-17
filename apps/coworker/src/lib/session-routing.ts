import type { CreateThreadInput, HeadlessThread, HeadlessFetch, NativeV2Session } from "@openwork/headless-threads/v2";

export type SessionOwner = { slug: string; createdAt?: string };
export type SessionBinding = { slug: string; createdAt: string; sessionId: string; workspaceId: string; nativeWorkspaceId: string; directory: string; kind: string };
export type CoworkerSessionAccess = {
  binding(owner: SessionOwner, sessionId: string): Promise<SessionBinding>;
  list(owner: SessionOwner, includeLegacy?: boolean): Promise<NativeV2Session[]>;
  create(owner: SessionOwner, input: CreateThreadInput): Promise<HeadlessThread>;
  workspace(): string;
  apiContract?(): "beta19271" | "native-2";
  active?(owner: SessionOwner): Promise<Record<string, { type: "running" }>>;
};

let hostAccess: CoworkerSessionAccess | undefined;
export function configureCoworkerSessionAccess(access: CoworkerSessionAccess | undefined): void {
  hostAccess = access;
}
export function coworkerSessionAccess(): CoworkerSessionAccess | undefined {
  return hostAccess;
}

export function sessionRouting(options: { baseUrl: string; workspaceId: string; owner?: SessionOwner; access: CoworkerSessionAccess; fetch?: HeadlessFetch }): HeadlessFetch {
  const mount = new URL(`/workspace/${encodeURIComponent(options.workspaceId)}/opencode2/api/`, options.baseUrl);
  const send = options.fetch ?? fetch;
  return async (input, init) => {
    const target = new URL(input);
    if (target.origin !== mount.origin || !target.pathname.startsWith(mount.pathname) || target.username || target.password || target.hash) throw new Error("The session request does not belong to this native host.");
    const route = target.pathname.slice(mount.pathname.length);
    const owner = options.owner;
    if (!owner && /^(?:experimental\/)?session(?:\/|$)/.test(route)) return send(target.href, init);
    if (owner && route === "session" && (!init?.method || init.method === "GET")) return Response.json({ data: await options.access.list(owner), cursor: { next: null } });
    if (owner && route === "session/active" && options.access.active && (!init?.method || init.method === "GET")) return Response.json({ data: await options.access.active(owner) });
    if (route === "session" && init?.method === "POST") throw new Error("Native session creation requires the host-owned creation path.");
    const id = /^(?:experimental\/)?session\/(ses_[A-Za-z0-9_]+)(?:\/|$)/.exec(route)?.[1];
    const workspace = id && owner ? (await options.access.binding(owner, id)).nativeWorkspaceId : options.access.workspace();
    if (!workspace) throw new Error("The native team workspace is not ready.");
    target.pathname = `/workspace/${encodeURIComponent(workspace)}/opencode2/api/${route}`;
    return send(target.href, init);
  };
}
