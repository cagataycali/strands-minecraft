import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression: the passkey gate is position:fixed and #stage (the black 16:9
// video box) is positioned too and comes later in the DOM. Without an explicit
// z-index the stage painted over the gate on desktop-wide viewports — a black
// page with a broken image and no "Create passkey" button.
const page = readFileSync(new URL('../src/web/page.ts', import.meta.url), 'utf8');

test('the gate stacks above the stage', () => {
  const gate = page.match(/#gate\s*\{([^}]*)\}/)?.[1] ?? '';
  const z = Number(gate.match(/z-index:\s*(\d+)/)?.[1]);
  const stageFull = Number(page.match(/#stage\.full\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  assert.ok(gate.includes('position:fixed'), 'gate is fixed');
  assert.ok(z > stageFull, `gate z-index ${z} must beat #stage.full ${stageFull}`);
});

test('the gated video never shows a broken-image alt', () => {
  assert.match(page, /<img id="video" alt="">/);
});
