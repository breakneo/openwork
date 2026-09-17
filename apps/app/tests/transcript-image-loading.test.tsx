import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import DOMPurify from "dompurify";

const sanitizerDescriptor = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(DOMPurify, "sanitize", { configurable: true, writable: true, value: DOMPurify(window).sanitize });
const { act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { deferTranscriptImage } = await import("../src/components/chat/transcript-image-loading");
const { ImageAttachmentBadge } = await import("../src/components/chat/image-attachment-badge");
const { Image } = await import("../src/components/ui/image");
const { MarkdownBlock } = await import("../src/components/markdown/markdown");
const { renderMarkdownHtml, renderHighlightedMarkdownHtml, createStreamingMarkdownRenderer } = await import("../src/components/markdown/markdown-primitive");
const { deferredMarkdownImageSource, DEFERRED_IMAGE_SOURCE } = await import("../src/components/markdown/deferred-images");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");

const source = "data:image/png;base64,iVBORw0KGgo=";
const remoteSource = "https://example.com/photo.png";
const originalObserver = window.IntersectionObserver;
const originalAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const frames = new Map<number, FrameRequestCallback>();
const observers: TestObserver[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
let nextFrame = 0;

class TestObserver {
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  intersect(target: Element, isIntersecting = true) {
    this.callback([{
      target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
      time: 0, boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(), rootBounds: null,
    }], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(window, "IntersectionObserver", TestObserver);
  const request = spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancel = spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  cleanups.push(() => { request.mockRestore(); cancel.mockRestore(); });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  frames.clear();
  observers.length = 0;
  Reflect.set(window, "IntersectionObserver", originalObserver);
  document.body.replaceChildren();
});
afterAll(async () => {
  if (sanitizerDescriptor) Object.defineProperty(DOMPurify, "sanitize", sanitizerDescriptor);
  else Reflect.deleteProperty(DOMPurify, "sanitize");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function frame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
function near(image: Element, value = true) {
  const observer = observers.find((candidate) => candidate.targets.has(image));
  if (!observer) throw new Error("Image is not observed");
  observer.intersect(image, value);
}
function enqueue(src = source) {
  const image = document.createElement("img");
  document.body.append(image);
  const cancel = deferTranscriptImage(image, src);
  cleanups.push(cancel);
  return { image, cancel };
}
async function mounted(content: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (children: React.ReactNode) => {
    await act(async () => root.render(<StrictMode><PlatformProvider value={createDefaultPlatform()}>{children}</PlatformProvider></StrictMode>));
  };
  cleanups.push(async () => { await act(async () => root.unmount()); });
  await render(content);
  return { container, render };
}
function imageIn(container: ParentNode) {
  const image = container.querySelector("img");
  if (!(image instanceof HTMLImageElement)) throw new Error("Image is missing");
  return image;
}

test("data URLs stay absent until intersecting images have two frame opportunities", async () => {
  const visible = enqueue();
  const distant = enqueue();
  expect(visible.image.hasAttribute("src")).toBe(false);
  expect(distant.image.hasAttribute("src")).toBe(false);
  expect(observers).toHaveLength(1);
  near(visible.image);
  await frame();
  expect(visible.image.hasAttribute("src")).toBe(false);
  await frame();
  expect(visible.image.getAttribute("src")).toBe(source);
  expect(distant.image.hasAttribute("src")).toBe(false);
});

test("four active images bound work; load and error each release a slot", async () => {
  const images = Array.from({ length: 7 }, () => enqueue(remoteSource).image);
  images.forEach((image) => near(image));
  await frame();
  await frame();
  expect(images.filter((image) => image.hasAttribute("src"))).toHaveLength(4);
  images[0]!.dispatchEvent(new Event("load"));
  await Promise.resolve();
  expect(images[4]!.hasAttribute("src")).toBe(true);
  images[1]!.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(images[5]!.hasAttribute("src")).toBe(true);
  expect(images[6]!.hasAttribute("src")).toBe(false);
});

test("scrolling away cancels queued activation until a fresh intersection", async () => {
  const { image } = enqueue();
  near(image);
  await frame();
  near(image, false);
  await frame();
  expect(image.hasAttribute("src")).toBe(false);
  near(image);
  await frame();
  expect(image.hasAttribute("src")).toBe(false);
  await frame();
  expect(image.hasAttribute("src")).toBe(true);
});

test("session teardown cancels active and queued work without activating the next image", async () => {
  const jobs = Array.from({ length: 5 }, () => enqueue(remoteSource));
  jobs.forEach(({ image }) => near(image));
  await frame();
  await frame();
  expect(jobs.filter(({ image }) => image.hasAttribute("src"))).toHaveLength(4);
  jobs.forEach(({ cancel }) => cancel());
  await Promise.resolve();
  expect(jobs.every(({ image }) => !image.hasAttribute("src"))).toBe(true);
  expect(frames.size).toBe(0);
  jobs[0]!.image.dispatchEvent(new Event("load"));
  expect(jobs[4]!.image.hasAttribute("src")).toBe(false);
});

test("repeated old cleanup cannot clear a replacement source", async () => {
  const { image, cancel } = enqueue();
  cancel();
  cleanups.push(deferTranscriptImage(image, remoteSource));
  near(image);
  await frame();
  await frame();
  cancel();
  expect(image.getAttribute("src")).toBe(remoteSource);
});

test("stalled images time out, cancel their source, and let the queue advance", async () => {
  const timeouts: (() => void)[] = [];
  const original = window.setTimeout.bind(window);
  const timer = spyOn(window, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === 15_000 && typeof handler === "function") {
      timeouts.push(() => handler(...args));
      return 12345;
    }
    return original(handler, delay, ...args);
  });
  cleanups.push(() => timer.mockRestore());
  const images = Array.from({ length: 5 }, () => enqueue(remoteSource).image);
  images.forEach((image) => near(image));
  await frame();
  await frame();
  timeouts[0]!();
  await Promise.resolve();
  expect(images[0]!.hasAttribute("src")).toBe(false);
  expect(images[0]!.dataset.transcriptImage).toBe("error");
  expect(images[4]!.getAttribute("src")).toBe(remoteSource);
});

test("no IntersectionObserver still defers and bounds activation", async () => {
  Reflect.set(window, "IntersectionObserver", undefined);
  const images = Array.from({ length: 6 }, () => enqueue(remoteSource).image);
  await frame();
  expect(images.every((image) => !image.hasAttribute("src"))).toBe(true);
  await frame();
  expect(images.filter((image) => image.hasAttribute("src"))).toHaveLength(4);
});

test("Strict Mode and queued source replacement keep the same badge without showing stale bytes", async () => {
  const view = await mounted(<ImageAttachmentBadge src="blob:http://localhost/old" alt="Photo" deferPreview />);
  const image = imageIn(view.container);
  near(image);
  await frame();
  await view.render(<ImageAttachmentBadge src={source} alt="Photo" deferPreview />);
  expect(imageIn(view.container) === image).toBe(true);
  expect(image.hasAttribute("src")).toBe(false);
  near(image);
  await frame();
  await frame();
  expect(image.getAttribute("src")).toBe(source);
  await view.render(<ImageAttachmentBadge src={`${source}new`} alt="Photo" deferPreview />);
  expect(imageIn(view.container) === image).toBe(true);
  expect(image.hasAttribute("src")).toBe(false);
});

test("composer and generic images remain immediate while transcript expansion bypasses the queue", async () => {
  const view = await mounted(<><ImageAttachmentBadge src={source} alt="Draft" /><Image src={source} alt="Standalone" /><ImageAttachmentBadge src={source} alt="History" deferPreview /><Image src={source} alt="Answer" deferPreview /></>);
  const images = [...view.container.querySelectorAll("img")];
  expect(images.slice(0, 2).every((image) => image.getAttribute("src") === source)).toBe(true);
  expect(images.slice(2).every((image) => !image.hasAttribute("src"))).toBe(true);
  const button = view.container.querySelector<HTMLButtonElement>('[aria-label="Expand History"]');
  await act(async () => button?.click());
  expect(document.querySelector("[data-image-lightbox] img")?.getAttribute("src")).toBe(source);
  expect(images[2]!.hasAttribute("src")).toBe(false);
});

function htmlRoot(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

test("empty markdown and disabled deferral cancel pending previews", async () => {
  const view = await mounted(<MarkdownBlock text={`Text.\n\n![Photo](${remoteSource})`} deferImages />);
  const image = imageIn(view.container);
  near(image);
  await frame();
  await view.render(<MarkdownBlock text="" deferImages />);
  await frame();
  expect(image.hasAttribute("src")).toBe(false);
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  await view.render(<MarkdownBlock text={`Text.\n\n![Photo](${remoteSource})`} deferImages />);
  const queued = imageIn(view.container);
  await view.render(<MarkdownBlock text={`Text.\n\n![Photo](${remoteSource})`} />);
  expect(queued.hasAttribute("src")).toBe(false);
  expect(imageIn(view.container).getAttribute("src")).toBe(remoteSource);
});

test("plain, highlighted and streaming markdown defer only opted-in chat previews after sanitization", async () => {
  const text = `Text first.\n\n![Photo](${remoteSource})`;
  const renderer = createStreamingMarkdownRenderer("chat", undefined, true);
  for (const html of [renderMarkdownHtml(text, "chat", undefined, true), await renderHighlightedMarkdownHtml(text, "chat", undefined, true), renderer.render(text).map((block) => block.__html).join("")]) {
    const root = htmlRoot(html);
    expect(root.textContent).toContain("Text first.");
    const image = imageIn(root);
    expect(image.hasAttribute("src")).toBe(false);
    expect(deferredMarkdownImageSource(image)).toBe(remoteSource);
  }
  for (const html of [renderMarkdownHtml(text), renderMarkdownHtml(text, "surface", undefined, true)]) {
    expect(imageIn(htmlRoot(html)).getAttribute("src")).toBe(remoteSource);
  }
});

test.each(["javascript:alert(1)", "java&#x09;script:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:msgbox(1)"])("unsafe raw image sources cannot become deferred or expanded: %s", (unsafe) => {
  const html = renderMarkdownHtml(`<button data-openwork-image-preview><img src="${unsafe}" ${DEFERRED_IMAGE_SOURCE}="${source}" onerror="alert(1)"></button>`, "chat", undefined, true);
  const image = imageIn(htmlRoot(html));
  expect(image.hasAttribute("src")).toBe(false);
  expect(deferredMarkdownImageSource(image)).toBeUndefined();
  image.setAttribute(DEFERRED_IMAGE_SOURCE, unsafe.replace("&#x09;", "\t"));
  expect(deferredMarkdownImageSource(image)).toBeUndefined();
});

test("streaming keeps an activated settled image node and does not restart its load", async () => {
  const text = `Text.\n\n![Photo](${remoteSource})\n\nLater paragraph.\n\nTail`;
  const view = await mounted(<MarkdownBlock text={text} streaming deferImages />);
  const image = imageIn(view.container);
  near(image);
  await frame();
  await frame();
  image.dispatchEvent(new Event("load"));
  await view.render(<MarkdownBlock text={`${text} grows`} streaming deferImages />);
  expect(imageIn(view.container) === image).toBe(true);
  expect(image.getAttribute("src")).toBe(remoteSource);
  expect(image.dataset.transcriptImage).toBe("ready");
});

test("forged deferred attributes cannot supply or override a sanitized source", () => {
  const html = renderMarkdownHtml(`<button data-openwork-image-preview><img ${DEFERRED_IMAGE_SOURCE}="${source}"><img src="/safe.png" ${DEFERRED_IMAGE_SOURCE}="javascript:alert(1)"></button>`, "chat", undefined, true);
  const images = [...htmlRoot(html).querySelectorAll("img")];
  expect(deferredMarkdownImageSource(images[0]!)).toBeUndefined();
  expect(deferredMarkdownImageSource(images[1]!)).toBe("/safe.png");
});

test("markdown expands a queued preview immediately and session replacement cancels its work", async () => {
  const view = await mounted(<MarkdownBlock text={`Text first.\n\n![Photo](${remoteSource})`} deferImages />);
  const image = imageIn(view.container);
  expect(image.hasAttribute("src")).toBe(false);
  await act(async () => view.container.querySelector<HTMLButtonElement>("[data-openwork-image-preview]")?.click());
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(remoteSource);
  expect(image.hasAttribute("src")).toBe(false);
  await view.render(<MarkdownBlock key="other-session" text="Different session" deferImages />);
  await frame();
  await frame();
  expect(image.hasAttribute("src")).toBe(false);
  expect(document.querySelector('[role="dialog"] img')).toBeNull();
});
