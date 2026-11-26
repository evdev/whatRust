import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = vm.createContext({ location: { origin: "https://web.whatsapp.com" }, window: {} });
for (const script of ["calendar-chrono.js", "calendar-actions.js"]) {
  vm.runInContext(readFileSync(new URL(script, import.meta.url), "utf8"), page);
}
const { matches, sentDate } = page.window.__wrCalendarActions;
const sent = new Date(2026, 10, 26, 9);

function draft(text, lang = "en", reference) {
  const result = matches(text, lang, reference);
  assert.equal(result.found.length, 1, text);
  const event = result.found[0];
  assert.equal(text.slice(event.start, event.end), event.phrase);
  return { ...event.draft };
}

assert.deepEqual(draft("Meet December 4, 2026 at 3 PM"), {
  start: "2026-12-04T15:00:00", end: "2026-12-04T15:30:00", zone: "local"
});
assert.deepEqual(draft("2026-12-04T15:00+02:30"), {
  start: "2026-12-04T15:00:00", end: "2026-12-04T15:30:00", zone: "+02:30"
});
assert.equal(draft("December 4, 2026 at 15:00 UTC").zone, "+00:00");
assert.equal(draft("tomorrow at 3 PM", "en", sent).start, "2026-11-27T15:00:00");
assert.equal(draft("Friday from 3 to 4 PM", "en", sent).end, "2026-11-27T16:00:00");
assert.equal(draft("January 4 at 3 PM", "en", sent).start, "2027-01-04T15:00:00");
assert.equal(draft("amanhã às 15:00", "pt", sent).start, "2026-11-27T15:00:00");
assert.equal(draft("4 de dezembro de 2026 às 15:00 UTC", "pt").zone, "+00:00");
assert.equal(matches("tomorrow at 3 PM", "en").needsSent, true);
assert.equal(matches("tomorrow at 3 PM", "en").found.length, 0);
assert.equal(matches("January 4 at 3 PM", "en").found.length, 0);
for (const text of [
  "12/4 at 3 PM", "Friday at 3", "Friday at 3:00", "just at 3 PM", "December 4, 2026",
  "February 30, 2027 at 3 PM", "December 4, 2026 at 3 PM - 4", "December 4, 2026 at 3 PM PST",
]) {
  assert.equal(matches(text, "en", sent).found.length, 0, text);
}
assert.equal(matches("sexta-feira das 15:00 às 16:00", "pt", sent).found.length, 0);

let id = "true_42@g.us_FIXTURE";
page.window.WPP = { chat: { getMessageById: async (key) => {
  assert.equal(key, id);
  return { attributes: { t: sent.getTime() / 1000 } };
} } };
const body = { closest: () => ({ getAttribute: () => id }) };
assert.equal((await sentDate(body)).getTime(), sent.getTime());
const pending = sentDate(body);
id = "false_42@g.us_RECYCLED";
assert.equal(await pending, null, "metadata from a recycled message must not anchor another event");
console.log("calendar recognition and sent timestamps passed");
