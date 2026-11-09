// Turn a captured points table and playoff summary into the JSON the site reads.
function buildStandingsDoc(pointsTable, playoffs) {
  const found = !!(playoffs && playoffs.playoffsFound);
  const pending = !!(playoffs && playoffs.fixturesPending);
  const outcomes = (playoffs && playoffs.teams) || {};
  const teams = {};
  const logos = {};
  for (const g of (pointsTable && pointsTable.groups) || []) {
    const rows = g.rows || [];
    for (const row of rows) {
      const prev = teams[row.team];
      if (prev && (prev.played > row.played || (prev.played === row.played && prev.position <= row.position))) continue;
      if (row.logo) logos[row.team] = row.logo;
      let playoff = null;
      const oc = outcomes[row.team];
      if (oc && oc.result) playoff = { text: oc.result, muted: false };
      else if (found && !pending) playoff = { text: 'Did not qualify', muted: true };
      teams[row.team] = {
        position: row.position,
        of: rows.length,
        group: g.group || '',
        played: row.played,
        won: row.won,
        lost: row.lost,
        nr: row.nr,
        points: row.points,
        nrr: row.nrr,
        logo: row.logo || null,
        playoff
      };
    }
  }
  return {
    series: pointsTable.series,
    playoffs: { found, pending },
    teams,
    logos
  };
}

// DDCL cups follow the group table, not who won the match. Places 1–2 are the Gold Cup. Places 3–4 are the Silver Cup.
function ddclFinalCup(pointsTable, teamIds) {
  const pos = {};
  for (const g of (pointsTable && pointsTable.groups) || []) {
    for (const row of g.rows || []) if (row.teamId != null && row.position != null) pos[row.teamId] = row.position;
  }
  const places = (teamIds || []).map(id => pos[id]).filter(p => p != null);
  if (places.length < 2) return null;
  if (places.every(p => p <= 2)) return 'Gold Cup';
  if (places.every(p => p >= 3 && p <= 4)) return 'Silver Cup';
  return null;
}

module.exports = { buildStandingsDoc, ddclFinalCup };
