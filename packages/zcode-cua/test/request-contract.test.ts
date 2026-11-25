import { expect, it } from "vitest";
import { validateRequest } from "../src/domain/request.js";
import { truncateUtf16 } from "../src/domain/frame.js";

// 给模型看的工具文档（apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md）是请求契约；
// 校验器原先比它窄，SDK 透传的字符串和弦、"a11y"、repeat 等在派发前就被拒绝。
const base = { app_ref: { pid: 700 } },
  target = { type: "element", index: 0 };

it("accepts the documented modifier chords and normalizes them for the native side", () => {
  const click = (modifiers: unknown) => validateRequest("left_click", { ...base, target, modifiers });
  expect(click("cmd+Shift").modifiers).toEqual(["cmd", "shift"]);
  expect(click(" cmd + shift ").modifiers).toEqual(["cmd", "shift"]);
  expect(click("").modifiers).toEqual([]);
  expect(click(["Cmd", "alt"]).modifiers).toEqual(["cmd", "alt"]);
  expect(click(undefined).modifiers).toBeUndefined();
  for (const invalid of ["cmd+cmd", "cmd+shift+alt+ctrl+meta", "hyper+x", "cmd+", 7, ["cmd", 1]]) {
    expect(() => click(invalid), String(invalid)).toThrow(/Invalid modifiers/);
  }
});

it("accepts the documented strategy spelling and rejects anything else", () => {
  const scroll = (strategy: unknown) =>
    validateRequest("scroll", { ...base, target, scroll_direction: "down", strategy });
  expect(scroll("a11y").strategy).toBe("ax");
  expect(scroll("ax").strategy).toBe("ax");
  expect(scroll("auto").strategy).toBe("auto");
  expect(scroll("event").strategy).toBe("event");
  expect(scroll(undefined).strategy).toBeUndefined();
  for (const invalid of ["a11y!", "events", "AX", 1, true]) {
    expect(() => scroll(invalid), String(invalid)).toThrow(/Unsupported strategy/);
  }
});

it("accepts the documented optional arguments and keeps their bounds", () => {
  expect(() => validateRequest("key", { ...base, text: "enter", repeat: 3 })).not.toThrow();
  expect(() => validateRequest("key", { ...base, text: "enter", repeat: 100 })).not.toThrow();
  for (const invalid of [0, -1, 1.5, 101, "3"]) {
    expect(() => validateRequest("key", { ...base, text: "enter", repeat: invalid })).toThrow(
      /repeat must be 1..100/,
    );
  }
  expect(() => validateRequest("select_text", { ...base, target })).not.toThrow();
  expect(validateRequest("select_text", { ...base, target }).text_range).toBeUndefined();
  expect(validateRequest("select_text", { ...base, target, text_range: [1, 2] }).text_range).toEqual([
    1, 2,
  ]);
  for (const invalid of [[1], [1, 2, 3], [-1, 2], [0, 1.5], "0,2"]) {
    expect(() =>
      validateRequest("select_text", { ...base, target, text_range: invalid }),
    ).toThrow(/text_range must be \[start,length\] integers/);
  }
  expect(() => validateRequest("type", { ...base, text: "hi", target, strategy: "a11y" })).not.toThrow();
  // type 的 target 可选：缺省时输入到当前焦点。
  expect(validateRequest("type", { ...base, text: "hi" }).target).toBeUndefined();
  expect(() => validateRequest("type", { ...base, text: "hi", target: { type: "element" } })).toThrow(
    /Element target needs a nonnegative integer index/,
  );
  expect(() =>
    validateRequest("set_value", { ...base, target, value: "x", strategy: "auto" }),
  ).not.toThrow();
  expect(() => validateRequest("type", { ...base, text: "hi", repeat: 2 })).toThrow(/unknown key/);
});

it("truncateUtf16 never leaves half of a surrogate pair", () => {
  expect(truncateUtf16("ab", 5)).toBe("ab");
  expect(truncateUtf16("a🌟b", 4)).toBe("a🌟b");
  // "🌟" 占两个码元：上限落在它中间时整个字符一起去掉；落在它之后则完整保留。
  expect(truncateUtf16("a🌟b", 3)).toBe("a🌟");
  expect(truncateUtf16("a🌟b", 2)).toBe("a");
  expect(truncateUtf16("a🌟b", 1)).toBe("a");
  expect(truncateUtf16("ab", 1)).toBe("a");
  expect(truncateUtf16("ab", 0)).toBe("");
  expect(truncateUtf16("a🌟b".repeat(20_000), 48_000).isWellFormed()).toBe(true);
});
