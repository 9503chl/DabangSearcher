#!/bin/bash
# 다방 루틴 한 방 실행: origin 동기화 → 수집 → 검증 → 카톡·아티팩트용 사본 → 커밋·푸시
#   bash tools/routine.sh         → 전부
#   bash tools/routine.sh --dry   → .collect-dry/ 에만 쓰고 git 은 안 건드림(로직 점검용)
#
# 루틴 세션은 Bash 로 이 명령 하나만 부른다. 명령 문자열이 매일 똑같아야
# .claude/settings.json 허용 규칙에 걸려서 승인창 없이 돈다. 날짜·건수가 들어간
# git commit 을 세션이 직접 치면 매일 새 승인창이 떠서 몇 시간씩 멈춘다(2026-09-30·10-01).
#
# git 은 반드시 여기(셸)에서 부른다. 이 Mac 의 node 는 Rosetta(x86_64)라 node 안에서
# git 을 spawn 하면 xcrun 에러가 난다.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1
SRC=.; [ $DRY = 1 ] && SRC=.collect-dry

DAY=$(date +%Y-%m-%d)
KAKAO="$SRC/dabang_여왕폐하의간택목록_$(date +%Y%m%d).html"
ART="$SRC/.artifact/dabang-monthly-rent.html"

step() { printf '\n▶ %s\n' "$1"; }
fail() { printf '\n✗ 실패: %s\n' "$1"; exit 1; }

if [ $DRY = 0 ]; then
  step "origin 동기화"
  git pull -q --ff-only origin main || fail "git pull 실패 (로컬과 origin 이 갈라졌거나 네트워크 문제)"
fi

if [ ! -d node_modules/playwright ]; then
  step "의존성 설치(최초 1회)"
  npm install --silent || fail "npm install 실패"
  npx playwright install chromium || fail "playwright 크로미움 설치 실패"
fi

step "수집"
if [ $DRY = 1 ]; then
  node tools/collect.js --dry || fail "collect.js 비정상 종료"
else
  node tools/collect.js || fail "collect.js 비정상 종료"
fi

step "검증"
COUNTS=$(SRC="$SRC" node - <<'EOF'
const fs = require('fs');
const dir = process.env.SRC;
const h = fs.readFileSync(dir + '/index.html', 'utf8');
const m = h.match(/<!-- DATA:START -->([\s\S]*?)<!-- DATA:END -->/);
if (!m) throw new Error('DATA 블록 없음');
const d = JSON.parse(m[1].slice(m[1].indexOf('{'), m[1].lastIndexOf('}') + 1));
for (const k of ['id="switch"', '.card.is-new', 'newmark'])
  if (!h.includes(k)) throw new Error('템플릿 훼손: ' + k + ' 없음');
if (/원룸/.test(m[1])) throw new Error("DATA 블록에 '원룸' 이 남아 있음");
const L = d.listings || [];
const n = (k) => L.filter((x) => x.line === k).length;
const nNew = L.filter((x) => (x.tags || []).includes('NEW')).length;
const exc = JSON.parse(fs.readFileSync(dir + '/data/seen.json', 'utf8')).excluded.length;
console.log([n('1'), n('I1'), n('I12'), n('I2'), nNew, exc].join(' '));
EOF
) || fail "index.html 검증 실패"
read -r N1 NI1 NI12 NI2 NNEW NEXC <<< "$COUNTS"
echo "  DATA 파싱 OK, #switch·.card.is-new·newmark 그대로, '원룸' 없음"

step "사본"
cp "$SRC/index.html" "$KAKAO"
mkdir -p "$(dirname "$ART")"
sed 's#<title>여왕 폐하의 간택 목록</title>#<title>Dabang Monthly Rent Bupyeong</title>#' "$SRC/index.html" > "$ART"
grep -q '<title>Dabang Monthly Rent Bupyeong</title>' "$ART" || fail "아티팩트 사본 제목 교체 실패"

COMMIT="(dry — 커밋 안 함)"
if [ $DRY = 0 ]; then
  step "커밋·푸시"
  if git diff --quiet -- index.html data/seen.json; then
    echo "  변경 없음 — 커밋 생략"
  else
    git add index.html data/seen.json
    git commit -q -F - <<EOF
다방 부평권 매물 갱신 $DAY
- 1호선 ${N1}건 / 인천1호선 ${NI1}건 / 인천1·2호선 ${NI12}건 / 인천2호선 ${NI2}건
- 신규 ${NNEW}건, 용도 탈락 ${NEXC}건 누적
EOF
  fi
  # 지난 실행에서 못 올린 커밋이 있어도 같이 올라간다
  git push -q origin main || fail "git push 실패 (인증 확인: ssh -T git@github.com)"
  COMMIT="$(git rev-parse --short HEAD) (푸시 완료)"
fi

printf '\n■ 요약\n'
echo "  날짜      $DAY"
echo "  노선      1호선 ${N1} / 인천1 ${NI1} / 인천1·2 ${NI12} / 인천2 ${NI2}건, 신규 ${NNEW}, 용도 탈락 누적 ${NEXC}"
echo "  커밋      $COMMIT"
echo "  카톡      $(cd "$(dirname "$KAKAO")" && pwd)/$(basename "$KAKAO")"
echo "  아티팩트  $(cd "$(dirname "$ART")" && pwd)/$(basename "$ART")"
