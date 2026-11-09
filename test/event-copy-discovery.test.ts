import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverEventCopies } from "../src/event-copy-discovery";
import type { FirestoreDocument } from "../src/index";

const now = "2026-10-12 12:00:00";
function product(id: string, fields: Record<string, string> = {}): FirestoreDocument {
  return {
    name: `projects/racket-id/databases/(default)/documents/IProducts/${id}`,
    createTime: "2026-10-12T10:00:00Z",
    fields: Object.fromEntries(Object.entries({
      type: "event", status: "instance", creator: "admin", group: "", ...fields,
    }).map(([key, stringValue]) => [key, { stringValue }])),
  };
}

function queries(roots: FirestoreDocument[], copies: FirestoreDocument[]) {
  const requestedParents: string[][] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const query = JSON.parse(String(init?.body)).structuredQuery;
    const filter = query.where.fieldFilter;
    expect(query.orderBy).toBeUndefined();
    expect(query.select.fields.some((f: { fieldPath: string }) => f.fieldPath === "date")).toBe(true);
    let documents = roots;
    if (filter.field.fieldPath === "copiedFrom") {
      const parents: string[] = filter.op === "EQUAL" ? [filter.value.stringValue]
        : filter.value.arrayValue.values.map((v: { stringValue: string }) => v.stringValue);
      expect(parents.length).toBeLessThanOrEqual(30);
      requestedParents.push(parents);
      documents = copies.filter((d) => parents.includes(d.fields!.copiedFrom!.stringValue!));
    } else {
      expect(filter).toEqual({ field: { fieldPath: "group" }, op: "EQUAL", value: { stringValue: "group" } });
    }
    return new Response(JSON.stringify(documents.map((document) => ({ document }))));
  });
  return requestedParents;
}

describe("copy discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds today's hidden copies from expired parents and keeps undated copies", async () => {
    queries([
      product("last-saturday", { group: "group", date: "2026-10-10 14:00:00" }),
      product("last-sunday", { group: "group", date: "2026-10-11 14:00:00" }),
    ], [
      product("new-saturday", { copiedFrom: "last-saturday", date: "2026-10-17 14:00:00" }),
      product("new-sunday", { copiedFrom: "last-sunday" }),
    ]);
    const result = await discoverEventCopies("group", [], now);
    expect(result.candidates).toEqual([
      expect.objectContaining({ id: "new-saturday", date: "2026-10-17 14:00:00" }),
      expect.objectContaining({ id: "new-sunday", date: undefined }),
    ]);
    expect(result.seeds.map((seed) => seed.id)).toEqual([
      "last-saturday", "last-sunday", "new-saturday", "new-sunday",
    ]);
  });

  it("excludes other creators, other groups, bookings, cancelled and expired events", async () => {
    queries([product("parent", { group: "group", date: "2026-10-10 14:00:00" })], [
      product("different-admin", { copiedFrom: "parent", creator: "other-admin" }),
      product("other-group", { copiedFrom: "parent", group: "another-group" }),
      product("booking", { copiedFrom: "parent", type: "booking" }),
      product("cancelled", { copiedFrom: "parent", status: "cancelled" }),
      product("past", { copiedFrom: "parent", date: "2026-10-11 14:00:00" }),
      product("malformed-date", { copiedFrom: "parent", date: "template" }),
    ]);
    const result = await discoverEventCopies("group", [], now);
    expect(result.candidates).toEqual([]);
    expect(result.seeds.map((seed) => seed.id)).not.toContain("different-admin");
    expect(result.seeds.map((seed) => seed.id)).not.toContain("other-group");
    expect(result.seeds.map((seed) => seed.id)).toContain("past");
  });

  it("uses retained parents and follows multiple copy generations without cycling", async () => {
    const parents = queries([], [
      product("second", { copiedFrom: "first", date: "2026-10-11 14:00:00" }),
      product("third", { copiedFrom: "second", date: "2026-10-17 14:00:00" }),
      product("first", { copiedFrom: "third", date: "2026-10-10 14:00:00" }),
    ]);
    const result = await discoverEventCopies("group", [{ id: "first", creator: "admin" }], now);
    expect(parents).toEqual([["first"], ["second"], ["third"]]);
    expect(result.candidates.map((event) => event.id)).toEqual(["third"]);
  });

  it("batches historical parents without a date or group filter on copies", async () => {
    const seeds = Array.from({ length: 61 }, (_, i) => ({ id: `parent-${i}`, creator: "admin" }));
    const parents = queries([], [product("child", { copiedFrom: "parent-60" })]);
    const result = await discoverEventCopies("group", seeds, now);
    expect(parents.map((batch) => batch.length)).toEqual([30, 30, 1, 1]);
    expect(result.candidates.map((event) => event.id)).toEqual(["child"]);
  });

  it("reports failed copy queries instead of replacing remembered state with empty results", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("[]"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const seeds = [{ id: "parent", creator: "admin" }];
    await expect(discoverEventCopies("group", seeds, now)).rejects.toThrow("503 unavailable");
    expect(seeds).toEqual([{ id: "parent", creator: "admin" }]);
  });

  it("keeps old templates as parents without continuously polling them until a date appears", async () => {
    const template = { ...product("template", { group: "group" }), createTime: "2026-01-01T00:00:00Z" };
    queries([template], []);
    const undated = await discoverEventCopies("group", [], now);
    expect(undated.candidates).toEqual([]);
    expect(undated.seeds).toEqual([{ id: "template", creator: "admin" }]);
    template.fields!.date = { stringValue: "2026-10-17 14:00:00" };
    const dated = await discoverEventCopies("group", undated.seeds, now);
    expect(dated.candidates.map((event) => event.id)).toEqual(["template"]);
  });
});
