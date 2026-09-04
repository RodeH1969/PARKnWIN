function pad(n) { return String(n).padStart(2, '0'); }

function localISO(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// The parkrun itself always runs Saturday; results get pasted in and drawn the
// next day (Sunday). This returns the Saturday that a given moment "belongs to":
// - On Saturday: today.
// - On Sunday: yesterday (the Saturday that just happened) — NOT next Saturday.
// - Monday to Friday: the coming Saturday, for admins prepping ahead of the weekend.
// Used everywhere instead of "today" so setup and viewing always agree on which draw we mean.
function getRelevantSaturday() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
  if (day === 0) {
    d.setDate(d.getDate() - 1); // Sunday -> yesterday's Saturday
  } else {
    const diff = (6 - day + 7) % 7; // Mon-Sat -> this coming (or today's) Saturday
    d.setDate(d.getDate() + diff);
  }
  return localISO(d);
}
