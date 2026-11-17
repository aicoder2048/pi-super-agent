import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import chain from "../../chain/index.ts";
import vol from "../../vol/index.ts";
import strategy from "../index.ts";
import record from "../../record/index.ts";
import ledger from "../../ledger/index.ts";
import fills from "../../../feeds/fills/index.ts";
import iv from "../../../feeds/iv/index.ts";
import watch from "../../../feeds/watch/index.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
globalThis.fetch = async () => { throw new Error("P2 test forbids network"); };

const tools: Record<string, (q: any) => unknown> = { chain, vol, strategy, record, ledger };
for (const [name, run] of Object.entries(tools)) {
  for (const c of json(`tools/${name}/cases.json`)) {
    test(`${name}: ${c.name}`, () => assert.partialDeepStrictEqual(run(c.input), c.expect));
  }
}
const feeds: Record<string, (q: any) => any> = { fills, iv, watch };
for (const [name, run] of Object.entries(feeds)) {
  for (const filename of readdirSync(resolve(root, `feeds/${name}/fixtures`)).filter(f => f.endsWith(".json"))) {
    test(`${name} fixture ${filename}: visible NOT_IMPLEMENTED, no rows/notices/cursor advance`, () => {
      const { input, responses } = json(`feeds/${name}/fixtures/${filename}`);
      assert.deepEqual(responses, {});
      const out = run(input);
      assert.deepEqual(out.records, []);
      assert.deepEqual(out.notices ?? [], []);
      assert.equal(out.cursor, input.cursor);
      assert.equal(out.problem.id, `option-ta-${name}-not-implemented`);
      assert.match(out.problem.text, /NOT_IMPLEMENTED/);
      assert.match(out.problem.text, /待P3/);
      assert.doesNotMatch(out.problem.text, /QRST|LMNO|exb\.desk|APPLE|IWM260320/);
    });
  }
  test(`${name}: empty input is NOT_IMPLEMENTED, not successful no-op`, () => {
    assert.match(run({}).problem.text, /NOT_IMPLEMENTED/);
  });
}
test("four fictional drafts are future parser acceptance material, not live expected rows", () => {
  const names = ["cc-open-put-close-unfilled", "csp-partial-underlyings", "mixed-with-stock-and-working", "cp1252-executed-at-nested"];
  for (const name of names) {
    const draft = json(`feeds/fills/mail-samples/${name}.expected.json`);
    assert.ok(draft.fills.length > 0);
    const { input } = json(`feeds/fills/fixtures/${name}.json`);
    assert.equal(input.items[0].from.address, "exb.desk@example.net");
    assert.equal(typeof input.items[0].body, "string");
    assert.equal(typeof input.items[0].html, "string");
    assert.ok(Buffer.byteLength(input.items[0].html) <= 256 * 1024);
    assert.deepEqual(fills(input).records, []);
    assert.ok(readFileSync(resolve(root, `feeds/fills/mail-samples/${name}.eml`)).length > 0);
  }
});
test("record valid basic input still forbids writing and leaves dedup unimplemented", () => {
  const c = json("tools/record/cases.json")[0];
  const result = record(c.input);
  const data = JSON.parse(result.payload);
  assert.equal(result.status, "VALIDATED_ONLY");
  assert.equal(data.may_write, false);
  assert.equal(data.dedup, "NOT_IMPLEMENTED");
});
test("ledger does not invent a zero result or report an empty database", () => {
  const result = ledger({ view: "chain" });
  assert.equal(result.status, "NOT_IMPLEMENTED");
  assert.deepEqual(JSON.parse(result.payload), { view: "chain", database: "NOT_READ" });
});
