import type { InsightEnrichment } from './spotify'
import type { InsightResult, RankingMetric } from '../types'

interface ReportData {
  startDate: string
  endDate: string
  granularity: string
  metric: RankingMetric
  theme: 'light' | 'dark'
  result: InsightResult
  enrichment: InsightEnrichment | null
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatHours(ms: number) {
  return `${(ms / 3_600_000).toFixed(1)} hr`
}

function formatMetric(item: { plays: number; totalMs: number }, metric: RankingMetric) {
  return metric === 'plays' ? `${item.plays.toLocaleString()} plays` : formatHours(item.totalMs)
}

export function interactiveReportHtml(data: ReportData) {
  const serialized = JSON.stringify(data).replaceAll('<', '\\u003c')
  const generatedAt = new Date().toLocaleString()
  const summary = data.result.summary
  const artistMaximum = data.metric === 'plays'
    ? data.result.artistTotals[0]?.plays || 1
    : data.result.artistTotals[0]?.totalMs || 1

  const spotifySection = data.enrichment ? `
    <section id="spotify" class="section">
      <div class="taste">
        <article><span class="label">Recent novelty</span><strong>${data.enrichment.discoveryPercent}%</strong></article>
        <article><span class="label">Archive overlap</span><strong>${data.enrichment.archiveOverlapPercent}%</strong></article>
        <article><span class="label">Recent contexts</span><strong>${data.enrichment.recentContexts.length}</strong></article>
      </div>
      <div class="split">
        <article class="panel">
          <h2>Spotify top artists</h2><p>Long-term affinity from Spotify.</p>
          <table><tbody>${(data.enrichment.ranges.find((item) => item.key === 'long_term')?.artists || []).map((artist, index) => `<tr><td>${String(index + 1).padStart(2, '0')}</td><td><a href="${escapeHtml(artist.url)}" target="_blank" rel="noreferrer">${escapeHtml(artist.name)}</a></td></tr>`).join('')}</tbody></table>
        </article>
        <article class="panel">
          <h2>Recent pulse</h2><p>Latest plays available through Spotify.</p>
          <table><tbody>${data.enrichment.recent.map((track) => `<tr><td>${escapeHtml(track.name)}</td><td>${escapeHtml(track.artist)}</td></tr>`).join('')}</tbody></table>
        </article>
      </div>
      ${data.enrichment.notices.length ? `<div class="notice">${data.enrichment.notices.map(escapeHtml).join(' · ')}</div>` : ''}
    </section>` : ''

  return `<!doctype html>
<html lang="en" data-theme="${data.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Playback Atlas · ${escapeHtml(data.startDate)} to ${escapeHtml(data.endDate)}</title>
  <style>
    :root {
      font-family: Arial, sans-serif;
      color-scheme: light;
      --ink: #181b19;
      --paper: #f3f0e9;
      --surface: #f8f5ee;
      --surface-muted: #e8e4da;
      --surface-control: #dedbd2;
      --surface-hover: #ffffff;
      --line: #c9c5ba;
      --muted: #686a65;
      --acid: #c9f64a;
      --orange: #ff6b3d;
      --acid-soft: #e3f5aa;
      --focus: #456000;
    }
    :root[data-theme='dark'] {
      color-scheme: dark;
      --ink: #f0ede4;
      --paper: #191a1b;
      --surface: #222426;
      --surface-muted: #292b2d;
      --surface-control: #343638;
      --surface-hover: #2d2f31;
      --line: #5a5d60;
      --muted: #b6b9b1;
      --acid: #c9f64a;
      --orange: #ff8058;
      --acid-soft: #3c4625;
      --focus: #e3ff91;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper); color: var(--ink); }
    body { max-width: 1180px; margin: 0 auto; padding: 36px; background: var(--paper); color: var(--ink); }
    header { border-bottom: 1px solid var(--ink); padding-bottom: 24px; margin-bottom: 22px; display: flex; justify-content: space-between; gap: 20px; align-items: end; }
    h1, h2, h3, p { margin: 0; color: var(--ink); }
    h1 { font-size: clamp(34px, 6vw, 72px); letter-spacing: -.07em; line-height: .9; }
    h1 em { font-family: Georgia, serif; font-weight: 400; }
    a { color: var(--ink); text-decoration-color: var(--acid); text-decoration-thickness: 2px; text-underline-offset: 2px; }
    a:hover, a:focus { color: var(--focus); outline-color: var(--acid); }
    .meta, .label, button, small, .tooltip { font: 11px/1.4 monospace; text-transform: uppercase; letter-spacing: .05em; }
    .meta { color: var(--muted); text-align: right; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
    .actions button { border: 1px solid var(--ink); background: var(--paper); color: var(--ink); padding: 9px 12px; cursor: pointer; }
    .actions button.active, .actions button:hover, .actions button:focus { background: var(--ink); color: var(--paper); outline: 2px solid var(--acid); outline-offset: 1px; }
    .section { display: none; }
    .section.active { display: block; }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--ink); margin-bottom: 22px; background: var(--surface); }
    .card { padding: 16px; border-right: 1px solid var(--ink); min-height: 105px; display: flex; flex-direction: column; justify-content: space-between; color: var(--ink); }
    .card:last-child { border-right: 0; }
    .card strong { color: var(--ink); font-size: clamp(25px, 4vw, 43px); letter-spacing: -.06em; }
    .label { color: var(--muted); }
    .panel { border: 1px solid var(--ink); background: var(--surface); color: var(--ink); padding: 20px; margin-bottom: 22px; }
    .panel h2 { color: var(--ink); font-size: 24px; letter-spacing: -.05em; margin-bottom: 5px; }
    .panel p { color: var(--muted); font: 12px/1.5 monospace; margin-bottom: 15px; }
    .chart-wrap { position: relative; min-width: 0; }
    .chart { width: 100%; height: auto; display: block; overflow: visible; }
    .grid { stroke: var(--line); stroke-width: 1; }
    .axis-text { fill: var(--muted); font: 10px monospace; }
    .line { fill: none; stroke: var(--ink); stroke-width: 3; }
    .area { fill: color-mix(in srgb, var(--acid) 32%, transparent); }
    .point { fill: var(--acid); stroke: var(--ink); stroke-width: 2; cursor: pointer; }
    .point:hover, .point:focus, .discovery-hit:hover + .discovery-first, .discovery-hit:focus + .discovery-first { outline: none; filter: brightness(1.12); }
    .tooltip { min-width: 150px; position: absolute; z-index: 3; right: 10px; top: 8px; border: 1px solid var(--ink); background: var(--paper); color: var(--ink); padding: 8px 10px; box-shadow: 4px 4px 0 var(--acid); pointer-events: none; }
    .tooltip strong { color: var(--ink); display: block; margin-bottom: 3px; }
    .tooltip span { color: var(--muted); text-transform: none; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    table { width: 100%; border-collapse: collapse; color: var(--ink); font-size: 13px; }
    th, td { color: var(--ink); text-align: left; border-bottom: 1px solid var(--line); padding: 9px; }
    th { color: var(--muted); font: 11px monospace; text-transform: uppercase; }
    td:last-child, th:last-child { text-align: right; }
    .bar { height: 8px; background: var(--surface-control); margin-top: 4px; }
    .bar i { display: block; height: 100%; background: var(--acid); }
    .taste { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 18px; }
    .taste article { border: 1px solid var(--line); background: var(--surface); color: var(--ink); padding: 12px; min-height: 80px; }
    .taste article strong { display: block; color: var(--ink); font-size: 27px; letter-spacing: -.05em; margin-top: 12px; }
    .notice { border-left: 3px solid var(--orange); background: var(--surface-muted); color: var(--muted); padding: 9px 12px; font: 11px/1.5 monospace; }
    .footer { border-top: 1px solid var(--ink); padding-top: 16px; color: var(--muted); font: 11px monospace; }
    .graph-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .heatmap { display: grid; grid-template-columns: 38px repeat(24, minmax(8px, 1fr)); gap: 3px; }
    .heatmap .hour, .heatmap .day { color: var(--muted); font: 9px monospace; display: flex; align-items: center; }
    .heatmap .hour { justify-content: center; }
    .heatmap .cell { min-width: 0; aspect-ratio: 1; border: 1px solid color-mix(in srgb, var(--line) 65%, transparent); padding: 0; cursor: crosshair; }
    .heatmap .cell:hover, .heatmap .cell:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
    .chart-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 10px; color: var(--muted); font: 10px monospace; }
    .chart-legend span { display: flex; align-items: center; gap: 6px; }
    .chart-legend i { width: 13px; height: 8px; background: var(--acid); border: 1px solid var(--ink); }
    .chart-legend span:last-child i { background: var(--surface-control); }
    .discovery-first { fill: var(--acid); stroke: var(--ink); stroke-width: .5; pointer-events: none; }
    .discovery-repeat { fill: var(--surface-control); stroke: var(--ink); stroke-width: .5; pointer-events: none; }
    .discovery-hit { fill: transparent; cursor: crosshair; }
    @media (max-width: 700px) {
      body { padding: 20px; }
      header { display: block; }
      .meta { margin-top: 16px; text-align: left; }
      .cards, .split, .taste { grid-template-columns: 1fr 1fr; }
      .card:nth-child(2) { border-right: 0; }
      .card:nth-child(-n+2) { border-bottom: 1px solid var(--ink); }
      .heatmap { grid-template-columns: 30px repeat(24, minmax(5px, 1fr)); gap: 2px; overflow-x: auto; }
      table { font-size: 11px; }
      th, td { padding: 7px; }
    }
    @media print {
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      body { max-width: none; padding: 0; background: var(--paper) !important; }
      .actions { display: none; }
      .section { display: block !important; }
      .panel, .cards, .taste { break-inside: avoid; }
      .tooltip { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div><div class="label">PLAYBACK ATLAS · INTERACTIVE REPORT</div><h1>Patterns in the <em>archive.</em></h1></div>
    <div class="meta">${escapeHtml(data.startDate)} → ${escapeHtml(data.endDate)}<br>${escapeHtml(data.granularity)} groups · generated ${escapeHtml(generatedAt)}</div>
  </header>
  <nav class="actions" aria-label="Report sections">
    <button class="active" data-section="overview">Overview</button>
    <button data-section="artists">Artists</button>
    ${data.enrichment ? '<button data-section="spotify">Spotify profile</button>' : ''}
    <button type="button" onclick="window.print()">Print / PDF</button>
  </nav>
  <main>
    <section id="overview" class="section active">
      <div class="cards">
        <article class="card"><span class="label">Total plays</span><strong>${summary.totalPlays.toLocaleString()}</strong></article>
        <article class="card"><span class="label">Listening time</span><strong>${escapeHtml(formatHours(summary.totalMs))}</strong></article>
        <article class="card"><span class="label">Unique tracks</span><strong>${summary.uniqueTracks.toLocaleString()}</strong></article>
        <article class="card"><span class="label">Unique artists</span><strong>${summary.uniqueArtists.toLocaleString()}</strong></article>
      </div>
      <article class="panel">
        <h2>Listening over time</h2><p>Switch between plays and listening time. Hover or focus points for exact values.</p>
        <div class="actions metric-actions"><button class="active" data-metric="plays">Plays</button><button data-metric="duration">Time</button></div>
        <div class="chart-wrap"><div id="volume-tooltip" class="tooltip"><strong>Volume</strong><span>Hover a point</span></div><svg id="volume" class="chart" viewBox="0 0 1000 300" role="img" aria-label="Listening volume over time"></svg></div>
      </article>
      <div class="split">
        <article class="panel">
          <h2>When you listen</h2><p>Browser-local weekday and hour. The metric control above also updates this graph.</p>
          <div class="chart-wrap"><div id="heatmap-tooltip" class="tooltip"><strong>Listening rhythm</strong><span>Hover a cell</span></div><div id="heatmap" class="heatmap" role="grid" aria-label="Listening heatmap"></div></div>
        </article>
        <article class="panel">
          <h2>First plays vs repeats</h2><p>First-ever appearances in the archive compared with repeat listening.</p>
          <div class="chart-legend"><span><i></i>First plays</span><span><i></i>Repeats</span></div>
          <div class="chart-wrap"><div id="discovery-tooltip" class="tooltip"><strong>Discovery</strong><span>Hover a bar</span></div><svg id="discovery" class="chart" viewBox="0 0 1000 300" role="img" aria-label="First plays versus repeats"></svg></div>
        </article>
      </div>
    </section>
    <section id="artists" class="section">
      <article class="panel">
        <h2>Top artists</h2><p>Ranked using the metric selected when this snapshot was exported.</p>
        <table><thead><tr><th>#</th><th>Artist</th><th>Listening share</th><th>Value</th></tr></thead><tbody>
          ${data.result.artistTotals.map((artist, index) => {
            const value = data.metric === 'plays' ? artist.plays : artist.totalMs
            return `<tr><td>${String(index + 1).padStart(2, '0')}</td><td>${escapeHtml(artist.artistName)}</td><td><div class="bar"><i style="width:${Math.min(100, (value / artistMaximum) * 100)}%"></i></div></td><td>${escapeHtml(formatMetric(artist, data.metric))}</td></tr>`
          }).join('')}
        </tbody></table>
      </article>
    </section>
    ${spotifySection}
  </main>
  <p class="footer">Playback Atlas · Interactive snapshot · ${escapeHtml(data.theme)} theme · Spotify links open externally · No access tokens included.</p>
  <script>
    const data = ${serialized};
    let metric = data.metric;
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const metricValue = item => metric === 'plays' ? item.plays : item.totalMs / 3600000;
    const metricText = value => metric === 'plays' ? Math.round(value).toLocaleString() + ' plays' : value.toFixed(1) + ' hours';
    const tooltip = (id, title, text) => { const node = document.getElementById(id); node.innerHTML = '<strong>' + title + '</strong><span>' + text + '</span>'; };

    function drawVolume() {
      const svg = document.getElementById('volume');
      const items = data.result.volume;
      const values = items.map(metricValue);
      const maximum = Math.max(...values, 1);
      const width = 1000, height = 300, padding = { left: 45, right: 18, top: 20, bottom: 36 };
      const points = items.map((item, index) => ({
        item,
        value: values[index],
        x: padding.left + (index / Math.max(items.length - 1, 1)) * (width - padding.left - padding.right),
        y: padding.top + (1 - values[index] / maximum) * (height - padding.top - padding.bottom),
      }));
      const labels = points.filter((_, index) => index % Math.max(1, Math.ceil(points.length / 6)) === 0 || index === points.length - 1);
      svg.innerHTML = [0, .5, 1].map(ratio => { const y = padding.top + ratio * (height - padding.top - padding.bottom); return '<line class="grid" x1="45" x2="982" y1="' + y + '" y2="' + y + '"/>'; }).join('')
        + '<polygon class="area" points="45,264 ' + points.map(point => point.x + ',' + point.y).join(' ') + ' 982,264"/>'
        + '<polyline class="line" points="' + points.map(point => point.x + ',' + point.y).join(' ') + '"/>'
        + points.map(point => '<circle class="point" cx="' + point.x + '" cy="' + point.y + '" r="5" tabindex="0" data-period="' + point.item.period + '" data-value="' + point.value + '"/>').join('')
        + labels.map(point => '<text class="axis-text" x="' + point.x + '" y="291" text-anchor="middle">' + point.item.period.slice(0, 7) + '</text>').join('');
      svg.querySelectorAll('.point').forEach(node => {
        const show = () => tooltip('volume-tooltip', node.dataset.period, metricText(Number(node.dataset.value)));
        node.addEventListener('mouseenter', show); node.addEventListener('focus', show);
      });
    }

    function drawHeatmap() {
      const root = document.getElementById('heatmap');
      const lookup = new Map(data.result.heatmap.map(item => [item.weekday + '-' + item.hour, item]));
      const maximum = Math.max(...data.result.heatmap.map(metricValue), 1);
      let html = '<span></span>' + Array.from({ length: 24 }, (_, hour) => '<span class="hour">' + (hour % 3 === 0 ? String(hour).padStart(2, '0') : '') + '</span>').join('');
      weekdays.forEach((day, weekday) => {
        html += '<span class="day">' + day + '</span>';
        for (let hour = 0; hour < 24; hour += 1) {
          const item = lookup.get(weekday + '-' + hour) || { weekday, hour, plays: 0, totalMs: 0 };
          const value = metricValue(item);
          const intensity = Math.round((value / maximum) * 100);
          const label = day + ' ' + String(hour).padStart(2, '0') + ':00, ' + metricText(value);
          html += '<button class="cell" role="gridcell" aria-label="' + label + '" data-label="' + day + ' ' + String(hour).padStart(2, '0') + ':00" data-value="' + value + '" style="background:color-mix(in srgb,var(--acid) ' + intensity + '%,var(--surface-control))"></button>';
        }
      });
      root.innerHTML = html;
      root.querySelectorAll('.cell').forEach(node => {
        const show = () => tooltip('heatmap-tooltip', node.dataset.label, metricText(Number(node.dataset.value)));
        node.addEventListener('mouseenter', show); node.addEventListener('focus', show);
      });
    }

    function drawDiscovery() {
      const svg = document.getElementById('discovery');
      const items = data.result.discovery;
      const maximum = Math.max(...items.map(item => item.firstPlays + item.repeatPlays), 1);
      const width = 1000, height = 300, left = 35, right = 15, top = 20, bottom = 38;
      const available = width - left - right;
      const slot = available / Math.max(items.length, 1);
      const barWidth = Math.max(2, Math.min(26, slot * .72));
      let html = [0, .5, 1].map(ratio => { const y = top + ratio * (height - top - bottom); return '<line class="grid" x1="35" x2="985" y1="' + y + '" y2="' + y + '"/>'; }).join('');
      items.forEach((item, index) => {
        const total = item.firstPlays + item.repeatPlays;
        const totalHeight = (total / maximum) * (height - top - bottom);
        const firstHeight = total ? totalHeight * item.firstPlays / total : 0;
        const repeatHeight = totalHeight - firstHeight;
        const x = left + index * slot + (slot - barWidth) / 2;
        const bottomY = height - bottom;
        html += '<rect class="discovery-hit" tabindex="0" x="' + x + '" y="' + top + '" width="' + barWidth + '" height="' + (height - top - bottom) + '" data-period="' + item.period + '" data-first="' + item.firstPlays + '" data-repeat="' + item.repeatPlays + '"/>';
        html += '<rect class="discovery-first" x="' + x + '" y="' + (bottomY - firstHeight) + '" width="' + barWidth + '" height="' + firstHeight + '"/>';
        html += '<rect class="discovery-repeat" x="' + x + '" y="' + (bottomY - totalHeight) + '" width="' + barWidth + '" height="' + repeatHeight + '"/>';
        if (index % Math.max(1, Math.ceil(items.length / 6)) === 0 || index === items.length - 1) html += '<text class="axis-text" x="' + (x + barWidth / 2) + '" y="291" text-anchor="middle">' + item.period.slice(0, 7) + '</text>';
      });
      svg.innerHTML = html;
      svg.querySelectorAll('.discovery-hit').forEach(node => {
        const show = () => tooltip('discovery-tooltip', node.dataset.period, Number(node.dataset.first).toLocaleString() + ' first plays · ' + Number(node.dataset.repeat).toLocaleString() + ' repeats');
        node.addEventListener('mouseenter', show); node.addEventListener('focus', show);
      });
    }

    document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));
      document.getElementById(button.dataset.section).classList.add('active');
      document.querySelectorAll('[data-section]').forEach(item => item.classList.toggle('active', item === button));
    }));
    document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => {
      metric = button.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(item => item.classList.toggle('active', item === button));
      drawVolume(); drawHeatmap();
    }));
    document.querySelectorAll('[data-metric]').forEach(button => button.classList.toggle('active', button.dataset.metric === metric));
    drawVolume(); drawHeatmap(); drawDiscovery();
  </script>
</body>
</html>`
}
