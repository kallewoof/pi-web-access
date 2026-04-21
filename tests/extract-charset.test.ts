/**
 * Tests for charset detection in extractViaHttp.
 *
 * The bug: response.text() defaults to UTF-8 and ignores charset declared
 * only in a <meta> tag. Pages that omit charset from their HTTP Content-Type
 * header but declare it in HTML (common on older Japanese/European sites)
 * return garbled text.
 *
 * Each test starts a real local HTTP server so the behavior matches production
 * exactly — no mocking of fetch or internal functions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractContent } from "../extract.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, fn: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	try {
		await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

function serveBuffer(body: Buffer, contentType: string): Handler {
	return (_req, res) => {
		res.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length });
		res.end(body);
	};
}

// ---------------------------------------------------------------------------
// EUC-JP
// テスト: テ=0xA5,0xC6  ス=0xA5,0xB9  ト=0xA5,0xC8  (verified via TextDecoder)
// ---------------------------------------------------------------------------

const EUCJP_TESUTO = Buffer.from([0xa5, 0xc6, 0xa5, 0xb9, 0xa5, 0xc8]);

// Readability requires MIN_USEFUL_CONTENT (500 chars) of extracted markdown.
// Repeat a filler sentence enough times to exceed that threshold.
const FILLER = "This sentence exists to satisfy the minimum content length requirement. ".repeat(10);

function eucjpPage(charset: string): Buffer {
	return Buffer.concat([
		Buffer.from(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=${charset}"><title>Test</title></head><body><article><p>`),
		EUCJP_TESUTO,
		Buffer.from(` ${FILLER}</p></article></body></html>`),
	]);
}

test("EUC-JP: charset declared only in meta tag (no HTTP header charset)", async () => {
	await withServer(
		serveBuffer(eucjpPage("EUC-JP"), "text/html"),
		async (url) => {
			const result = await extractContent(url);
			assert.equal(result.error, null, `Unexpected error: ${result.error}`);
			assert.ok(
				result.content.includes("テスト"),
				`Expected "テスト" but got garbled text: ${JSON.stringify(result.content.slice(0, 200))}`,
			);
		},
	);
});

test("EUC-JP: charset declared in both HTTP header and meta tag", async () => {
	await withServer(
		serveBuffer(eucjpPage("EUC-JP"), "text/html; charset=EUC-JP"),
		async (url) => {
			const result = await extractContent(url);
			assert.equal(result.error, null, `Unexpected error: ${result.error}`);
			assert.ok(
				result.content.includes("テスト"),
				`Expected "テスト" but got: ${JSON.stringify(result.content.slice(0, 200))}`,
			);
		},
	);
});

// ---------------------------------------------------------------------------
// ISO-8859-1
// é = 0xE9 in Latin-1; as UTF-8 it is an invalid leading byte → U+FFFD
// ---------------------------------------------------------------------------

// Buffer.from("Caf\xe9") would encode é as UTF-8 (0xC3 0xA9) — that's wrong.
// We need the raw Latin-1 byte 0xE9 for é, so use explicit bytes.
const LATIN1_CAFE = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in ISO-8859-1 (é = 0xE9)

function latin1Page(charset: string): Buffer {
	return Buffer.concat([
		Buffer.from(`<!DOCTYPE html><html><head><meta charset="${charset}"><title>Test</title></head><body><article><p>`),
		LATIN1_CAFE,
		Buffer.from(` ${FILLER}</p></article></body></html>`),
	]);
}

test("ISO-8859-1: charset declared only in meta tag (no HTTP header charset)", async () => {
	await withServer(
		serveBuffer(latin1Page("ISO-8859-1"), "text/html"),
		async (url) => {
			const result = await extractContent(url);
			assert.equal(result.error, null, `Unexpected error: ${result.error}`);
			assert.ok(
				result.content.includes("Café"),
				`Expected "Café" but got garbled text: ${JSON.stringify(result.content.slice(0, 200))}`,
			);
		},
	);
});

// ---------------------------------------------------------------------------
// UTF-8 regression — must continue to work after the fix
// ---------------------------------------------------------------------------

test("UTF-8: charset in HTTP header (regression)", async () => {
	const body = Buffer.from(
		'<!DOCTYPE html><html><head><title>UTF-8 test</title></head>' +
		`<body><article><h1>UTF-8</h1><p>テスト — ${FILLER}</p></article></body></html>`,
	);
	await withServer(
		serveBuffer(body, "text/html; charset=utf-8"),
		async (url) => {
			const result = await extractContent(url);
			assert.equal(result.error, null, `Unexpected error: ${result.error}`);
			assert.ok(
				result.content.includes("テスト"),
				`Expected "テスト" but got: ${JSON.stringify(result.content.slice(0, 200))}`,
			);
		},
	);
});

test("UTF-8: no charset anywhere (should default to UTF-8)", async () => {
	const body = Buffer.from(
		'<!DOCTYPE html><html><head><title>No charset</title></head>' +
		`<body><article><h1>Plain ASCII</h1><p>Hello world. ${FILLER}</p></article></body></html>`,
	);
	await withServer(
		serveBuffer(body, "text/html"),
		async (url) => {
			const result = await extractContent(url);
			assert.equal(result.error, null, `Unexpected error: ${result.error}`);
			assert.ok(
				result.content.includes("Hello world"),
				`Expected "Hello world" but got: ${JSON.stringify(result.content.slice(0, 200))}`,
			);
		},
	);
});
