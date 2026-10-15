// Renders a made-up family's photo library from CC0 Notionists avatars (DiceBear, by Zoish).
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';
import fs from 'fs';
import { chromium } from 'playwright';
// Usage: node render-photos.mjs <library folder>   (then: python build-data.py <library folder>)
const LIB = process.argv[2] || 'demo-library';

const SEEDS = { walter: 'p58', edith: 'p39', richard: 'p22', carol: 'p33', susan: 'p18', daniel: 'p45', peter: 'p8',
  emily: 'p40', sam: 'p36', jacob: 'p32', lucia: 'p57', mateo: 'p5', nora: 'p29',
  june: 'p47', stranger1: 'p17', stranger2: 'p46', stranger3: 'p10', stranger4: 'p41' };
// [folder, file, caption, decade style, people]
const PHOTOS = [
  ['1950s', 'wedding-1953.jpg', 'Walter and Edith, wedding day 1953', 'sepia', ['walter', 'edith']],
  ['1950s', 'porch-1955.jpg', 'On the porch, 1955', 'sepia', ['edith', 'walter', 'june']],
  ['1950s', 'new-baby-1954.jpg', 'Bringing Richard home, 1954', 'sepia', ['edith', 'richard', 'walter']],
  ['1950s', 'church-picnic.jpg', 'Church picnic', 'sepia', ['walter', 'stranger1', 'edith', 'stranger2']],
  ['1960s', 'easter-1962.jpg', 'Easter 1962', 'bw', ['richard', 'susan', 'peter', 'edith']],
  ['1960s', 'lake-1965.jpg', 'Lake trip, summer 1965', 'bw', ['walter', 'richard', 'susan', 'peter']],
  ['1960s', 'christmas-1967.jpg', 'Christmas 1967', 'bw', ['edith', 'peter', 'susan', 'richard', 'walter']],
  ['1960s', 'june-visit.jpg', 'Aunt June visits', 'bw', ['june', 'edith', 'susan']],
  ['1970s', 'graduation-1972.jpg', "Richard's graduation, 1972", 'faded', ['richard', 'edith', 'walter']],
  ['1970s', 'thanksgiving-1978.jpg', 'Thanksgiving 1978', 'faded', ['walter', 'edith', 'richard', 'carol', 'susan', 'daniel']],
  ['1970s', 'wedding-1979.jpg', 'Richard and Carol, 1979', 'faded', ['carol', 'richard']],
  ['1970s', 'road-trip.jpg', 'Road trip', 'faded', ['peter', 'susan', 'stranger3']],
  ['1980s', 'emily-1984.jpg', 'Emily, spring 1984', 'warm', ['carol', 'emily']],
  ['1980s', 'cousins-1988.jpg', 'Cousins, 1988', 'warm', ['emily', 'lucia', 'jacob']],
  ['1980s', 'reunion-1986.jpg', 'Family reunion 1986', 'warm', ['walter', 'edith', 'susan', 'daniel', 'richard', 'carol']],
  ['1980s', 'backyard.jpg', 'Backyard', 'warm', ['daniel', 'lucia', 'susan']],
  ['1990s', 'beach-1993.jpg', 'Beach, 1993', 'color', ['jacob', 'mateo', 'lucia', 'emily']],
  ['1990s', 'birthday-1996.jpg', "Mateo's birthday, 1996", 'color', ['mateo', 'daniel', 'susan']],
  ['1990s', 'christmas-1998.jpg', 'Christmas 1998', 'color', ['peter', 'edith', 'walter', 'jacob']],
  ['1990s', 'recital.jpg', 'Recital', 'color', ['lucia', 'stranger4', 'susan']],
  ['2000s', 'graduation-2004.jpg', "Emily's graduation, 2004", 'color', ['emily', 'richard', 'carol']],
  ['2000s', 'cabin-2007.jpg', 'Cabin weekend 2007', 'color', ['jacob', 'peter', 'mateo']],
  ['2000s', 'edith-80.jpg', "Grandma Edith's 80th, 2011", 'color', ['edith', 'emily', 'jacob', 'lucia', 'mateo']],
  ['2010s', 'wedding-2012.jpg', 'Emily and Sam, 2012', 'color', ['sam', 'emily']],
  ['2010s', 'nora-2015.jpg', 'Nora meets everyone, 2015', 'color', ['carol', 'nora', 'emily', 'sam']],
  ['2010s', 'thanksgiving-2018.jpg', 'Thanksgiving 2018', 'color', ['richard', 'carol', 'jacob', 'nora', 'sam']],
  ['2020s', 'park-2021.jpg', 'Park, 2021', 'color', ['nora', 'emily']],
  ['2020s', 'reunion-2023.jpg', 'Reunion 2023', 'color', ['susan', 'daniel', 'lucia', 'mateo', 'peter', 'jacob']],
  ['Unsorted', 'scan-0042.jpg', '', 'bw', ['june', 'walter']],
  ['Unsorted', 'scan-0057.jpg', '', 'faded', ['jacob', 'carol']],
  ['Unsorted', 'scan-0061.jpg', '', 'color', ['lucia', 'jacob']],
  ['Unsorted', 'scan-0063.jpg', '', 'sepia', ['june', 'stranger1']],
];
const STYLE = {   // wall, floor, filter
  sepia: ['#d9c7a5', '#b59d77', 'sepia(.85) contrast(.92) brightness(1.02)'],
  bw: ['#cfcfcf', '#9a9a9a', 'grayscale(1) contrast(1.05)'],
  faded: ['#e3c9a0', '#b98a5e', 'sepia(.3) saturate(.75) hue-rotate(-8deg) brightness(1.04)'],
  warm: ['#e9c9a8', '#a87a55', 'saturate(.9) sepia(.15)'],
  color: ['#d9e6ec', '#b9cbb0', 'none'],
};
const BG = ['f1e3c8', 'dbe7ef', 'efd9d3', 'e2ead8', 'eadff0', 'f4e6b8'];
const W = 1200, H = 800;
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: W, height: H } });
const out = [];
let n = 0;
for (const [folder, file, caption, style, people] of PHOTOS) {
  const [wall, floor, filter] = STYLE[style];
  const k = people.length, faces = [];
  // Big enough to fill the frame: one row up to four people, two rows (back row higher) for more.
  const rows = k >= 5 ? [people.slice(0, Math.ceil(k / 2)), people.slice(Math.ceil(k / 2))] : [people];
  let html = '', zi = 1;
  rows.forEach((row, r) => {
    const back = rows.length > 1 && r === 0, m = row.length;
    const size = Math.min(back ? 470 : 600, Math.floor((W + 40) / (m * (back ? 0.78 : 0.7))));
    const span = W + 60 - size;
    row.forEach((p, i) => {
      const s = Math.round(size * (0.92 + (((n + i + r) * 7) % 5) * 0.03));
      const x = Math.round(-30 + (m === 1 ? span / 2 : (span * i) / (m - 1)) + ((n * 37 + i * 53) % 31) - 15);
      const y = back ? Math.round(H * 0.06 + ((i * 41 + n) % 30)) : H - Math.round(s * (m <= 3 ? 0.97 : 0.86));
      faces.push({ person: p, box: [x, y, x + s, y + s] });
      const svg = createAvatar(notionists, { seed: SEEDS[p], backgroundColor: ['transparent'] }).toString();
      html += `<div class="av" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px;z-index:${zi++}">${svg}</div>`;
    });
  });
  await pg.setContent(`<html><body style="margin:0"><div id="ph" style="position:relative;width:${W}px;height:${H}px;overflow:hidden;
    background:linear-gradient(${wall} 0 66%, ${floor} 66% 100%);filter:${filter}">
    <div style="position:absolute;left:${80 + (n * 113) % 700}px;top:70px;width:180px;height:130px;border:10px solid rgba(0,0,0,.18);background:rgba(255,255,255,.35)"></div>
    ${html}<div style="position:absolute;inset:0;box-shadow:inset 0 0 160px rgba(0,0,0,${style === 'color' ? .12 : .35})"></div></div>
    <style>.av{position:absolute}.av svg{width:100%;height:100%;display:block}
</style></body></html>`);
  fs.mkdirSync(`${LIB}/${folder}`, { recursive: true });
  await pg.locator('#ph').screenshot({ path: `${LIB}/${folder}/${file}`, type: 'jpeg', quality: 86 });
  out.push({ path: `${folder}/${file}`, caption, people: faces });
  n++;
}
fs.writeFileSync(`${LIB}/manifest.json`, JSON.stringify(out, null, 1));
await b.close();
console.log('photos', out.length, 'faces', out.reduce((a, p) => a + p.people.length, 0));
