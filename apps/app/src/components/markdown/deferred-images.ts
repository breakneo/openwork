import { deferTranscriptImage } from "../chat/transcript-image-loading";

export const DEFERRED_IMAGE_SOURCE = "data-openwork-deferred-image-src";

export function markdownImageSource(image: HTMLImageElement, deferred = false) {
  const src = image.getAttribute(deferred ? DEFERRED_IMAGE_SOURCE : "src")?.trim();
  if (!src || /[\u0000-\u001f\u007f]/.test(src)) return undefined;
  try {
    const protocol = new URL(src, image.ownerDocument.baseURI).protocol;
    const imageData = protocol === "data:" && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon)(?:;|,)/i.test(src);
    if (!["http:", "https:", "file:", "blob:"].includes(protocol) && !imageData) return undefined;
    return src.replace(/[<>"'`]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return undefined;
  }
}

export function deferredMarkdownImageSource(image: HTMLImageElement) {
  return markdownImageSource(image, true);
}

export function deferSanitizedMarkdownImages(html: string) {
  if (typeof document === "undefined" || !html.includes("data-openwork-image-preview")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll(`[${DEFERRED_IMAGE_SOURCE}]`)) {
    node.removeAttribute(DEFERRED_IMAGE_SOURCE);
  }
  for (const image of template.content.querySelectorAll<HTMLImageElement>("[data-openwork-image-preview] img")) {
    const src = image.getAttribute("src");
    image.removeAttribute("src");
    image.removeAttribute("srcset");
    if (src) image.setAttribute(DEFERRED_IMAGE_SOURCE, src);
    image.setAttribute("loading", "eager");
    image.classList.add("[&:not([src])]:invisible");
    image.style.maxWidth = "100%";
    const preview = image.closest<HTMLElement>("[data-openwork-image-preview]");
    if (preview) {
      preview.classList.remove("inline-block");
      preview.classList.add("inline-flex", "items-center", "justify-center", "bg-muted", "rounded-lg");
      preview.style.width = "280px";
      preview.style.height = "160px";
    }
  }
  return template.innerHTML;
}

export function syncDeferredMarkdownImages(root: HTMLElement, cleanups: Map<HTMLImageElement, () => void>) {
  for (const [image, cleanup] of cleanups) {
    if (root.contains(image)) continue;
    cleanup();
    cleanups.delete(image);
  }
  for (const image of root.querySelectorAll<HTMLImageElement>(`img[${DEFERRED_IMAGE_SOURCE}]`)) {
    if (cleanups.has(image)) continue;
    const src = deferredMarkdownImageSource(image);
    if (src) cleanups.set(image, deferTranscriptImage(image, src));
  }
}
