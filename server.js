require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Parsing pasted parkrun results ---

function timeToSeconds(t) {
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return null;
}

function secondsToTime(s) {
  s = Math.round(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  const mm = String(m).padStart(2,'0'), ss = String(sec).padStart(2,'0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Pulls a name, gender, and time out of one line of pasted parkrun results —
// works with plain names, or with full results rows that include age category and time.
// Pulls a name, gender, and time out of one line of pasted parkrun results —
// works with plain names, or with a single-line "Name AgeCat Time" format.
function parseResultLine(rawLine) {
  let line = rawLine.trim().replace(/^\d+\.?\s+/, ''); // strip leading position number
  const timeMatch = line.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
  const time = timeMatch ? timeMatch[0] : null;

  const ageCatMatch = line.match(/\b[SVJU]?([MW])\d{1,2}(-\d{1,2})?\b/);
  const wordMatch = !ageCatMatch ? line.match(/\b(Male|Female)\b/i) : null;
  let gender = null;
  let cutToken = null;
  if (ageCatMatch) {
    gender = ageCatMatch[1].toUpperCase() === 'M' ? 'M' : 'F';
    cutToken = ageCatMatch[0];
  } else if (wordMatch) {
    gender = wordMatch[0].toUpperCase().startsWith('M') ? 'M' : 'F';
    cutToken = wordMatch[0];
  }

  const cutIdx = cutToken ? line.indexOf(cutToken) : (timeMatch ? line.indexOf(timeMatch[0]) : -1);
  let name = cutIdx > 0 ? line.slice(0, cutIdx) : line;
  name = name.replace(/[,|]+$/, '').trim();

  return { name, gender, time, timeSeconds: time ? timeToSeconds(time) : null };
}

// Real parkrun copy-paste puts each field on its own line rather than one line per person:
//   12
//   David FRANKLIN
//   Male
//   VM35-39
//   20:53
// Some rows have fewer fields (no club, sometimes no gender/age-category at all — just
// name and time). A bare "Unknown" line means an unbarcoded finisher — no name to match
// against, but they still count toward starters/finishers. This parser walks the block
// using the position-number lines as record separators. It also skips the file's header
// block (parkrun name, date, event number, finisher/volunteer counts) so that noise never
// gets mistaken for a real result row.
function parseParkrunBlock(rawLines) {
  const lines = rawLines.map(l => l.trim()).filter(Boolean);

  // Skip everything up to and including the "Position ... parkrunner ... Time" header
  // row, if present — otherwise the finisher/volunteer counts above it get misread as data.
  const headerIdx = lines.findIndex(l => /position/i.test(l) && /parkrunner/i.test(l));
  const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

  const records = [];
  let i = startIdx;
  while (i < lines.length) {
    if (/^\d+$/.test(lines[i])) {
      i++;
      const fields = [];
      while (i < lines.length && !/^\d+$/.test(lines[i])) {
        fields.push(lines[i]);
        i++;
      }
      if (fields.length === 1 && fields[0].toLowerCase() === 'unknown') {
        records.push({ name: null, gender: null, time: null, timeSeconds: null, unknown: true });
      } else if (fields.length >= 2) {
        const name = fields[0];
        const last = fields[fields.length - 1];
        const validTime = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(last);
        // Gender only exists as its own field when there are 3+ fields (name, gender, ..., time)
        let gender = null;
        if (fields.length >= 3) {
          const genderWord = fields[1];
          gender = /^m/i.test(genderWord) ? 'M' : (/^f/i.test(genderWord) ? 'F' : null);
        }
        records.push({
          name,
          gender,
          time: validTime ? last : null,
          timeSeconds: validTime ? timeToSeconds(last) : null,
          unknown: false
        });
      }
    } else {
      i++; // stray line outside a record — skip it
    }
  }
  return records;
}

function looksLikeParkrunBlock(rawLines) {
  return rawLines.some(l => /^(male|female)$/i.test(l.trim()));
}

// Collapses any run of whitespace — including the non-breaking spaces that
// often sneak in from copy-pasted web content — into a single regular space,
// so visually-identical names always match regardless of source.
function normalizeName(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Locations ---

app.get('/api/locations', async (req, res) => {
  const { data, error } = await supabase
    .from('parkrun_locations')
    .select('*')
    .eq('active', true)
    .order('area', { ascending: true, nullsFirst: true })
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/locations', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase
    .from('parkrun_locations')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/locations/:id', async (req, res) => {
  const { big_turnout_threshold } = req.body;
  const { data, error } = await supabase
    .from('parkrun_locations')
    .update({ big_turnout_threshold: big_turnout_threshold === '' || big_turnout_threshold == null ? null : Number(big_turnout_threshold) })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Weekly entrants (paste-in) ---

// Shared by both the paste-in endpoint and the file-upload endpoint — takes raw text
// lines (however they got there) and does the parsing, saving, and stats/prize logic.
async function saveEntrantsFromLines(parkrun_location_id, draw_date, rawLinesInput) {
  const rawLines = rawLinesInput.map(n => n.trim()).filter(Boolean);
  if (rawLines.length === 0) return { status: 400, body: { error: 'no names provided' } };

  // If the file includes a header like "9/5/26 | #522", pull the event number out of it
  // automatically rather than making the admin type it in separately.
  let detectedEventNumber = null;
  const headerCutoff = rawLines.findIndex(l => /position/i.test(l) && /parkrunner/i.test(l));
  const headerLines = headerCutoff >= 0 ? rawLines.slice(0, headerCutoff) : rawLines.slice(0, 5);
  for (const l of headerLines) {
    const m = l.match(/#\s*(\d+)/);
    if (m) { detectedEventNumber = parseInt(m[1], 10); break; }
  }

  let allRecords, totalStarters;
  if (looksLikeParkrunBlock(rawLines)) {
    allRecords = parseParkrunBlock(rawLines);
    totalStarters = allRecords.length; // includes unnamed "Unknown" finishers
  } else {
    allRecords = rawLines.map(parseResultLine).filter(p => p.name);
    totalStarters = allRecords.length;
  }
  const parsedRows = allRecords.filter(p => p.name); // only named rows can be saved as entrants

  const rows = parsedRows.map(p => ({
    parkrun_location_id,
    draw_date,
    finisher_name: p.name
  }));

  const { data, error } = await supabase
    .from('weekly_entrants')
    .insert(rows)
    .select();
  if (error) return { status: 500, body: { error: error.message } };

  // Work out stats from whatever gender/time info was in the pasted lines
  const maleRow = parsedRows.find(p => p.gender === 'M' && p.time);
  const femaleRow = parsedRows.find(p => p.gender === 'F' && p.time);
  const timedRows = parsedRows.filter(p => p.timeSeconds != null); // "Unknown" finishers have no time, already excluded
  const avgSeconds = timedRows.length ? timedRows.reduce((sum, p) => sum + p.timeSeconds, 0) / timedRows.length : null;

  // Prize bumps to $50 if the male winner breaks 17:30, the female winner breaks 19:30,
  // or the average finishing time (excluding unbarcoded "Unknown" finishers) is under 30:00.
  const MALE_FAST_THRESHOLD = 17 * 60 + 30;
  const FEMALE_FAST_THRESHOLD = 19 * 60 + 30;
  const AVG_FAST_THRESHOLD = 30 * 60;
  const bigPrize =
    (maleRow && maleRow.timeSeconds < MALE_FAST_THRESHOLD) ||
    (femaleRow && femaleRow.timeSeconds < FEMALE_FAST_THRESHOLD) ||
    (avgSeconds != null && avgSeconds < AVG_FAST_THRESHOLD);

  // Prize bumps to $100 (overriding the $50 tier) if turnout — named finishers only,
  // "Unknown" unbarcoded runners don't count — exceeds this location's own threshold.
  const { data: location } = await supabase
    .from('parkrun_locations')
    .select('big_turnout_threshold')
    .eq('id', parkrun_location_id)
    .maybeSingle();
  const turnoutCount = parsedRows.length;
  const bigTurnout = location && location.big_turnout_threshold != null && turnoutCount > location.big_turnout_threshold;

  const prizeLabel = bigTurnout ? '$100 Woolies Gift Card' : (bigPrize ? '$50 Woolies Gift Card' : '$20 Woolies Gift Card');

  const statsUpdate = {
    parkrun_location_id,
    draw_date,
    starters: totalStarters,
    finishers: totalStarters,
    prize_label: prizeLabel
  };
  if (maleRow) { statsUpdate.male_winner_name = maleRow.name; statsUpdate.male_winner_time = maleRow.time; }
  if (femaleRow) { statsUpdate.female_winner_name = femaleRow.name; statsUpdate.female_winner_time = femaleRow.time; }
  if (avgSeconds) { statsUpdate.average_time = secondsToTime(avgSeconds); }
  if (detectedEventNumber != null) { statsUpdate.event_number = detectedEventNumber; }

  await supabase.from('draws').upsert(statsUpdate, { onConflict: 'parkrun_location_id,draw_date' });

  return {
    status: 200,
    body: {
      saved: data.length,
      entrants: data,
      stats: {
        starters: totalStarters,
        maleWinner: maleRow ? `${maleRow.name} (${maleRow.time})` : null,
        femaleWinner: femaleRow ? `${femaleRow.name} (${femaleRow.time})` : null,
        prizeLabel,
        averageTime: avgSeconds ? secondsToTime(avgSeconds) : null,
        eventNumber: detectedEventNumber
      }
    }
  };
}

app.post('/api/entrants', async (req, res) => {
  const { parkrun_location_id, draw_date, names } = req.body;
  if (!parkrun_location_id || !draw_date || !Array.isArray(names)) {
    return res.status(400).json({ error: 'parkrun_location_id, draw_date, and names[] are required' });
  }
  const result = await saveEntrantsFromLines(parkrun_location_id, draw_date, names);
  res.status(result.status).json(result.body);
});

app.post('/api/entrants/upload', upload.single('file'), async (req, res) => {
  const { parkrun_location_id, draw_date } = req.body;
  if (!parkrun_location_id || !draw_date) {
    return res.status(400).json({ error: 'parkrun_location_id and draw_date are required' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const text = req.file.buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const result = await saveEntrantsFromLines(parkrun_location_id, draw_date, lines);
  res.status(result.status).json(result.body);
});

app.get('/api/entrants', async (req, res) => {
  const { location_id, draw_date } = req.query;
  if (!location_id || !draw_date) return res.status(400).json({ error: 'location_id and draw_date are required' });
  const { data, error } = await supabase
    .from('weekly_entrants')
    .select('*')
    .eq('parkrun_location_id', location_id)
    .eq('draw_date', draw_date)
    .order('finisher_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/locations/bulk', async (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names[] is required' });
  const cleanNames = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  if (cleanNames.length === 0) return res.status(400).json({ error: 'No names provided' });

  const { data: existing, error: existingError } = await supabase.from('parkrun_locations').select('name');
  if (existingError) return res.status(500).json({ error: existingError.message });
  const existingLower = new Set(existing.map(l => l.name.toLowerCase()));

  const toInsert = cleanNames.filter(n => !existingLower.has(n.toLowerCase())).map(name => ({ name }));
  if (toInsert.length === 0) return res.json({ added: 0, skipped: cleanNames.length });

  const { data, error } = await supabase.from('parkrun_locations').insert(toInsert).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ added: data.length, skipped: cleanNames.length - data.length });
});

app.get('/api/draws/summary', async (req, res) => {
  const { draw_date } = req.query;
  if (!draw_date) return res.status(400).json({ error: 'draw_date is required' });

  const { data: draws, error } = await supabase
    .from('draws')
    .select('*, parkrun_locations(name)')
    .eq('draw_date', draw_date);
  if (error) return res.status(500).json({ error: error.message });

  const { data: entrants } = await supabase
    .from('weekly_entrants')
    .select('parkrun_location_id')
    .eq('draw_date', draw_date);
  const counts = {};
  for (const e of (entrants || [])) counts[e.parkrun_location_id] = (counts[e.parkrun_location_id] || 0) + 1;

  const summary = draws.map(d => ({
    location_id: d.parkrun_location_id,
    location_name: d.parkrun_locations ? d.parkrun_locations.name : 'Unknown',
    runners: counts[d.parkrun_location_id] || 0,
    sponsor_name: d.sponsor_name,
    sponsor_logo_url: d.sponsor_logo_url,
    prize_label: d.prize_label,
    prize_image_url: d.prize_image_url,
    draw_time: d.draw_time,
    status: d.status
  }));
  res.json(summary);
});

// --- Image upload (sponsor logos, prize images) ---

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const ext = req.file.originalname.split('.').pop();
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from('draw-assets')
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });
  if (error) return res.status(500).json({ error: error.message });

  const { data: publicUrlData } = supabase.storage.from('draw-assets').getPublicUrl(filename);
  res.json({ url: publicUrlData.publicUrl });
});

app.delete('/api/entrants/:id', async (req, res) => {
  const { error } = await supabase.from('weekly_entrants').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

app.delete('/api/entrants', async (req, res) => {
  const { location_id, draw_date } = req.query;
  if (!location_id || !draw_date) return res.status(400).json({ error: 'location_id and draw_date are required' });
  const { error } = await supabase
    .from('weekly_entrants')
    .delete()
    .eq('parkrun_location_id', location_id)
    .eq('draw_date', draw_date);
  if (error) return res.status(500).json({ error: error.message });

  // Wipe the stale auto-detected stats too — they came from the paste that just got cleared
  await supabase
    .from('draws')
    .update({
      starters: null, finishers: null,
      male_winner_name: null, male_winner_time: null,
      female_winner_name: null, female_winner_time: null,
      average_time: null, prize_label: null
    })
    .eq('parkrun_location_id', location_id)
    .eq('draw_date', draw_date);

  res.json({ cleared: true });
});

// --- Draws ---

// Admin sets up (or updates) today's draw for a location
app.post('/api/draws', async (req, res) => {
  const {
    parkrun_location_id, draw_date, sponsor_name, sponsor_logo_url, prize_label, prize_image_url, draw_time,
    starters, finishers, male_winner_name, male_winner_time, female_winner_name, female_winner_time,
    average_time, event_number
  } = req.body;
  if (!parkrun_location_id || !draw_date) {
    return res.status(400).json({ error: 'parkrun_location_id and draw_date are required' });
  }
  const { data, error } = await supabase
    .from('draws')
    .upsert(
      {
        parkrun_location_id, draw_date, sponsor_name, sponsor_logo_url, prize_label, prize_image_url, draw_time,
        starters, finishers, male_winner_name, male_winner_time, female_winner_name, female_winner_time,
        average_time, event_number
      },
      { onConflict: 'parkrun_location_id,draw_date' }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Public wheel page reads this to know sponsor/prize/draw_time and current status
app.get('/api/draws/current', async (req, res) => {
  const { location_id, draw_date } = req.query;
  if (!location_id || !draw_date) return res.status(400).json({ error: 'location_id and draw_date are required' });

  const { data: draw, error: drawError } = await supabase
    .from('draws')
    .select('*')
    .eq('parkrun_location_id', location_id)
    .eq('draw_date', draw_date)
    .maybeSingle();
  if (drawError) return res.status(500).json({ error: drawError.message });

  const { data: entrants, error: entrantsError } = await supabase
    .from('weekly_entrants')
    .select('id, finisher_name')
    .eq('parkrun_location_id', location_id)
    .eq('draw_date', draw_date);
  if (entrantsError) return res.status(500).json({ error: entrantsError.message });

  let winnerName = null;
  if (draw && draw.status === 'drawn' && draw.winner_entrant_id) {
    const { data: winnerEntrant } = await supabase
      .from('weekly_entrants')
      .select('finisher_name')
      .eq('id', draw.winner_entrant_id)
      .maybeSingle();
    if (winnerEntrant) {
      winnerName = winnerEntrant.finisher_name;
    }
  }

  res.json({ draw, entrants, winnerName });
});

// Called by the front-end the moment the countdown hits zero.
// Safe to call more than once (e.g. from multiple browsers) — only the first call actually picks a winner.
app.post('/api/draws/pick-winner', async (req, res) => {
  const { parkrun_location_id, draw_date } = req.body;
  if (!parkrun_location_id || !draw_date) {
    return res.status(400).json({ error: 'parkrun_location_id and draw_date are required' });
  }

  const { data: draw, error: drawError } = await supabase
    .from('draws')
    .select('*')
    .eq('parkrun_location_id', parkrun_location_id)
    .eq('draw_date', draw_date)
    .maybeSingle();
  if (drawError) return res.status(500).json({ error: drawError.message });
  if (!draw) return res.status(404).json({ error: 'No draw set up for this location/date yet' });

  if (draw.status === 'drawn') {
    const { data: entrant } = await supabase.from('weekly_entrants').select('finisher_name').eq('id', draw.winner_entrant_id).maybeSingle();
    if (entrant) {
      return res.json({ alreadyDrawn: true, winnerName: entrant.finisher_name });
    }
    // The winning entrant was deleted after the draw ran (e.g. entrants got cleared) —
    // rather than getting stuck forever pointing at nothing, reset and pick again below.
    await supabase.from('draws').update({ status: 'pending', winner_entrant_id: null, claim_deadline: null }).eq('id', draw.id);
    draw.status = 'pending';
  }

  const { data: entrants, error: entrantsError } = await supabase
    .from('weekly_entrants')
    .select('id, finisher_name')
    .eq('parkrun_location_id', parkrun_location_id)
    .eq('draw_date', draw_date);
  if (entrantsError) return res.status(500).json({ error: entrantsError.message });
  if (!entrants || entrants.length === 0) return res.status(400).json({ error: 'No entrants to draw from' });

  // Dedupe: if the same name appears twice in the pasted list, they only get one shot
  const seen = new Set();
  const uniqueEntrants = entrants.filter(e => {
    const key = e.finisher_name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const winner = uniqueEntrants[Math.floor(Math.random() * uniqueEntrants.length)];

  // Only updates if still pending — prevents a double-draw if two browsers trigger this at once
  const { data: updated, error: updateError } = await supabase
    .from('draws')
    .update({
      status: 'drawn',
      winner_entrant_id: winner.id,
      claim_deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    })
    .eq('id', draw.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (updateError) return res.status(500).json({ error: updateError.message });

  if (updated) {
    res.json({ alreadyDrawn: false, winnerName: winner.finisher_name });
  } else {
    // Someone else's request won the race — fetch what actually got saved
    const { data: freshDraw } = await supabase.from('draws').select('winner_entrant_id').eq('id', draw.id).single();
    const { data: entrant } = await supabase.from('weekly_entrants').select('finisher_name').eq('id', freshDraw.winner_entrant_id).maybeSingle();
    res.json({ alreadyDrawn: true, winnerName: entrant ? entrant.finisher_name : null });
  }
});

// Past draws for a location — proof for sponsors, and to mark prizes claimed
app.get('/api/draws/history', async (req, res) => {
  const { location_id } = req.query;
  if (!location_id) return res.status(400).json({ error: 'location_id is required' });
  const { data, error } = await supabase
    .from('draws')
    .select('*, weekly_entrants!draws_winner_entrant_id_fkey(finisher_name)')
    .eq('parkrun_location_id', location_id)
    .eq('status', 'drawn')
    .order('draw_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/draws/reset', async (req, res) => {
  const { parkrun_location_id, draw_date } = req.body;
  if (!parkrun_location_id || !draw_date) return res.status(400).json({ error: 'parkrun_location_id and draw_date are required' });
  const { data, error } = await supabase
    .from('draws')
    .update({ status: 'pending', winner_entrant_id: null, claimed: false })
    .eq('parkrun_location_id', parkrun_location_id)
    .eq('draw_date', draw_date)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/draws/:id', async (req, res) => {
  const { error } = await supabase.from('draws').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

app.post('/api/draws/claim', async (req, res) => {
  const { draw_id, claimed } = req.body;
  if (!draw_id) return res.status(400).json({ error: 'draw_id is required' });
  const { data, error } = await supabase
    .from('draws')
    .update({ claimed: claimed !== false })
    .eq('id', draw_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PARKnSPIN running on port ${PORT}`));
