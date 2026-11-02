import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { webSourceLines, webSources } from "./helpers.js";

// The design language's confirmation rule (docs/DESIGN-LANGUAGE.md, Confirming an action) over the
// pages' own source (web/*.js and web/index.html): no page asks with the browser's confirm, alert or
// prompt, and a popup (a dialog or a popover) asks only before removing something hoop can't bring
// back. test/pages.test.ts checks how each confirmation the pages open asks, and that the actions
// that can be reversed or sent again don't ask.
//
// Known limits: the source check can't see every alias. It misses a function passed on without its
// window (`setTimeout(alert)`), destructuring other than a plain `const { confirm } = window`, and
// handlers written as inline `onclick` text. The pages test's `page.on("dialog")` guard, which fails
// whenever a page opens one, is the backstop for those.
const RULE = "(docs/DESIGN-LANGUAGE.md, Confirming an action)";

/** The names that reach the browser's window, as `window.confirm`, `top.alert` or `document.defaultView.prompt`. */
const GLOBALS = new Set(["window", "globalThis", "self", "top", "parent", "frames", "defaultView"]);
const NATIVE = new Set(["confirm", "alert", "prompt"]);

/** A file's script: a .js file whole, an .html file's inline scripts with the rest blanked, its line breaks kept. */
const scriptOf = ({ name, text }: { name: string; text: string }) =>
  name.endsWith(".js") ? text : text.replace(/(?:^|<\/script>)[\s\S]*?(?:<script\b[^>]*>|$)/g, (m) => m.replace(/[^\n]/g, ""));

/** Whether an expression is the window: `window`, `top`, `document.defaultView`, `window?.parent`. */
function isWindow(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return GLOBALS.has(e.text);
  // `node.parent` is a tree's member, not the window: only the window's own `parent` or `top` is.
  if (!ts.isPropertyAccessExpression(e)) return false;
  return e.name.text === "defaultView" || (GLOBALS.has(e.name.text) && isWindow(e.expression));
}

/** The text of a string key, as in `window["confirm"]`, or undefined. */
const keyOf = (e: ts.Expression) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined);

/** Whether a node uses the browser's confirm, alert or prompt: a bare call, the window's property in any form, or a destructuring of it. */
function usesNative(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) return NATIVE.has(node.expression.text);
  if (ts.isPropertyAccessExpression(node)) return NATIVE.has(node.name.text) && isWindow(node.expression);
  if (ts.isElementAccessExpression(node)) return NATIVE.has(keyOf(node.argumentExpression) ?? "") && isWindow(node.expression);
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isWindow(node.initializer))
    return node.name.elements.some((b) => NATIVE.has((b.propertyName ?? b.name).getText()));
  return false;
}

/** Each place in the pages' scripts that uses the browser's confirm, alert or prompt, as "web/file.js:line: text". */
function nativeDialogs(files = webSources()): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.name, scriptOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (usesNative(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${file.name}:${line + 1}: ${node.getText().slice(0, 100)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test("no page asks with the browser's confirm, alert or prompt: pages confirm in place", () => {
  assert.deepEqual(nativeDialogs(), [], `confirm in place ${RULE}`);
});

test("the check finds the browser's dialogs in every form, and not in strings or comments", () => {
  const js = (text: string) => [{ name: "web/x.js", text }];
  for (const use of [
    'confirm("Sure?")',
    'window.confirm("Sure?")',
    'top.confirm("Sure?")',
    'parent.alert("Done")',
    'window?.confirm("Sure?")',
    'window["confirm"]("Sure?")',
    "const ask = window.confirm;",
    "const { prompt } = globalThis;",
    'document.defaultView.alert("Done")',
  ])
    assert.equal(nativeDialogs(js(use)).length, 1, use);
  for (const fine of [
    'const s = "Re-confirm (twice)";',
    "// confirm(x)",
    "/* alert(x) */",
    "work.confirm(x)",
    "node.parent.confirm(x)",
    "const t = `alert(x)`;",
  ])
    assert.deepEqual(nativeDialogs(js(fine)), [], fine);
  const html = [{ name: "web/x.html", text: '<p>alert(</p>\n<script type="module">\n  window.alert("x");\n</script>\n' }];
  assert.deepEqual(nativeDialogs(html), ["web/x.html:3: window.alert"]);
  assert.equal(nativeDialogs(js('window.parent.confirm("Sure?")')).length, 1, "the window's own parent");
});

// The popups hoop has, each for removing what hoop can't bring back: Work's Remove session and
// Remove all ended, which share one dialog. A new one is listed here and in the design language.
const POPUPS = ["web/work.js"];

/** A dialog or a popover: opening one, creating one, or its markup. */
const POPUP =
  /\.showModal\s*\(|\.show\s*\(\s*\)|\.(?:show|toggle)Popover\s*\(|createElement\(\s*["']dialog["']|<dialog\b|\spopover(?:\s*=|[\s>])|setAttribute\(\s*["']popover["']|\.popover\s*=/;

test("a popup asks only before removing what hoop can't bring back", () => {
  const files = [...new Set(webSourceLines(POPUP).map((l) => l.split(":")[0]))];
  assert.deepEqual(files, POPUPS, `a dialog or popover is only for removing what hoop can't bring back; confirm in place ${RULE}`);
  assert.equal(webSourceLines(/\.showModal\s*\(/).length, 1, "Work opens one dialog, for removing ended sessions");
});

test("the popup check finds dialogs and popovers", () => {
  for (const use of [
    "d.showModal()",
    "d.show()",
    "el.showPopover()",
    'createElement("dialog")',
    "<dialog open>",
    '<div popover="auto">',
    "<div popover>",
    'el.setAttribute("popover", "")',
    'el.popover = "auto"',
  ])
    assert.ok(POPUP.test(use), use);
  for (const fine of ['<div class="popover" id="finishPop">', 'querySelector(".popover")']) assert.ok(!POPUP.test(fine), fine);
});
