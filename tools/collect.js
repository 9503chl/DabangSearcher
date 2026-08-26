#!/usr/bin/env node
// 다방 부평·남동권(5개역) 월세 매물 수집 — Playwright 기반
//   node tools/collect.js             → index.html / data/seen.json 갱신
//   node tools/collect.js --dry       → 결과를 .collect-dry/ 에만 쓰고 원본은 안 건드림
//   node tools/collect.js --budget 40 → 노선당 상세 클릭 상한(기본 30)
//
// 상세는 https://www.dabangapp.com/room/{id} 를 직접 연다. 매번 새 navigation 이라
// 이전 매물 내용을 잘못 읽는 사고(스테일 DOM)가 구조적으로 불가능하다.
// MCP·내장 브라우저를 거치지 않고 playwright 패키지가 크로미움을 직접 띄운다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const BUDGET = (() => {
  const i = process.argv.indexOf('--budget');
  return i > 0 ? +process.argv[i + 1] : 30;
})();
const OUT = DRY ? path.join(ROOT, '.collect-dry') : ROOT;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const H = {
  'user-agent': UA,                    // ★없으면 400 이 떨어진다. 반드시 붙일 것
  accept: 'application/json',
  'd-api-version': '5.0.0',
  'd-call-type': 'web',
  referer: 'https://www.dabangapp.com/map/house',
  origin: 'https://www.dabangapp.com',
  'accept-language': 'ko-KR,ko;q=0.9',
};

const STATIONS = [
  { line: '1',   name: '부평',       id: 330 },
  { line: 'I1',  name: '간석오거리', id: 12  },
  { line: 'I12', name: '인천시청',   id: 579 },
  { line: 'I2',  name: '모래내시장', id: 812 },
  { line: 'I2',  name: '만수',       id: 813 },
];
const LINES = ['1', 'I1', 'I12', 'I2'];
const PER_LINE = 8;

const R = { min: 0, max: 999999 };
const FILTERS = {
  'house-villa': {
    sellingTypeList: ['MONTHLY_RENT'], tradeRange: R, depositRange: R, priceRange: R,
    isIncludeMaintenance: false, pyeongRange: R, useApprovalDateRange: R,
    roomFloorList: ['GROUND_FIRST', 'GROUND_SECOND_OVER', 'SEMI_BASEMENT', 'ROOFTOP'],
    dealTypeList: ['AGENT'], canParking: false, isShortLease: false,
    hasElevator: false, hasPano: false,
    roomCountList: ['ONE_ROOM', 'TWO_ROOM', 'THREE_ROOM', 'FOUR_ROOM'],
  },
  apt: {
    sellingTypeList: ['MONTHLY_RENT'], tradeRange: R, depositRange: R, priceRange: R,
    isIncludeMaintenance: false, pyeongRange: R, useApprovalDateRange: R,
    dealTypeList: ['AGENT'], isShortLease: false,
    householdNumRange: R, parkingNumRange: R, hasTakeTenant: false,
    roomCountList: ['ONE_ROOM', 'TWO_ROOM', 'THREE_ROOM', 'FOUR_ROOM'],
  },
};

const RESIDENTIAL = /공동주택|단독주택|다세대|연립|아파트/;
// 상세 '방종류' → 페이지 표기. 여기 없는 값('원룸')은 오픈형이라 표시 대상이 아니다.
const TYPE_MAP = {
  '원룸(분리형)': '1.5룸(분리형)', '아파트(분리형)': '1.5룸(아파트)',
  '투룸': '투룸', '쓰리룸': '쓰리룸 이상', '쓰리룸 이상': '쓰리룸 이상', '아파트': '아파트',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p8 = (id) => id.slice(0, 8);
const today = () => {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
};

async function api(url) {
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 90));
  return res.json();
}

// ── 1) 역 좌표 ────────────────────────────────
async function stationCoords() {
  const out = [];
  for (const s of STATIONS) {
    const u = 'https://www.dabangapp.com/api/v5/loc/search?columnList=REGION&columnList=SUBWAY'
      + '&columnList=UNIV&columnList=COMPLEX&columnList=SALE_IN_LOTS&searchKeyword='
      + encodeURIComponent(s.name);
    const j = await api(u);
    const list = (j.result && j.result.subwayList) || [];
    const hit = list.find((x) => x.id === s.id) || list.find((x) => x.name === s.name + '역');
    if (!hit) throw new Error('역을 못 찾음: ' + s.name);
    out.push(Object.assign({}, s, { lat: hit.location.lat, lng: hit.location.lng }));
    await sleep(200);
  }
  return out;
}

// ── 2) 후보 리스트 ────────────────────────────
async function candidates(stations) {
  const seen = new Set();
  const rows = [];
  for (const s of stations) {
    const bbox = {
      sw: { lat: s.lat - 0.008, lng: s.lng - 0.010 },
      ne: { lat: s.lat + 0.008, lng: s.lng + 0.010 },
    };
    for (const cat of ['house-villa', 'apt']) {
      for (let page = 1; page <= 6; page++) {
        const u = 'https://www.dabangapp.com/api/v5/room-list/category/' + cat + '/bbox'
          + '?filters=' + encodeURIComponent(JSON.stringify(FILTERS[cat]))
          + '&bbox=' + encodeURIComponent(JSON.stringify(bbox))
          + '&zoom=16&useMap=naver&page=' + page;
        const j = await api(u);
        const rl = (j.result && j.result.roomList) || [];
        for (const it of rl) {
          if (seen.has(it.id)) continue;          // 한 매물이 여러 역에 걸리면 첫 역 기준
          seen.add(it.id);
          const title = String(it.priceTitle || '');
          if (title.indexOf('억') >= 0) continue;
          const m = title.match(/^\s*([\d,]+)\s*\/\s*([\d,]+)/);
          if (!m) continue;
          const dep = +m[1].replace(/,/g, '');
          const rent = +m[2].replace(/,/g, '');
          if (dep < 200 || dep > 2000 || rent > 60) continue;
          if (String(it.roomTypeName || '').indexOf('단기') >= 0) continue;
          rows.push({ id: it.id, p8: p8(it.id), line: s.line, station: s.name, dep, rent });
        }
        if (!(j.result && j.result.hasMore)) break;
        await sleep(250);
      }
      await sleep(300);
    }
  }
  rows.sort((a, b) => b.dep - a.dep || a.rent - b.rent);
  return rows;
}

// ── 3) 상세 (Playwright) ──────────────────────
function fieldFrom(lines, label) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === label) {
      for (let j = i + 1; j < lines.length; j++) if (lines[j]) return lines[j];
    }
  }
  return '';
}

async function readDetail(page, id) {
  await page.goto('https://www.dabangapp.com/room/' + id, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => /건축물용도/.test(document.body.innerText), null, { timeout: 30000 });
  const t = await page.evaluate(() => document.body.innerText);
  const a = t.lastIndexOf('매물번호');
  let b = t.indexOf('중개사무소의 다른 방', a);
  if (b < 0) b = t.length;
  const L = t.slice(a, b).split('\n').map((x) => x.trim());
  const d = {
    rtype: fieldFrom(L, '방종류'),
    use: fieldFrom(L, '건축물용도'),
    appr: fieldFrom(L, '사용승인일'),
    dir: fieldFrom(L, '방향'),
    floor: fieldFrom(L, '해당층/건물층'),
    maint: fieldFrom(L, '관리비').replace(/^매월\s*/, ''),
  };
  if (!d.use || !d.rtype) throw new Error('필드 파싱 실패');
  return d;
}

// ── 4) 태그 ───────────────────────────────────
function tagsFor(r) {
  const t = [];
  if (r.isNew) t.push('NEW');
  if (/북/.test(r.dir)) t.push('북향');
  else if (/서/.test(r.dir)) t.push('서향');
  const m = String(r.floor).match(/^(\d+)층\s*\/\s*(\d+)층$/);
  if (m && m[1] === m[2]) t.push('꼭대기층');
  if (/^1층\s*\//.test(r.floor)) t.push('1층');
  if (/반지층|반지하/.test(r.floor)) t.push('반지하');
  return t;
}

// ── main ──────────────────────────────────────
(async () => {
  const { chromium } = require('playwright');
  const led = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seen.json'), 'utf8'));
  const acc = new Map(led.accepted.map((a) => [a.id, a]));
  const exc = new Map(led.excluded.map((a) => [a.id, a]));
  const SHOWN = new Set(led.shown || []);
  if (!SHOWN.size) throw new Error('seen.json 에 shown 이 없다 — 신규 판정 불가');

  console.log('■ 역 좌표 조회');
  const stations = await stationCoords();
  console.log('■ 후보 수집');
  const cand = await candidates(stations);
  console.log('  후보 ' + cand.length + '건 (가격·단기 필터 통과)');

  console.log('■ 상세 확인');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' });
  const page = await ctx.newPage();

  const rows = [];
  const stat = { clicked: 0, cached: 0, newAcc: 0, newExc: 0, gone: 0 };

  for (const L of LINES) {
    const pool = cand.filter((c) => c.line === L);
    let clicks = 0;
    let kept = 0;
    for (const c of pool) {
      if (exc.has(c.p8)) continue;                    // 용도 미달 확정 — 재클릭 없음
      const a = acc.get(c.p8);
      if (a && a.struct === 'open') continue;         // 오픈형 원룸 — 재클릭 없음
      let d = a && a.detail;
      if (d) {
        stat.cached++;                                // 원장 캐시는 공짜 — 예산 안 깎고 끝까지 평가
      } else {
        // 예산은 '클릭 수'만 제한한다. 채택 수(kept)로 끊으면 하위 순위에 있는
        // 1.5룸·신축(보증금이 낮아 아래에 묻힌다)을 영영 발견하지 못한다.
        // 원장이 영구 캐시라 깊게 훑는 비용은 1회성이다.
        if (clicks >= BUDGET) continue;
        try {
          d = await readDetail(page, c.id);
          clicks++;
          stat.clicked++;
          await sleep(350);
        } catch (e) {
          stat.gone++;
          console.log('  ! 상세 실패 ' + c.p8 + ' — ' + String(e).split('\n')[0].slice(0, 60));
          continue;
        }
        if (!RESIDENTIAL.test(d.use)) {                // 근생/숙박/업무 → 영구 제외
          exc.set(c.p8, { id: c.p8, reason: '근생/숙박/업무', use: d.use });
          acc.delete(c.p8);
          stat.newExc++;
          continue;
        }
        const mapped = TYPE_MAP[d.rtype];
        acc.set(c.p8, {
          id: c.p8, station: c.station, use: d.use, appr: d.appr.slice(0, 4),
          memo: c.dep + '/' + c.rent + ' ' + today(),
          struct: mapped ? 'ok' : 'open',              // 매핑 안 되는 '원룸' = 오픈형
          detail: d,
        });
        stat.newAcc++;
        if (!mapped) continue;                         // 오픈형은 표시 대상 아님
      }
      const rtype = TYPE_MAP[d.rtype];
      if (!rtype) continue;
      rows.push({
        id: c.id, p8: c.p8, line: L, station: c.station, dep: c.dep, rent: c.rent,
        rtype: rtype, use: d.use, appr: d.appr, dir: d.dir, floor: d.floor,
        maint: d.maint || '없음', isNew: !SHOWN.has(c.p8),
      });
      kept++;
    }
    console.log('  ' + L + ': 후보 ' + pool.length + ' → 채택 ' + kept + ' (상세 클릭 ' + clicks + ')');
  }
  await browser.close();

  // 노선별 정렬(보증금↓ → 사용승인일↓ → 월세↑) + 동일 매물 중복 제거(이미 실린 쪽 우선) + 상위 8
  const sig = (r) => [r.line, r.dep, r.rent, r.appr, r.dir, r.floor].join('~');
  const listings = [];
  for (const L of LINES) {
    const pool = rows.filter((r) => r.line === L)
      .sort((a, b) => b.dep - a.dep
        || (a.appr < b.appr ? 1 : a.appr > b.appr ? -1 : 0)
        || a.rent - b.rent);
    const bySig = {};
    pool.forEach((r) => { (bySig[sig(r)] = bySig[sig(r)] || []).push(r); });
    const keep = new Set(Object.values(bySig).map((g) => (g.find((r) => SHOWN.has(r.p8)) || g[0]).p8));
    pool.filter((r) => keep.has(r.p8)).slice(0, PER_LINE).forEach((r) => listings.push({
      id: r.id, line: r.line, station: r.station, dep: r.dep, rent: r.rent, rtype: r.rtype,
      use: r.use, appr: r.appr, dir: r.dir, floor: r.floor, maint: r.maint, tags: tagsFor(r),
    }));
  }

  const all = rows.slice().sort((a, b) => b.dep - a.dep);
  const halfRooms = all.filter((r) => /^1\.5룸/.test(r.rtype))
    .map((r) => ({ id: r.id, label: r.station + ' ' + r.dep + '/' + r.rent }));
  const newBuilds = all.filter((r) => +String(r.appr).slice(0, 4) >= 2020)
    .map((r) => ({ id: r.id, label: r.station + ' ' + r.dep + '/' + r.rent + ' ' + r.rtype + ' (' + String(r.appr).slice(0, 4) + ')' }));

  const DABANG = { updated: today(), halfRooms: halfRooms, newBuilds: newBuilds, listings: listings };

  // index.html 의 DATA 블록만 교체 (레이아웃/CSS/스크립트는 절대 건드리지 않는다)
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<!-- DATA:START -->[\s\S]*?<!-- DATA:END -->/;
  if (!re.test(idx)) throw new Error('index.html 에 DATA 마커가 없다');
  const block = '<!-- DATA:START -->\n<script>\nwindow.DABANG = '
    + JSON.stringify(DABANG, null, 2) + ';\n</script>\n<!-- DATA:END -->';

  const shown = [...new Set([...SHOWN, ...listings.map((l) => p8(l.id))])];
  const newLed = {
    _comment: led._comment,
    accepted: [...acc.values()],
    excluded: [...exc.values()],
    shown: shown,
  };

  if (DRY) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), idx.replace(re, block));
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data/seen.json'), JSON.stringify(newLed, null, 2));

  const nNew = listings.filter((l) => l.tags.indexOf('NEW') >= 0).length;
  console.log('\n■ 결과' + (DRY ? '  (--dry: ' + path.relative(ROOT, OUT) + '/ 에만 씀)' : ''));
  console.log('  실린 매물 ' + listings.length + '건 — 신규 ' + nNew + ' / 기존 ' + (listings.length - nNew));
  console.log('  1.5룸 ' + halfRooms.length + ' / 신축 ' + newBuilds.length);
  console.log('  상세 클릭 ' + stat.clicked + ' (원장 재사용 ' + stat.cached
    + ', 신규 채택 ' + stat.newAcc + ', 신규 탈락 ' + stat.newExc + ', 상세 실패 ' + stat.gone + ')');
  console.log('  원장: accepted ' + acc.size + ' / excluded ' + exc.size
    + ' / shown ' + SHOWN.size + '→' + shown.length);
  listings.filter((l) => l.tags.indexOf('NEW') >= 0)
    .forEach((l) => console.log('    NEW  ' + l.line + ' ' + l.station + ' ' + l.dep + '/' + l.rent + ' ' + l.rtype));
})().catch((e) => { console.error('\n실패:', e); process.exit(1); });
