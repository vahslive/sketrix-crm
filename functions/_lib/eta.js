// Straight-line distance in miles between two lat/lng points.
export function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Assumptions — tune these as you get a feel for real drive times.
const AVG_SPEED_MPH = 25;   // rough in-city average, accounts for lights/turns
const BUFFER_MINUTES = 5;   // parking, unloading tools, etc.
const WINDOW_MINUTES = 15;  // +/- this many minutes around the estimate

// Arizona does not observe daylight saving time, so the offset from UTC is
// always -7 hours — no DST branching needed.
const PHOENIX_UTC_OFFSET_HOURS = -7;

function formatPhoenixTime(date) {
  const phoenix = new Date(date.getTime() + PHOENIX_UTC_OFFSET_HOURS * 3600 * 1000);
  let hours = phoenix.getUTCHours();
  const minutes = phoenix.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = minutes.toString().padStart(2, '0');
  return { hours, mm, ampm, text: `${hours}:${mm} ${ampm}` };
}

// Returns a human-readable arrival window string, e.g. "9:00-9:30 AM".
export function estimateArrivalWindow(masterLat, masterLng, destLat, destLng) {
  const miles = milesBetween(masterLat, masterLng, destLat, destLng);
  const driveMinutes = (miles / AVG_SPEED_MPH) * 60 + BUFFER_MINUTES;

  const now = new Date();
  const startDate = new Date(now.getTime() + Math.max(0, driveMinutes - WINDOW_MINUTES) * 60000);
  const endDate = new Date(now.getTime() + (driveMinutes + WINDOW_MINUTES) * 60000);

  const start = formatPhoenixTime(startDate);
  const end = formatPhoenixTime(endDate);

  // Only show AM/PM once if both ends match (e.g. "9:00-9:30 AM")
  const text = start.ampm === end.ampm
    ? `${start.hours}:${start.mm}-${end.hours}:${end.mm} ${end.ampm}`
    : `${start.text}-${end.text}`;

  return { miles: Math.round(miles * 10) / 10, driveMinutes: Math.round(driveMinutes), text };
}
