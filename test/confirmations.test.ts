import { test } from "node:test";
import assert from "node:assert/strict";
import { webSourceLines as lines } from "./helpers.js";

// The design language's confirmation rule (docs/DESIGN-LANGUAGE.md, Confirming an action) over the
// pages' own source: no page asks with the browser's confirm, alert or prompt, and a popup (a modal
// dialog) asks only before removing something hoop can't bring back. test/pages.test.ts checks how
// each confirmation the pages open asks.
test("no page asks with the browser's confirm, alert or prompt: pages confirm in place", () => {
  assert.deepEqual(lines(/(?<![\w$.])(?:window\.|globalThis\.|self\.)?(?:confirm|alert|prompt)\s*\(/), []);
});

// The popups hoop has, each for removing what hoop can't bring back: Work's Remove session and
// Remove all ended, which share one dialog. A new one is listed here and in the design language.
const POPUPS = ["web/work.js"];

test("a popup asks only before removing what hoop can't bring back", () => {
  const files = [...new Set(lines(/\.showModal\s*\(|createElement\(\s*["']dialog["']|<dialog\b/).map((l) => l.split(":")[0]))];
  assert.deepEqual(
    files,
    POPUPS,
    "a modal dialog is only for removing what hoop can't bring back; confirm in place (docs/DESIGN-LANGUAGE.md, Confirming an action)",
  );
  assert.equal(lines(/\.showModal\s*\(/).length, 1, "Work opens one dialog, for removing ended sessions");
});
