import { useLayoutEffect, useRef } from "react";

const MAX_ACTIVE = 4;
const LOAD_TIMEOUT_MS = 15_000;

type Job = {
  image: HTMLImageElement;
  src: string;
  near: boolean;
  frames: number;
  active: boolean;
  release?: () => void;
  unobserve?: () => void;
};

const schedulers = new WeakMap<Document, ReturnType<typeof createScheduler>>();

function createScheduler(document: Document) {
  const view = document.defaultView;
  const jobs = new Map<HTMLImageElement, Job>();
  let active = 0;
  let frame: number | undefined;
  const observers = new Map<Element | null, { observer: IntersectionObserver; targets: Set<HTMLImageElement> }>();

  function observe(job: Job) {
    if (!view || typeof view.IntersectionObserver !== "function") {
      job.near = true;
      schedule();
      return;
    }
    const root = job.image.closest("[data-thread-scroll]");
    let shared = observers.get(root);
    if (!shared) {
      const targets = new Set<HTMLImageElement>();
      const observer = new view.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLImageElement) || !targets.has(entry.target)) continue;
          const pending = jobs.get(entry.target);
          if (!pending || pending.active) continue;
          pending.near = entry.isIntersecting;
          if (!pending.near) pending.frames = 0;
        }
        schedule();
      }, { root, rootMargin: "320px 0px" });
      shared = { observer, targets };
      observers.set(root, shared);
    }
    const { observer, targets } = shared;
    targets.add(job.image);
    observer.observe(job.image);
    job.unobserve = () => {
      if (!targets.delete(job.image)) return;
      observer.unobserve(job.image);
      if (!targets.size) {
        observer.disconnect();
        if (observers.get(root)?.observer === observer) observers.delete(root);
      }
    };
  }

  function idle() {
    if (jobs.size) return;
    if (frame !== undefined) view?.cancelAnimationFrame(frame);
    frame = undefined;
    if (schedulers.get(document) === scheduler) schedulers.delete(document);
  }

  function start(job: Job) {
    job.active = true;
    active++;
    job.unobserve?.();
    let timer: number | undefined;
    const release = () => {
      job.image.removeEventListener("load", loaded);
      job.image.removeEventListener("error", failed);
      view?.clearTimeout(timer);
      if (jobs.get(job.image) !== job) return;
      jobs.delete(job.image);
      active--;
      idle();
      queueMicrotask(drain);
    };
    const loaded = () => {
      job.image.dataset.transcriptImage = "ready";
      release();
    };
    const failed = () => {
      job.image.dataset.transcriptImage = "error";
      release();
    };
    job.release = release;
    job.image.addEventListener("load", loaded);
    job.image.addEventListener("error", failed);
    timer = view?.setTimeout(() => {
      job.image.removeAttribute("src");
      failed();
    }, LOAD_TIMEOUT_MS);
    job.image.dataset.transcriptImage = "loading";
    job.image.src = job.src;
    queueMicrotask(() => {
      if (jobs.get(job.image) !== job || !job.image.complete) return;
      if (job.image.naturalWidth > 0) loaded();
    });
  }

  function drain() {
    for (const job of jobs.values()) {
      if (active >= MAX_ACTIVE) break;
      if (!job.active && job.near && job.frames >= 2) start(job);
    }
  }

  function schedule() {
    if (!view || frame !== undefined) return;
    if (![...jobs.values()].some((job) => !job.active && job.near && job.frames < 2)) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      for (const job of jobs.values()) {
        if (!job.active && job.near) job.frames++;
      }
      drain();
      schedule();
    });
  }

  const scheduler = {
    add(image: HTMLImageElement, src: string) {
      const job: Job = { image, src, near: false, frames: 0, active: false };
      jobs.set(image, job);
      image.removeAttribute("src");
      image.dataset.transcriptImage = "queued";
      observe(job);
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        job.unobserve?.();
        if (jobs.get(image) === job) {
          if (job.active) job.release?.();
          else jobs.delete(image);
        }
        image.removeAttribute("src");
        delete image.dataset.transcriptImage;
        idle();
      };
    },
  };
  return scheduler;
}

export function deferTranscriptImage(image: HTMLImageElement, src: string) {
  const document = image.ownerDocument;
  let scheduler = schedulers.get(document);
  if (!scheduler) {
    scheduler = createScheduler(document);
    schedulers.set(document, scheduler);
  }
  return scheduler.add(image, src);
}

export function useTranscriptImage(src: string | undefined, defer: boolean) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const image = ref.current;
    if (!image || !src) return;
    if (!defer) {
      if (image.getAttribute("src") !== src) image.src = src;
      return;
    }
    return deferTranscriptImage(image, src);
  }, [src, defer]);
  return ref;
}
