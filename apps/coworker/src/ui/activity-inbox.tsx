import { useId, useMemo, useRef, useState } from "react";
import type { CoworkerActivityItem, CoworkerGroupSummary, CoworkerSummary } from "@/lib/bridge";
import { describeHeaderStatus } from "@/lib/activity-summary";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar, GroupAvatars } from "@/ui/coworker-avatar";
import { ActivityIcon, AlertIcon, Button, ChevronIcon, IconButton, Tooltip } from "@/ui/kit";

export type ActivityInboxProps = {
  items: CoworkerActivityItem[];
  loading: boolean;
  error: string;
  busy: boolean;
  coworkers: CoworkerSummary[];
  groups: CoworkerGroupSummary[];
  activityBySlug: Record<string, CoworkerActivity>;
  groupLines: Record<string, string>;
  groupActiveSlugs: Record<string, string[]>;
  onRefresh: () => void;
  onMarkRead: (ids: string[], read?: boolean) => Promise<void>;
  onOpen: (item: CoworkerActivityItem) => Promise<void>;
  onOpenCoworker: (slug: string, threadId?: string) => void;
  onOpenGroup: (groupId: string) => Promise<void>;
  onBack: () => void;
  backLabel?: string;
};

type Filter = "all" | "mentions" | "unread";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
  { id: "unread", label: "Unread" },
];
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-spark/60";

function ReadIcon({ read }: { read: boolean }) {
  return (
    <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {read ? <path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : (
        <>
          <rect x="2.5" y="4.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="m3 5.5 7 5 7-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16 8a6.25 6.25 0 1 0 .15 3.5M16 3.5V8h-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function dateBucket(at: number, now: Date): { key: string; label: string } {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return { key: "unknown", label: "Date unavailable" };
  const key = date.toDateString();
  if (key === now.toDateString()) return { key, label: "Today" };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === yesterday.toDateString()) return { key, label: "Yesterday" };
  return {
    key,
    label: date.toLocaleDateString(undefined, {
      weekday: "long", month: "short", day: "numeric",
      ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    }),
  };
}

function ActivityRow({ item, coworker, group, disabled, onOpen, onMarkRead }: {
  item: CoworkerActivityItem;
  coworker: CoworkerSummary | undefined;
  group: CoworkerGroupSummary | undefined;
  disabled: boolean;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  const unread = item.readAt === null;
  const name = coworker?.name || item.slug || "Coworker";
  const location = item.target.kind === "private" ? "Private chat" : `${group?.eventId ? "Event" : "Group"} · ${group?.name || "Group chat"}`;
  const date = new Date(item.at);
  const validDate = Number.isFinite(date.getTime());
  const readAction = unread ? "Mark as read" : "Mark as unread";
  return (
    <li className={`flex min-w-0 items-start border-b border-line/45 first:rounded-t-xl last:rounded-b-xl last:border-b-0 ${unread ? "bg-spark/5" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        className={`flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-4 text-left transition-colors hover:bg-white/4 disabled:cursor-wait @min-[560px]/activity:px-4 ${FOCUS}`}
      >
        <span className="sr-only">Open conversation. </span>
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center">
          {coworker ? (
            <CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor} glasses={coworker.avatarGlasses} size={36} animated={false} gaze={false} />
          ) : <span className="flex size-8 items-center justify-center rounded-lg bg-white/6 text-xs font-medium text-mist">{Array.from(name)[0]?.toLocaleUpperCase()}</span>}
        </span>
        <span className="block min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 text-[13px] leading-5 [overflow-wrap:anywhere]">
              <span className={`text-snow ${unread ? "font-semibold" : "font-medium"}`}>{name}</span>{" "}
              <span className={item.kind === "mention" ? "font-medium text-snow" : "text-mist"}>{item.kind === "mention" ? "mentioned you" : "replied"}</span>
            </span>
            <time dateTime={validDate ? date.toISOString() : undefined} title={validDate ? date.toLocaleString() : undefined} className="shrink-0 text-[11px] tabular-nums text-mist">
              {validDate ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "Time unavailable"}
            </time>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-mist">
            <span className="min-w-0 [overflow-wrap:anywhere]">{location}</span>
            {unread ? <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-spark"><span aria-hidden="true" className="size-1.5 rounded-full bg-spark" />Unread</span> : null}
          </span>
          <span className={`mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-[1.65] [overflow-wrap:anywhere] ${unread ? "font-medium text-snow/90" : "text-mist"}`}>
            {item.preview.trim() || "Open the conversation to read the message."}
          </span>
        </span>
      </button>
      {/* A sibling control: changing read state never opens the conversation. */}
      <div className="shrink-0 pr-2 pt-3.5">
        <IconButton label={`${readAction}: ${name}, ${location}`} tooltip={readAction} disabled={disabled} onClick={onMarkRead} className={unread ? "text-spark" : "text-mist"}>
          <ReadIcon read={unread} />
        </IconButton>
      </div>
    </li>
  );
}

type CurrentConversation = {
  id: string;
  name: string;
  label: string;
  detail: string;
  tone: string;
  priority: number;
  coworker?: CoworkerSummary;
  members?: CoworkerSummary[];
  open: () => void;
};

function HappeningNow({ coworkers, groups, activityBySlug, groupLines, groupActiveSlugs, onOpenCoworker, onOpenGroup }: Pick<
  ActivityInboxProps, "coworkers" | "groups" | "activityBySlug" | "groupLines" | "groupActiveSlugs" | "onOpenCoworker" | "onOpenGroup"
>) {
  const [expanded, setExpanded] = useState(false);
  const [openError, setOpenError] = useState("");
  const [openingGroup, setOpeningGroup] = useState("");
  const openingGroupRef = useRef(false);
  async function openGroup(groupId: string) {
    if (openingGroupRef.current) return;
    openingGroupRef.current = true;
    setOpeningGroup(groupId);
    setOpenError("");
    try { await onOpenGroup(groupId); }
    catch (cause) { setOpenError(cause instanceof Error ? cause.message : "This conversation could not be opened."); }
    finally { openingGroupRef.current = false; setOpeningGroup(""); }
  }
  const headingId = useId();
  const contentId = useId();
  const current: CurrentConversation[] = [];
  const bySlug = new Map(coworkers.map((coworker) => [coworker.slug, coworker]));
  for (const coworker of coworkers) {
    const activity = activityBySlug[coworker.slug];
    if (!activity || activity.state === "ready" || activity.state === "recent") continue;
    const status = describeHeaderStatus(activity, true);
    const needsAttention = activity.state === "attention" || activity.state === "offline" || Boolean(activity.reason);
    current.push({
      id: `coworker:${coworker.slug}`, name: coworker.name, label: status.word,
      detail: activity.summary || activity.reason || activity.detail,
      tone: needsAttention ? "text-amber" : activity.state === "working" ? "text-spark" : "text-mist",
      priority: needsAttention ? 0 : activity.state === "working" ? 1 : 2,
      coworker,
      open: () => onOpenCoworker(coworker.slug, activity.threadId),
    });
  }
  for (const group of groups) {
    if (group.archivedAt) continue;
    const activeSlugs = groupActiveSlugs[group.id] ?? [];
    const line = groupLines[group.id]?.trim() ?? "";
    // These are current phrases from describeGroupPresentation. A historical
    // “replied” / “Replies ready” line is not ongoing work or an unread notification.
    const waiting = /(?:^| )waiting for you$/i.test(line);
    const currentLine = waiting || /^(Waiting (?:for |to start)|Choosing who should respond|Reconnecting to activity|Activity unavailable)/i.test(line);
    if (activeSlugs.length === 0 && !currentLine) continue;
    current.push({
      id: `group:${group.id}`, name: group.name, label: line || "Working",
      detail: group.eventId ? "Event conversation" : "Group chat",
      tone: waiting || line === "Activity unavailable" ? "text-amber" : activeSlugs.length ? "text-spark" : "text-mist",
      priority: waiting ? 0 : activeSlugs.length ? 1 : 2,
      members: group.participantSlugs.flatMap((slug) => { const member = bySlug.get(slug); return member ? [member] : []; }),
      open: () => void openGroup(group.id),
    });
  }
  current.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const visible = expanded ? current : current.slice(0, 4);

  return (
    <aside aria-labelledby={headingId} className="order-first min-w-0 rounded-xl border border-line/70 bg-white/2 @min-[960px]/activity:order-last @min-[960px]/activity:w-[272px] @min-[960px]/activity:shrink-0">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-xs font-semibold text-snow"><ActivityIcon className="size-3.5 text-mist" />Happening now<span className="text-[10px] font-normal tabular-nums text-mist">{current.length}</span></h2>
          <IconButton label={expanded ? "Hide current conversations" : "Show current conversations"} className="size-6 @min-[960px]/activity:hidden" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
            <ChevronIcon direction="right" className={`size-3.5 ${expanded ? "-rotate-90" : "rotate-90"}`} />
          </IconButton>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-mist">Current status, separate from notifications.</p>
      </div>
      {openError ? <p role="alert" className="px-4 pb-3 text-xs text-amber">{openError}</p> : null}
      <div id={contentId} className={expanded ? "" : "hidden @min-[960px]/activity:block"}>
      {visible.length ? (
        <ul className="px-1.5 pb-1.5">
          {visible.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={entry.open} disabled={Boolean(openingGroup)} aria-busy={entry.id === `group:${openingGroup}`} className={`flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-3 text-left transition-colors hover:bg-white/5 disabled:cursor-wait ${FOCUS}`}>
                <span aria-hidden="true" className="flex h-8 w-11 shrink-0 items-center justify-center">
                  {entry.coworker ? <CoworkerAvatar identity={entry.coworker.slug} name={entry.coworker.name} color={entry.coworker.avatarColor} glasses={entry.coworker.avatarGlasses} size={30} animated={false} gaze={false} /> : <GroupAvatars members={(entry.members ?? []).slice(0, 2)} size={20} animated={false} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium leading-5 text-snow [overflow-wrap:anywhere]">{entry.name}</span>
                  <span className={`block text-[11px] font-medium leading-5 [overflow-wrap:anywhere] ${entry.tone}`}>{entry.label}</span>
                  {entry.detail && entry.detail !== entry.label ? <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-mist [overflow-wrap:anywhere]">{entry.detail}</span> : null}
                </span>
                <ChevronIcon direction="right" className="mt-1 size-3 shrink-0 text-mist" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-4 pb-4 text-xs leading-5 text-mist">
          <p className="text-snow/80">No live work to show.</p>
          <p className="mt-1">Working conversations and requests for you appear here.</p>
        </div>
      )}
      {current.length > 4 ? <div className="hidden border-t border-line/60 px-3 py-2 @min-[960px]/activity:block"><Button variant="ghost" className={`w-full text-xs ${FOCUS}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `Show all ${current.length} conversations`}</Button></div> : null}
      </div>
    </aside>
  );
}

/** Standalone view. Navigation/acknowledgement of an opened item belongs to onOpen. */
export function ActivityInbox({ items, loading, error, busy, coworkers, groups, activityBySlug, groupLines, groupActiveSlugs, onRefresh, onMarkRead, onOpen, onOpenCoworker, onOpenGroup, onBack, backLabel = "Back to chat" }: ActivityInboxProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const actionInFlight = useRef(false);
  const titleId = useId();
  const feedId = useId();
  const bySlug = useMemo(() => new Map(coworkers.map((coworker) => [coworker.slug, coworker])), [coworkers]);
  const byGroup = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const unreadIds = items.filter((item) => item.readAt === null).map((item) => item.id);
  const counts: Record<Filter, number> = { all: items.length, mentions: items.filter((item) => item.kind === "mention").length, unread: unreadIds.length };
  const sections = useMemo(() => {
    const visible = items.filter((item) => filter === "mentions" ? item.kind === "mention" : filter === "unread" ? item.readAt === null : true)
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    const dates = new Map<string, { key: string; label: string; items: CoworkerActivityItem[] }>();
    const now = new Date();
    for (const item of visible) {
      const bucket = dateBucket(item.at, now);
      const section = dates.get(bucket.key);
      if (section) section.items.push(item);
      else dates.set(bucket.key, { ...bucket, items: [item] });
    }
    return [...dates.values()];
  }, [filter, items]);
  const disabled = busy || pending;
  const problem = actionError || error;

  async function act(action: () => Promise<void>, fallback: string) {
    if (actionInFlight.current || busy) return;
    actionInFlight.current = true;
    setPending(true);
    setActionError("");
    try { await action(); }
    catch (cause) { setActionError(cause instanceof Error && cause.message ? `${fallback} ${cause.message}` : fallback); }
    finally { actionInFlight.current = false; setPending(false); }
  }

  return (
    <section aria-labelledby={titleId} className="@container/activity glass-main flex h-full min-h-0 min-w-0 flex-1 flex-col text-snow" data-testid="activity-inbox">
      <header className="glass-header window-drag flex min-h-[78px] shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 @min-[560px]/activity:px-6">
        <div className="min-w-0">
          <h1 id={titleId} className="text-lg font-semibold tracking-tight">Activity</h1>
          <p className="mt-1 text-xs leading-4 text-mist">Replies, mentions, and a pulse on your team.</p>
        </div>
        <Button variant="ghost" onClick={onBack} className={`window-no-drag flex shrink-0 items-center gap-1.5 rounded-lg text-xs ${FOCUS}`}><ChevronIcon direction="left" className="size-3.5" />{backLabel}</Button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/70 px-3 py-3 @min-[560px]/activity:px-6">
        <div role="group" aria-label="Filter activity" className="flex flex-wrap items-center gap-1">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={filter === id} aria-controls={feedId} onClick={() => setFilter(id)} className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${FOCUS} ${filter === id ? "bg-white/8 font-semibold text-snow ring-1 ring-inset ring-white/10" : "text-mist hover:bg-white/4 hover:text-snow"}`}>
              {label}<span className={`rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${filter === id ? "bg-white/8 text-snow" : "text-mist"}`}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={loading ? "Refreshing activity" : "Refresh activity"} disabled={loading || disabled} onClick={() => { setActionError(""); onRefresh(); }} aria-busy={loading}><RefreshIcon /></IconButton>
          <Tooltip content="Mark every currently unread notification as read, across all filters.">
            <Button type="button" variant="ghost" className={`inline-flex items-center gap-1.5 rounded-lg text-xs ${FOCUS}`} disabled={unreadIds.length === 0 || disabled} aria-busy={busy} onClick={() => void act(() => onMarkRead([...unreadIds], true), "Could not mark all as read.")}>
              <ReadIcon read />Mark all read
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-5 px-3 py-5 @min-[560px]/activity:px-6 @min-[960px]/activity:flex-row @min-[960px]/activity:items-start">
          <div id={feedId} className="min-w-0 flex-1">
            <h2 className="sr-only">{filter === "mentions" ? "Mentions" : filter === "unread" ? "Unread notifications" : "All notifications"}</h2>
            <p role="status" aria-live="polite" className="sr-only">{loading && items.length === 0 ? "Loading activity." : `${counts[filter]} notifications in this view. ${counts.unread} unread in total.`}</p>
            {problem ? (
              <div role="alert" className="mb-4 rounded-xl border border-amber/25 bg-amber/5 p-3">
                <div className="flex items-start gap-2"><AlertIcon className="mt-0.5 size-4 shrink-0 text-amber" /><p className="min-w-0 flex-1 text-xs leading-5 text-snow [overflow-wrap:anywhere]">{problem}</p></div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  {items.length > 0 ? <p className="text-[11px] leading-4 text-mist">Your last loaded activity is still shown.</p> : null}
                  <Button variant="ghost" disabled={loading || disabled} className={`text-xs ${FOCUS}`} onClick={() => { setActionError(""); onRefresh(); }}>Refresh activity</Button>
                </div>
              </div>
            ) : null}
            {loading && items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-line/60 px-6 py-14 text-center text-mist"><ActivityIcon className="size-6 motion-safe:animate-pulse" /><p className="text-sm">Loading activity…</p></div>
            ) : sections.length === 0 && !problem ? (
              <div className="rounded-xl border border-line/60 px-6 py-14 text-center">
                <span aria-hidden="true" className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-line/70 bg-white/3 text-mist">{filter === "mentions" ? <span className="text-xl">@</span> : <ReadIcon read={filter === "unread"} />}</span>
                <h3 className="text-sm font-medium text-snow">{filter === "unread" ? "You're all caught up" : filter === "mentions" ? "No mentions yet" : "Nothing here yet"}</h3>
                <p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-mist">{filter === "unread" ? "New replies and mentions will be waiting here." : filter === "mentions" ? "When a coworker mentions you, you'll find it here." : "Replies and mentions from your conversations will appear here."}</p>
                {filter !== "all" && items.length > 0 ? <Button variant="ghost" className={`mt-4 text-xs ${FOCUS}`} onClick={() => setFilter("all")}>View all activity</Button> : null}
              </div>
            ) : sections.map((section, index) => (
              <section key={section.key} aria-labelledby={`${feedId}-${index}`} className="mb-5 last:mb-0">
                <div className="mb-2 flex items-center gap-3 px-1"><h3 id={`${feedId}-${index}`} className="min-w-0 text-[11px] font-medium text-mist [overflow-wrap:anywhere]">{section.label}</h3><span aria-hidden="true" className="h-px min-w-0 flex-1 bg-line/60" /></div>
                <ul className="rounded-xl border border-line/70">
                  {section.items.map((item) => (
                    <ActivityRow key={item.id} item={item} coworker={bySlug.get(item.slug)} group={item.target.kind === "group" ? byGroup.get(item.target.groupId) : undefined} disabled={disabled}
                      onOpen={() => void act(() => onOpen(item), "Could not open this conversation.")}
                      onMarkRead={() => void act(() => onMarkRead([item.id], item.readAt === null), "Could not update read status.")} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <HappeningNow coworkers={coworkers} groups={groups} activityBySlug={activityBySlug} groupLines={groupLines} groupActiveSlugs={groupActiveSlugs} onOpenCoworker={onOpenCoworker} onOpenGroup={onOpenGroup} />
        </div>
      </div>
    </section>
  );
}
