import { describe, expect, it } from "vitest";
import { Clip, Prefs, Typed } from "../shared/protocol";
import { operatorPrompt, renderPrompt } from "../src/worker/prompts";

describe("protocol", () => {
  it("accepts known prefs and drops unknown query params", () => {
    const parsed = Prefs.parse({ lang: "ja", mode: "telegram", voice: "wobbly", _pk: "abc" });
    expect(parsed).toEqual({ lang: "ja", mode: "telegram", voice: "wobbly" });
  });

  it("rejects languages MeloTTS cannot speak", () => {
    expect(Prefs.safeParse({ lang: "hi", mode: "faithful", voice: "mid" }).success).toBe(false);
  });

  it("caps clips and typed messages", () => {
    expect(Clip.safeParse("a".repeat(1_400_001)).success).toBe(false);
    expect(Typed.safeParse("   ").success).toBe(false);
    expect(Typed.safeParse("x".repeat(501)).success).toBe(false);
  });
});

describe("prompts", () => {
  it("names the listener's language, in Simplified script for Chinese", () => {
    expect(renderPrompt("ja", "faithful")).toContain("Write only in Japanese");
    expect(renderPrompt("zh", "gist")).toContain("Simplified Chinese");
  });

  it("keeps the Operator honest about being an AI", () => {
    expect(operatorPrompt("en", "faithful")).toContain("You are an AI and say so if asked");
  });
});
