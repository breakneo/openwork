import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeed } from './core.mjs';
import { privateOutputPath, writePrivateOutput, parseQueueArgs } from './convert.mjs';

/** JSON embedded in HTML must never contain a literal HTML opening delimiter. */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Single-pass literal substitution: payload dollar signs/marker text stay data. */
export function buildHtml(feed, template, coreSource, uiSource) {
  const normalized = validateFeed(feed);
  for (const [label, source] of [['template', template], ['core', coreSource], ['UI', uiSource]]) {
    if (typeof source !== 'string' || source.length > 10_000_000) throw new Error(`${label} source must be bounded text`);
  }
  const markers = ['__FEED_JSON__', '/*__CORE__*/', '/*__UI__*/'];
  for (const marker of markers) {
    if (template.split(marker).length !== 2) throw new Error(`Template must contain exactly one ${marker} marker`);
  }
  const core = coreSource.replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '');
  if (/^\s*(?:import|export)\s/m.test(core)) throw new Error('Core contains unsupported module syntax');
  if (/<\/script\b/i.test(core) || /<\/script\b/i.test(uiSource)) throw new Error('Static code contains an HTML script terminator');
  const replacements = new Map([
    ['__FEED_JSON__', scriptJson(normalized)],
    ['/*__CORE__*/', core],
    ['/*__UI__*/', uiSource],
  ]);
  return template.replace(/__FEED_JSON__|\/\*__CORE__\*\/|\/\*__UI__\*\//g, (marker) => replacements.get(marker));
}
function main(args) {
  const options = parseQueueArgs(args);
  const directory = dirname(fileURLToPath(import.meta.url));
  const inputs = [options.input, ...['template.html', 'core.mjs', 'ui.js'].map((file) => join(directory, file))];
  privateOutputPath(options.output, inputs, options);
  const html = buildHtml(JSON.parse(readFileSync(options.input, 'utf8')), readFileSync(inputs[1], 'utf8'), readFileSync(inputs[2], 'utf8'), readFileSync(inputs[3], 'utf8'));
  const target = writePrivateOutput(options.output, html, inputs, options);
  console.log(`Built one offline HTML file; no external actions. Private output: ${target}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
