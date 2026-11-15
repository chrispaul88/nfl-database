// Red-zone / end-zone usage per player per week, from nflverse play-by-play.
//
//   GET /api/redzone?season=2026[&through=9]
//   -> { season, through, players: { "<gsis id>": { name, team, weeks: { "3": { rzTgt, ezTgt, rzCar, glCar, tgt, car } } } } }
//
// Counted per play, regular season only:
//   rzTgt  target with the ball inside the 20
//   ezTgt  target thrown into the end zone (air yards reach the goal line)
//   rzCar  carry from inside the 20
//   glCar  carry from inside the 5
//   tgt / car  all targets / carries (so shares can be computed client-side)
//
// The gz file is ~10 MB and streamed line by line; one request a day per
// region is plenty, so the response is cached for a day.

import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";

const SRC = (season) => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

// Tiny CSV field splitter that respects quotes (nflverse quotes play
// descriptions, which contain commas).
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (v) => { if (v == null || v === "" || v === "NA") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function buildRedzone(season, through) {
  const res = await fetch(SRC(season), { redirect: "follow" });
  if (!res.ok) throw new Error(`nflverse ${res.status}`);
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(res.body).pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

  let col = null;
  const players = {};
  const bump = (id, name, team, week, key) => {
    if (!id) return;
    const P = (players[id] ??= { name, team, weeks: {} });
    P.team = team || P.team; if (name) P.name = name;
    const W = (P.weeks[week] ??= { rzTgt: 0, ezTgt: 0, rzCar: 0, glCar: 0, tgt: 0, car: 0 });
    W[key]++;
  };
  let maxWeek = 0;
  for await (const line of rl) {
    if (!col) {
      col = {};
      splitCsv(line).forEach((h, i) => { col[h] = i; });
      continue;
    }
    if (!line) continue;
    const f = splitCsv(line);
    if (f[col.season_type] !== "REG") continue;
    const week = num(f[col.week]); if (week == null) continue;
    if (through && week > through) continue;
    if (f[col.two_point_attempt] === "1") continue;
    const team = f[col.posteam];
    const yl = num(f[col.yardline_100]);
    if (f[col.pass_attempt] === "1" && f[col.receiver_player_id]) {
      const id = f[col.receiver_player_id], nm = f[col.receiver_player_name];
      bump(id, nm, team, week, "tgt");
      if (yl != null && yl <= 20) bump(id, nm, team, week, "rzTgt");
      const ay = num(f[col.air_yards]);
      if (yl != null && ay != null && ay >= yl) bump(id, nm, team, week, "ezTgt");
    }
    if (f[col.rush_attempt] === "1" && f[col.rusher_player_id] && f[col.qb_scramble] !== "1") {
      const id = f[col.rusher_player_id], nm = f[col.rusher_player_name];
      bump(id, nm, team, week, "car");
      if (yl != null && yl <= 20) bump(id, nm, team, week, "rzCar");
      if (yl != null && yl <= 5) bump(id, nm, team, week, "glCar");
    }
    if (week > maxWeek) maxWeek = week;
  }
  return { season, through: through || maxWeek, players };
}

export default async function handler(req, res) {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    const through = Number(req.query.through) || null;
    const out = await buildRedzone(season, through);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=43200");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
