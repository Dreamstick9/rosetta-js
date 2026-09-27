import assert from "node:assert/strict";
import { Composer } from "../src/tui/composer.js";
import { countChanges, diffLines } from "../src/tui/diff.js";
import { KeyParser } from "../src/tui/keys.js";
import { sanitize, span, textWidth, wrapSpans } from "../src/tui/text.js";

const wrapped = wrapSpans([span("hello world this is a wrapping test")], 12, [span("• ")], [span("  ")]);
assert.ok(wrapped.every((line) => textWidth(line.map((part) => part.text).join("")) <= 12));
assert.equal(textWidth("你好"), 4);
assert.equal(sanitize("a\x1b[31mb\x1b[0m\tc\r\nx\ry"), "ab    c\ny");

assert.deepEqual(countChanges(diffLines("a\nb\nc\n", "a\nB\nc\nd\n")), { added: 2, removed: 1 });

const keys = new KeyParser().feed("\x1b[A\x1b[13;2u\x1b[99;5u\x1b[200~x\ny\x1b[201~\x1b");
assert.deepEqual(keys.map((key) => key.name), ["up", "enter", "c", "paste", "escape"]);
assert.equal(keys[1].shift, true);
assert.equal(keys[2].ctrl, true);

const composer = new Composer();
composer.insert("see ");
composer.insertPaste("x".repeat(1500));
assert.equal(composer.text, "see [Pasted Content 1500 chars]");
assert.equal(composer.take().text, `see ${"x".repeat(1500)}`);
assert.ok(composer.historyPrevious());
composer.backspace();
assert.equal(composer.text, "see ");

console.log("tui checks OK");
