import { z } from 'zod';

const safeText = z.string().trim().min(1).max(140).refine(
  (text) => [...text].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && !/https?:\/\/|bearer\s|(?:api[_-]?key|token|password|secret)\s*[:=]/i.test(text),
  'Use sanitized plain text without URLs, credentials, or control characters',
);

export const releaseSourcePin = {
  version: '0.18.46',
  tag: 'v0.18.46',
  sha: 'a0d6bd1de8debf4f09d22b8538e124b2ff45b339',
};

const releaseIdentity = z.object({
  buildKind: z.enum(['release-source', 'packaged-release', 'development']),
  desktopVersion: safeText.pipe(z.string().max(40)),
  desktopTag: safeText.pipe(z.string().max(64)),
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/, 'Supply the full release source commit SHA'),
  lane: safeText.pipe(z.string().max(80)),
  denBuildIdentity: safeText.pipe(z.string().max(80)),
});

type ReleaseIdentity = z.infer<typeof releaseIdentity>;

function checkRelease(identity: ReleaseIdentity, ctx: z.RefinementCtx) {
  if (identity.buildKind === 'development') return;
  const labels = `${identity.desktopVersion} ${identity.desktopTag} ${identity.denBuildIdentity}`;
  if (/dev|unreleased|dirty|unknown|placeholder|replace_with/i.test(labels)
    || (identity.buildKind === 'packaged-release' && /local|release.source/i.test(labels))) {
    ctx.addIssue({ code: 'custom', message: 'Development or unknown builds cannot be labeled releases; source builds are not packaged binaries' });
  }
  if (identity.buildKind === 'release-source'
    && (identity.desktopVersion !== releaseSourcePin.version
      || identity.desktopTag !== releaseSourcePin.tag || identity.releaseSha !== releaseSourcePin.sha)) {
    ctx.addIssue({ code: 'custom', message: 'release-source must pin the approved v0.18.46 version, tag and full commit SHA' });
  }
}

export function buildLabel(kind: ReleaseIdentity['buildKind']) {
  if (kind === 'release-source') return 'release-source, not packaged binary';
  if (kind === 'packaged-release') return 'packaged-release, binary receipt supplied';
  return 'development, not a release';
}

export function journeyBuildKind(identities: ReleaseIdentity[]) {
  return [...new Set(identities.map((identity) => identity.buildKind))].sort().join('-and-');
}

export const releaseReceiptSchema = releaseIdentity.extend({ member: z.enum(['A', 'B']) }).strict().superRefine(checkRelease);

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
    release: releaseIdentity.extend({ evidencePath: z.string().trim().min(1) }).strict().superRefine(checkRelease),
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
