import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarMenu, SidebarProvider } from "../src/components/ui/sidebar";
import { MobileChatActions, MobileChatNavigation } from "../src/react-app/domains/session/chat/mobile-chat-navigation";

describe("sidebar-only mobile chat chrome", () => {
  test("renders only one accessible in-flow, safe-area-aware 44px toggle", () => {
    const html = renderToStaticMarkup(<SidebarProvider><MobileChatNavigation /></SidebarProvider>);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open sidebar"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("size-11");
    expect(html).toContain("self-start");
    expect(html).toContain("safe-area-inset-top");
    expect(html).toContain("safe-area-inset-left");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).not.toContain("<header");
    expect(html).not.toContain("absolute");
    expect(html).not.toContain("border-b");
  });

  test("puts advanced chat actions behind a labeled existing sidebar menu", () => {
    const html = renderToStaticMarkup(<SidebarProvider><SidebarMenu><MobileChatActions onFiles={() => {}} fileCount={0} /></SidebarMenu></SidebarProvider>);
    expect(html).toContain("Chat actions");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-sidebar="menu-button"');
  });

  test("overlays only the toggle so the transcript can scroll beneath it", () => {
    const html = renderToStaticMarkup(<SidebarProvider><MobileChatNavigation overlay /></SidebarProvider>);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open sidebar"');
    expect(html).toContain("absolute start-0 top-0 z-20");
    expect(html).toContain("bg-dls-surface/90");
    expect(html).not.toMatch(/(?:class="|\s)pointer-events-none(?:\s|")/);
    const source = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");
    expect(source.indexOf("h-[var(--mobile-chat-top-clearance,0px)]")).toBeGreaterThan(source.indexOf("<div ref={contentRef}"));
  });

  test("keeps desktop, Library and takeover headers outside the mobile chat branch", () => {
    const source = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
    expect(source).toContain("isMobile && shellConfig.sidebar && !props.primarySlot && !hasMainContentTakeover && !props.mainContentHeaderActionsRef && !props.primaryTitle && !props.mainContentTitle");
    expect(source).toContain("const mobileChatOverlay = sidebarOnlyChrome && !isDesktopRuntime()");
    expect(source).toContain("!isDesktopRuntime() && !showNarrowPaneSwitcher");
    expect(source).toContain("mobileChatOverlay && \"relative [--mobile-chat-top-clearance:calc(2.75rem+env(safe-area-inset-top))]\"");
    expect(source).toContain("sidebarOnlyChrome ? <MobileChatNavigation overlay={mobileChatOverlay} /> : <header data-session-header");
    expect(source).toContain("mobileChatActions={sidebarOnlyChrome ? (");
    expect(source).toContain("onOpenAccountSettings={props.onOpenSettings}");
    expect(source).toContain("onOpenExtensions={props.onOpenExtensions}");
  });
});
