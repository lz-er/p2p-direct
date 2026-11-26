import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractLiveSplitTokens,
  mergeListEditorItems,
  removeListEditorItem,
  splitAllListTokens,
} from "../storage.js";

describe("Settings interactive auto-split list editor helpers", () => {
  it("extractLiveSplitTokens splits completed tokens on comma/semicolon while keeping unfinished trailing text", () => {
    assert.deepEqual(extractLiveSplitTokens("Hades 2"), {
      ready: [],
      remainder: "Hades 2",
    });
    assert.deepEqual(extractLiveSplitTokens("Hades 2, "), {
      ready: ["Hades 2"],
      remainder: "",
    });
    assert.deepEqual(extractLiveSplitTokens("London, Paris, Rom"), {
      ready: ["London", "Paris"],
      remainder: "Rom",
    });
    assert.deepEqual(extractLiveSplitTokens("A; B\nC"), {
      ready: ["A", "B"],
      remainder: "C",
    });
  });

  it("splitAllListTokens splits full pasted or submitted comma/semicolon/newline lists cleanly", () => {
    assert.deepEqual(splitAllListTokens("  Berlin, , Tokyo ; New York \n London  "), [
      "Berlin",
      "Tokyo",
      "New York",
      "London",
    ]);
  });

  it("mergeListEditorItems appends unique items, deduplicates case-insensitively, and enforces max limit", () => {
    const res = mergeListEditorItems(["Berlin", "Tokyo"], ["tokyo", "London", "Paris", "Rome"], {
      max: 4,
      maxLen: 48,
      dedupe: true,
    });
    assert.deepEqual(res.items, ["Berlin", "Tokyo", "London", "Paris"]);
    assert.equal(res.addedCount, 2);
    assert.equal(res.skippedDupes, 1);
    assert.equal(res.hitMax, true);
  });

  it("removeListEditorItem removes by index and enforces minimum item count", () => {
    const r1 = removeListEditorItem(["A", "B", "C"], 1, { min: 2 });
    assert.deepEqual(r1.items, ["A", "C"]);
    assert.equal(r1.removed, true);
    assert.equal(r1.hitMin, false);

    const r2 = removeListEditorItem(["A", "C"], 0, { min: 2 });
    assert.deepEqual(r2.items, ["A", "C"]);
    assert.equal(r2.removed, false);
    assert.equal(r2.hitMin, true);
  });
});
