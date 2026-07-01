import assert from "node:assert/strict";
import test from "node:test";

import { decodeDdgHref, postProcess, resolveProxyOption } from "./ddg.js";

// --- decodeDdgHref ---

test("decodeDdgHref decodes the uddg redirect param", () => {
  const href =
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.anthropic.com%2Fnews&rut=abc123";
  assert.equal(decodeDdgHref(href), "https://www.anthropic.com/news");
});

test("decodeDdgHref passes through an absolute http(s) url", () => {
  assert.equal(decodeDdgHref("https://example.com/x"), "https://example.com/x");
  assert.equal(decodeDdgHref("http://example.com/y"), "http://example.com/y");
});

test("decodeDdgHref returns null for empty / relative / undecodable", () => {
  assert.equal(decodeDdgHref(""), null);
  assert.equal(decodeDdgHref("/settings"), null);
  assert.equal(decodeDdgHref("//duckduckgo.com/l/?uddg=%E0%A4%A"), null); // malformed %-escape
});

// --- postProcess ---

const row = (title: string, href: string, snippet = "s") => ({ title, href, snippet });

test("postProcess drops DDG ad rows (y.js redirector)", () => {
  const out = postProcess(
    [
      row("Ad", "//duckduckgo.com/y.js?ad_domain=udemy.com"),
      row("Real", "//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.com%2Fa"),
    ],
    {},
  );
  assert.deepEqual(
    out.map((r) => r.url),
    ["https://real.example.com/a"],
  );
});

test("postProcess drops empty-title and undecodable rows", () => {
  const out = postProcess(
    [
      row("", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.example.com"),
      row("Rel", "/relative-only"),
      row("Good", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.example.com"),
    ],
    {},
  );
  assert.deepEqual(
    out.map((r) => r.title),
    ["Good"],
  );
});

test("postProcess honors allowed_domains (subdomains included)", () => {
  const out = postProcess(
    [
      row("A", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.keep.com%2Fa"),
      row("B", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.com%2Fb"),
    ],
    { allowedDomains: ["keep.com"] },
  );
  assert.deepEqual(
    out.map((r) => r.url),
    ["https://www.keep.com/a"],
  );
});

test("postProcess honors blocked_domains", () => {
  const out = postProcess(
    [
      row("A", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fspam.com%2Fa"),
      row("B", "//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.com%2Fb"),
    ],
    { blockedDomains: ["spam.com"] },
  );
  assert.deepEqual(
    out.map((r) => r.url),
    ["https://ok.com/b"],
  );
});

test("postProcess caps to maxResults", () => {
  const raw = Array.from({ length: 10 }, (_, i) =>
    row(`T${i}`, `//duckduckgo.com/l/?uddg=https%3A%2F%2Fe${i}.example.com`),
  );
  assert.equal(postProcess(raw, { maxResults: 3 }).length, 3);
});

// --- resolveProxyOption ---

test("resolveProxyOption returns undefined for empty / 'none'", () => {
  assert.equal(resolveProxyOption("", ""), undefined);
  assert.equal(resolveProxyOption("none", "x"), undefined);
  assert.equal(resolveProxyOption("NONE", ""), undefined);
});

test("resolveProxyOption builds server + bypass", () => {
  assert.deepEqual(resolveProxyOption("http://127.0.0.1:7890/", ""), {
    server: "http://127.0.0.1:7890/",
  });
  assert.deepEqual(
    resolveProxyOption("http://127.0.0.1:7890/", "localhost, 127.0.0.0/8 ,::1"),
    { server: "http://127.0.0.1:7890/", bypass: "localhost,127.0.0.0/8,::1" },
  );
});
