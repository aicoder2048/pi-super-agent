import assert from "node:assert/strict";
import test from "node:test";
import { LookupCache } from "../../src/sources/market/cache.ts";

function setup(max = 200) {
	const clock = { t: 1_000, now() { return this.t; } };
	let loads = 0;
	const load = (value: string) => async () => {
		loads++;
		return value;
	};
	return { clock, cache: new LookupCache(clock, max), load, loads: () => loads };
}

test("缓存：TTL 内命中并报告年龄，到 TTL 时重新取", async () => {
	const s = setup();
	assert.deepEqual(await s.cache.get("k", 60_000, s.load("a")), { value: "a", via: "fetch", ageMs: 0 });
	s.clock.t += 59_999;
	assert.deepEqual(await s.cache.get("k", 60_000, s.load("b")), { value: "a", via: "cache", ageMs: 59_999 });
	s.clock.t += 1;
	assert.deepEqual(await s.cache.get("k", 60_000, s.load("c")), { value: "c", via: "fetch", ageMs: 0 });
	assert.equal(s.loads(), 2);
});

test("缓存：同一个键在请求进行中再来，合用那一次请求和结果", async () => {
	const s = setup();
	let release!: (v: string) => void;
	const slow = () => new Promise<string>((resolve) => { release = resolve; });
	const all = Promise.all([1, 2, 3, 4, 5].map(() => s.cache.get("k", 60_000, slow)));
	release("x");
	const results = await all;
	assert.deepEqual(results.map((r) => [r.value, r.via]), [["x", "fetch"], ["x", "shared"], ["x", "shared"], ["x", "shared"], ["x", "shared"]]);
});

test("缓存：失败不进缓存，下次重新取；进行中的失败也传给合用者", async () => {
	const s = setup();
	const fail = async () => { throw new Error("boom"); };
	await assert.rejects(Promise.all([s.cache.get("k", 60_000, fail), s.cache.get("k", 60_000, fail)]), /boom/);
	assert.equal((await s.cache.get("k", 60_000, s.load("ok"))).via, "fetch");
});

test("缓存：最多 max 条，超出时淘汰最久没用的（LRU）", async () => {
	const s = setup(2);
	await s.cache.get("a", 60_000, s.load("a"));
	await s.cache.get("b", 60_000, s.load("b"));
	await s.cache.get("a", 60_000, s.load("a2"));
	await s.cache.get("c", 60_000, s.load("c"));
	assert.equal((await s.cache.get("a", 60_000, s.load("a3"))).via, "cache");
	assert.equal((await s.cache.get("b", 60_000, s.load("b2"))).value, "b2");
	assert.equal(s.cache.size, 2);
});
