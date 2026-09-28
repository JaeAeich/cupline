import { describe, expect, it } from "vitest";
import { distanceKm, shoutSeconds } from "../shared/geo";

const london = { lat: 51.5072, lon: -0.1276 };
const tokyo = { lat: 35.6762, lon: 139.6503 };

describe("distanceKm", () => {
  it("measures the great-circle distance, rounded to 50 km", () => {
    expect(distanceKm(london, tokyo)).toBe(9550); // ≈ 9,560 km
  });

  it("calls anything under 50 km next door, so nobody is pinpointed", () => {
    expect(distanceKm(london, { lat: 51.6, lon: -0.2 })).toBe(0);
  });
});

describe("shoutSeconds", () => {
  it("uses the speed of sound in air", () => {
    expect(shoutSeconds(0.343)).toBe(1);
    expect(Math.round(shoutSeconds(9550) / 3600)).toBe(8); // London → Tokyo: about 8 hours
  });
});

describe("travelTale", async () => {
  const { describeDistance, travelTale } = await import("../src/client/travel");

  it("compares a shout with what the string took", () => {
    expect(travelTale(9550, { stt: 1200, llm: 900, tts: 800 })).toBe(
      "9,550 km of string. A shout would take 7h 44m to get here; your words took 2.9 sec.",
    );
  });

  it("keeps it short when they're close", () => {
    expect(travelTale(0, { llm: 1000, tts: 500 })).toBe("They're right next door. The string took 1.5 sec.");
    expect(describeDistance(0)).toBe("Right next door");
    expect(describeDistance(1200)).toBe("About 1,200 km");
  });
});
