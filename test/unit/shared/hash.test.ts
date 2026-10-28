import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../../../src/shared/hash";

describe("TST-U-06 canonicalJson and sha256Hex", () => {
	test("TST-U-06 sorts keys lexicographically, without spaces", () => {
		expect(canonicalJson({ b: 1, a: "x", c: true })).toBe(
			'{"a":"x","b":1,"c":true}',
		);
	});

	test("TST-U-06 sorts keys recursively", () => {
		expect(canonicalJson({ z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] })).toBe(
			'{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}',
		);
	});

	test("TST-U-06 is invariant to key insertion order", () => {
		expect(canonicalJson({ a: 1, b: { c: 1, d: 2 } })).toBe(
			canonicalJson({ b: { d: 2, c: 1 }, a: 1 }),
		);
	});

	test("TST-U-06 keeps array order", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	test("TST-U-06 strings use the JSON.stringify escape and keep non-ASCII as is", () => {
		expect(canonicalJson({ k: 'a"b\\c\n' })).toBe('{"k":"a\\"b\\\\c\\n"}');
		expect(canonicalJson({ k: "é" })).toBe('{"k":"é"}');
	});

	test("TST-U-06 omits undefined properties like JSON.stringify", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	test("TST-U-06 serializes null and primitives", () => {
		expect(canonicalJson(null)).toBe("null");
		expect(canonicalJson("s")).toBe('"s"');
		expect(canonicalJson({ a: null })).toBe('{"a":null}');
	});

	test("TST-U-06 refuses values JSON cannot represent", () => {
		expect(() => canonicalJson(undefined)).toThrow(TypeError);
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
		expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
	});

	test("TST-U-06 sha256Hex matches the known vector, lowercase hex", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	test("TST-U-06 sha256Hex hashes the UTF-8 bytes", () => {
		expect(sha256Hex("é")).toBe(
			"4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
		);
	});
});
