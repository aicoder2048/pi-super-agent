import assert from "node:assert/strict";
import test from "node:test";
import { checkUrl, isPublicAddress } from "../src/worker/net-guard.ts";

test("公网地址放行", () => {
	for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("本机、内网、链路本地、元数据和保留地址一律拒绝", () => {
	const blocked = [
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
		"198.18.0.1", "224.0.0.1", "255.255.255.255",
		"::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "64:ff9b::a9fe:a9fe",
	];
	for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
});

test("不是 IP 的字符串不算公网地址", () => {
	assert.equal(isPublicAddress("example.com"), false);
});

test("只接受 http 和 https 网址", () => {
	assert.equal(checkUrl("https://example.com/a?b=1").hostname, "example.com");
	assert.equal(checkUrl("http://example.com").protocol, "http:");
	for (const raw of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "不是网址"]) assert.throws(() => checkUrl(raw), raw);
});
