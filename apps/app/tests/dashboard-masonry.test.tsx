import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DashboardMasonry } from "../src/react-app/domains/dashboard/dashboard-masonry";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());

function masonryFixture() {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousObserver = globalThis.ResizeObserver;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const heights = new Map([["short", 40.25], ["tall", 240.75]]);
  const observers: MockResizeObserver[] = [];
  class MockResizeObserver {
    target: Element | null = null;
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this);
      observers.push(this);
    }
    observe = mock((target: Element) => { this.target = target; });
    unobserve() {}
    disconnect = mock(() => {});
  }
  Reflect.set(globalThis, "ResizeObserver", MockResizeObserver);
  const geometrySpy = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const id = this.querySelector("[data-masonry-child]")?.getAttribute("data-masonry-child");
    return new DOMRect(0, 0, 320, heights.get(id ?? "") ?? 0);
  });
  const render = async (ids: string[]) => {
    await act(async () => root.render(<DashboardMasonry>
      {ids.map(id => <input key={id} data-masonry-child={id} defaultValue={id} />)}
    </DashboardMasonry>));
  };
  const child = (id: string) => {
    const node = container.querySelector<HTMLInputElement>(`[data-masonry-child="${id}"]`);
    if (!node) throw new Error(`Missing child ${id}`);
    return node;
  };
  const item = (id: string) => {
    const node = child(id).parentElement;
    if (!node?.hasAttribute("data-dashboard-masonry-item")) throw new Error(`Missing item ${id}`);
    return node;
  };
  const observer = (id: string) => {
    const found = observers.find(observer => observer.target === item(id));
    if (!found) throw new Error(`Missing observer ${id}`);
    return found;
  };
  return {
    container, heights, observers, render, child, item, observer,
    async dispose() {
      try {
        await act(async () => root.unmount());
        for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
      } finally {
        geometrySpy.mockRestore();
        Reflect.set(globalThis, "ResizeObserver", previousObserver);
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
        container.remove();
      }
    },
  };
}

describe("Dashboard masonry mocked DOM measurements (not real geometry proof)", () => {
  test("rounds natural fractional heights to bounded 8px tracks with a gap and updates each item on resize", async () => {
    const host = masonryFixture();
    try {
      await host.render(["short", "tall"]);
      expect(host.container.querySelector<HTMLElement>("[data-dashboard-masonry]")?.style.gridAutoRows).toBe("8px");
      expect(host.item("short").style.gridRowEnd).toBe("span 7");
      expect(host.item("tall").style.gridRowEnd).toBe("span 32");
      expect(host.observers).toHaveLength(2);
      for (const id of ["short", "tall"]) {
        expect(host.observer(id).observe).toHaveBeenCalledTimes(1);
        expect(host.observer(id).observe).toHaveBeenCalledWith(host.item(id));
      }
      const short = host.item("short");
      for (const [height, span] of [[160.01, 22], [80, 11], [0.25, 2], [0, 1], [800, 101]]) {
        host.heights.set("short", height);
        await act(async () => host.observer("short").notify());
        expect(host.item("short")).toBe(short);
        expect(short.style.gridRowEnd).toBe(`span ${span}`);
        expect(host.item("tall").style.gridRowEnd).toBe("span 32");
      }
      host.heights.set("tall", 400.5);
      await act(async () => host.observer("tall").notify());
      expect(host.item("tall").style.gridRowEnd).toBe("span 52");
    } finally { await host.dispose(); }
  });

  test("retains keyed child DOM and observers on reorder, then disconnects removed and unmounted items", async () => {
    const host = masonryFixture();
    try {
      await host.render(["short", "tall"]);
      const short = host.child("short");
      const tall = host.child("tall");
      const shortItem = host.item("short");
      const tallItem = host.item("tall");
      const shortObserver = host.observer("short");
      const tallObserver = host.observer("tall");
      short.value = "Retained app state";
      await host.render(["tall", "short"]);
      expect(Array.from(host.container.querySelectorAll("[data-masonry-child]"))).toEqual([tall, short]);
      expect(host.child("short")).toBe(short);
      expect(host.child("tall")).toBe(tall);
      expect(host.item("short")).toBe(shortItem);
      expect(host.item("tall")).toBe(tallItem);
      expect(short.value).toBe("Retained app state");
      expect(host.observers).toHaveLength(2);
      expect(shortObserver.disconnect).not.toHaveBeenCalled();
      expect(tallObserver.disconnect).not.toHaveBeenCalled();
      expect(shortItem.style.gridRowEnd).toBe("span 7");
      expect(tallItem.style.gridRowEnd).toBe("span 32");
      await host.render(["short"]);
      expect(host.child("short")).toBe(short);
      expect(tall.isConnected).toBe(false);
      expect(tallObserver.disconnect).toHaveBeenCalledTimes(1);
      expect(shortObserver.disconnect).not.toHaveBeenCalled();
    } finally { await host.dispose(); }
  });
});
