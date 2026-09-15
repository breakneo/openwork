import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { manifestSchema, releaseReceiptSchema } from './manifest.ts';

// Schema-only input fixtures: never rendered or presented as capture evidence.
function input() {
  return {
    version: 1,
    sanitized: true,
    scenes: ['A', 'B'].map((member) => ({
      variant: 'D', member, kind: 'png', path: 'schema-only.png', actualCapture: true,
      durationSeconds: 10, startSeconds: 0, caption: 'Schema fixture', observed: 'Not capture evidence',
      hiddenApiSetup: true,
      release: { desktopVersion: '0.0.0-dev', desktopTag: 'dev', denBuildIdentity: 'dev',
        shippedRelease: false, evidencePath: 'schema-only.json' },
      assertion: { state: 'incomplete' },
    })),
  };
}

test('explicit unreleased A/B input is valid, without asserting media authenticity', () => {
  assert.equal(manifestSchema.safeParse(input()).success, true);
});

test('unreviewed template is deliberately rejected', async () => {
  const template = JSON.parse(await readFile(new URL('./manifest.template.json', import.meta.url), 'utf8'));
  assert.equal(manifestSchema.safeParse(template).success, false);
});

test('rejects absent release identity, fake release labels, missing B and excess duration', () => {
  const missing = input();
  missing.scenes[0].release.desktopVersion = '';
  assert.equal(manifestSchema.safeParse(missing).success, false);
  const mislabeled = input();
  mislabeled.scenes[0].release.shippedRelease = true;
  assert.equal(manifestSchema.safeParse(mislabeled).success, false);
  const oneMember = input();
  oneMember.scenes[1].member = 'A';
  assert.equal(manifestSchema.safeParse(oneMember).success, false);
  const long = input();
  for (const scene of long.scenes) scene.durationSeconds = 91;
  assert.equal(manifestSchema.safeParse(long).success, false);
});

test('rejects unsupported media, absent sanitization and passed assertions without evidence', () => {
  const clip = input();
  clip.scenes[0].kind = 'clip';
  assert.equal(manifestSchema.safeParse(clip).success, false);
  const unreviewed = input();
  unreviewed.sanitized = false;
  assert.equal(manifestSchema.safeParse(unreviewed).success, false);
  const unsupportedPass = input();
  unsupportedPass.scenes[0].assertion.state = 'passed';
  assert.equal(manifestSchema.safeParse(unsupportedPass).success, false);
  const url = input();
  url.scenes[0].caption = 'https://example.invalid';
  assert.equal(manifestSchema.safeParse(url).success, false);
});

test('release receipts require member and reject unknown fields', () => {
  const release = input().scenes[0].release;
  assert.equal(releaseReceiptSchema.safeParse(release).success, false);
  const { evidencePath: _evidencePath, ...identity } = release;
  assert.equal(releaseReceiptSchema.safeParse({ ...identity, member: 'A' }).success, true);
});
