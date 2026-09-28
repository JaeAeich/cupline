// Words for how long the string is and how long things take to travel it. Pure, so it's testable.
import { shoutSeconds } from "../../shared/geo";
import type { Delivery } from "../../shared/protocol";

const kilometres = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "kilometer",
  maximumFractionDigits: 0,
});
const seconds = new Intl.NumberFormat("en", { style: "unit", unit: "second", maximumFractionDigits: 1 });
// Newer than the rest of Intl (Chrome 129, Firefox 136); a missing nicety must never break the page.
const duration = "DurationFormat" in Intl ? new Intl.DurationFormat("en", { style: "narrow" }) : null;

export const describeDistance = (km: number) =>
  km === 0 ? "Right next door" : `About ${kilometres.format(km)}`;

/** The string is the real distance between two people; the time is what the AI in the middle took. */
export function travelTale(km: number, ms: Delivery["ms"]) {
  const took = seconds.format(((ms.stt ?? 0) + ms.llm + ms.tts) / 1000);
  if (km === 0) return `They're right next door. The string took ${took}.`;
  return `${kilometres.format(km)} of string. A shout would take ${describeDuration(shoutSeconds(km))} to get here; your words took ${took}.`;
}

/** "5h 31m": whole minutes and hours are plenty for a shout crossing an ocean. */
function describeDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return seconds.format(totalSeconds);
  return duration?.format({ hours, minutes }) ?? `${hours}h ${minutes}m`;
}
