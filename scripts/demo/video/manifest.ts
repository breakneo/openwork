import { z } from 'zod';

const safeText = z.string().trim().min(1).max(140).refine(
  (text) => [...text].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && !/https?:\/\/|bearer\s|(?:api[_-]?key|token|password|secret)\s*[:=]/i.test(text),
  'Use sanitized plain text without URLs, credentials, or control characters',
);

const releaseIdentity = z.object({
  desktopVersion: safeText.pipe(z.string().max(40)),
  desktopTag: safeText.pipe(z.string().max(64)),
  denBuildIdentity: safeText.pipe(z.string().max(80)),
  shippedRelease: z.boolean(),
});

export const releaseReceiptSchema = releaseIdentity.extend({ member: z.enum(['A', 'B']) }).strict();

export const manifestSchema = z.object({
  version: z.literal(1),
  sanitized: z.literal(true),
  scenes: z.array(z.object({
    variant: z.enum(['C', 'D']),
    member: z.enum(['A', 'B']),
    kind: z.enum(['clip', 'png']),
    path: z.string().min(1),
    actualCapture: z.literal(true),
    durationSeconds: z.number().min(1).max(180),
    startSeconds: z.number().min(0).default(0),
    caption: safeText,
    observed: safeText,
    hiddenApiSetup: z.boolean(),
    release: releaseIdentity.extend({ evidencePath: z.string().trim().min(1) }).strict(),
    assertion: z.object({
      state: z.enum(['not-run', 'incomplete', 'failed', 'passed']),
      evidencePath: z.string().min(1).optional(),
    }).strict(),
  }).strict()).min(2).max(120),
}).strict().superRefine((manifest, ctx) => {
  for (const variant of ['C', 'D']) {
    const scenes = manifest.scenes.filter((scene) => scene.variant === variant);
    if (!scenes.length) continue;
    if (!scenes.some((scene) => scene.member === 'A') || !scenes.some((scene) => scene.member === 'B')) {
      ctx.addIssue({ code: 'custom', message: `${variant} must show actual desktop media for BOTH A and B` });
    }
    if (scenes.reduce((sum, scene) => sum + Math.round(scene.durationSeconds * 30), 0) > 5400) {
      ctx.addIssue({ code: 'custom', message: `${variant} exceeds the 180-second cap` });
    }
  }
  for (const scene of manifest.scenes) {
    if (scene.release.shippedRelease && /dev|unreleased|dirty|local|unknown|placeholder|replace_with/i.test(
      `${scene.release.desktopVersion} ${scene.release.desktopTag} ${scene.release.denBuildIdentity}`,
    )) {
      ctx.addIssue({ code: 'custom', message: 'Development or unknown builds cannot be labeled shipped releases' });
    }
    if (scene.variant === 'D' && scene.kind !== 'png') {
      ctx.addIssue({ code: 'custom', message: 'D requires actual PNG captures rendered with Remotion' });
    }
    if (scene.kind === 'png' && scene.startSeconds !== 0) {
      ctx.addIssue({ code: 'custom', message: 'PNG startSeconds must be zero' });
    }
    if (scene.assertion.state === 'passed' && !scene.assertion.evidencePath) {
      ctx.addIssue({ code: 'custom', message: 'Reported passed assertions require a local evidence file; footage alone is not proof' });
    }
  }
});

export type Manifest = z.infer<typeof manifestSchema>;
export type RenderScene = Omit<Manifest['scenes'][number], 'path' | 'assertion' | 'release'> & {
  release: Omit<Manifest['scenes'][number]['release'], 'evidencePath'>;
  asset: string;
  frames: number;
  assertion: { state: Manifest['scenes'][number]['assertion']['state'] };
};
export type VideoProps = { scenes: RenderScene[] };
