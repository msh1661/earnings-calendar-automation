/**
 * 실적발표 캘린더 자동화 (구글 시트에 연결된 Apps Script)
 *
 * - doPost: PC의 sync_watchlist.py가 보낸 키움 관심종목을 시트에 저장한다.
 *     미국 종목은 '관심종목' 시트, 국내 지정 그룹은 '국내종목' 시트.
 * - syncEarnings: 매일 트리거로 실행되어 실적 일정을 캘린더에 반영한다.
 *     미국: Finnhub 실적 캘린더
 *     국내: OpenDART '기업설명회(IR) 개최' 공시(확정) + 작년 같은 시기 실적 공시일(예상)
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 다음 값을 넣는다.
 *   FINNHUB_API_KEY, SYNC_TOKEN, CALENDAR_ID, OPENDART_API_KEY
 */

const LOOKAHEAD_DAYS = 90;
const SHEET_NAME = '관심종목';
const KR_SHEET_NAME = '국내종목';
const LOG_SHEET_NAME = '운영기록';
const LOG_HEADER = ['실행 시각', '결과', '미국 종목', '국내 종목', '전체 일정', '국내 일정',
  '새로 만듦', '시간 변경', '삭제', '예상→확정 전환', '미국 조회 실패', '변경 내역'];
const TAG_KEY = 'earningsKey';
const EVENT_MINUTES = 30;
const KR_IR_MINUTES = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Finnhub hour 값별 대표 발표 시각(미국 동부 기준)
const HOUR_INFO = {
  bmo: { label: '장전', time: '07:00' },
  amc: { label: '장후', time: '16:00' },
  dmh: { label: '장중', time: '12:00' },
};

// 국내: 확정 IR을 찾을 최근 공시 기간, 예상 일정이 확정·발표 일정과 겹친다고 볼 간격
const KR_RECENT_DAYS = 75;
const KR_MATCH_DAYS = 15;
// 분기 실적 공시로 볼 보고서명(월별 판매실적 공시와 구분하기 위해 연결 기준만 사용)
const KR_EARNINGS_REPORT = '연결재무제표기준영업(잠정)실적';

function props_() {
  return PropertiesService.getScriptProperties();
}

/**
 * PC에서 관심종목 목록을 받는다.
 * 요청 본문: {"token": "...", "symbols": ["AAPL", ...], "krStocks": [{"code", "name", "corpCode"}, ...]}
 */
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== props_().getProperty('SYNC_TOKEN')) {
    return json_({ ok: false, error: 'invalid token' });
  }
  const syncedAt = '마지막 동기화: ' + new Date().toLocaleString('ko-KR');

  const symbols = (body.symbols || []).map(String).map(s => s.trim()).filter(Boolean);
  writeSheet_(SHEET_NAME, ['종목', syncedAt], symbols.map(s => [s]));

  // 예전 버전 PC 스크립트는 krStocks를 보내지 않으므로 그때는 국내 시트를 그대로 둔다.
  let krCount = null;
  if (Array.isArray(body.krStocks)) {
    const rows = body.krStocks.map(s => [s.code, s.name, s.corpCode]);
    writeSheet_(KR_SHEET_NAME, ['종목코드', '종목명', 'DART 고유번호', syncedAt], rows);
    krCount = rows.length;
  }
  return json_({ ok: true, count: symbols.length, krCount: krCount });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function writeSheet_(name, header, rows) {
  const sheet = getSheet_(name);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) {
    // 005930 같은 코드가 숫자로 바뀌지 않도록 텍스트 서식으로 쓴다.
    sheet.getRange(2, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  }
}

function readRows_(name, columns) {
  const sheet = getSheet_(name);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, columns).getValues()
    .map(row => row.map(v => String(v).trim()))
    .filter(row => row[0]);
}

/* ───────────── 미국: Finnhub ───────────── */

function fetchEarnings_(symbol, from, to) {
  const url = 'https://finnhub.io/api/v1/calendar/earnings'
    + '?from=' + from + '&to=' + to + '&symbol=' + encodeURIComponent(symbol);
  const response = UrlFetchApp.fetch(url, {
    headers: { 'X-Finnhub-Token': props_().getProperty('FINNHUB_API_KEY') },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    console.warn(symbol + ' 조회 실패: HTTP ' + response.getResponseCode());
    return null;
  }
  return JSON.parse(response.getContentText()).earningsCalendar || [];
}

/**
 * Finnhub 한 행을 캘린더 일정 형태로 바꾼다.
 * ADR(TSM, SKHY 등)은 Finnhub이 원래 상장 종목(2330.TW 등)으로 돌려주므로 요청한 티커를 사용한다.
 */
function toEvent_(row, symbol) {
  const info = HOUR_INFO[row.hour];
  const quarter = row.year + ' Q' + row.quarter;
  const currency = row.symbol === symbol ? ' 달러' : ' (' + row.symbol + ' 현지 통화)';
  const eps = row.epsEstimate == null ? '-' : row.epsEstimate.toFixed(2) + currency;
  const revenue = row.revenueEstimate ? (row.revenueEstimate / 1e9).toFixed(1) + 'B' + currency : '-';
  const description = [
    quarter + ' 실적',
    '미국 현지 발표일: ' + row.date + (info ? ' (' + info.label + ', 대표 시각 ' + info.time + ' ET)' : ' (시간 미정)'),
    'EPS 예상: ' + eps,
    '매출 예상: ' + revenue,
    '시각은 대표값입니다. 정확한 시각은 회사 IR 공지를 확인하세요.',
    '갱신: ' + new Date().toLocaleString('ko-KR'),
  ].join('\n');

  if (info) {
    const start = Utilities.parseDate(row.date + ' ' + info.time, 'America/New_York', 'yyyy-MM-dd HH:mm');
    return {
      key: symbol + '_' + row.year + 'Q' + row.quarter,
      title: symbol + ' 실적 (' + info.label + ')',
      allDay: false,
      start: start,
      end: new Date(start.getTime() + EVENT_MINUTES * 60 * 1000),
      description: description,
    };
  }
  return {
    key: symbol + '_' + row.year + 'Q' + row.quarter,
    title: symbol + ' 실적 (예정)',
    allDay: true,
    start: dateOnly_(row.date),
    description: description,
  };
}

/** 미국 종목 일정과 조회에 실패한 종목 목록을 돌려준다. */
function usTargets_(symbols, from, to) {
  const targets = {};
  const failed = [];
  symbols.forEach(symbol => {
    const rows = fetchEarnings_(symbol, from, to);
    if (rows === null) failed.push(symbol);
    (rows || []).forEach(row => {
      const target = toEvent_(row, symbol);
      targets[target.key] = target;
    });
    Utilities.sleep(1100); // Finnhub 무료 등급 분당 60회 제한
  });
  return { targets: targets, failed: failed };
}

/* ───────────── 국내: OpenDART ───────────── */

function dartGet_(path, params) {
  const query = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  return UrlFetchApp.fetch('https://opendart.fss.or.kr/api/' + path + '?crtfc_key='
    + props_().getProperty('OPENDART_API_KEY') + '&' + query, { muteHttpExceptions: true });
}

/** 기간 내 거래소 공시 목록(최신순). 날짜는 yyyyMMdd. */
function dartList_(corpCode, from, to) {
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const data = JSON.parse(dartGet_('list.json', {
      corp_code: corpCode, bgn_de: from, end_de: to, pblntf_ty: 'I', page_no: page, page_count: 100,
    }).getContentText());
    if (data.status === '013') break; // 조회된 데이터 없음
    if (data.status !== '000') throw new Error('OpenDART 오류 ' + data.status + ': ' + data.message);
    rows.push.apply(rows, data.list);
    if (page >= data.total_page) break;
  }
  return rows;
}

/** 공시 원문을 태그 없는 한 줄 텍스트로 가져온다. */
function dartDocumentText_(rceptNo) {
  const blob = dartGet_('document.xml', { rcept_no: rceptNo }).getBlob();
  if (blob.getBytes()[0] !== 0x50) return ''; // zip(PK)이 아니면 오류 응답
  const files = Utilities.unzip(blob.setContentType('application/zip'));
  return files.map(f => f.getDataAsString('UTF-8')).join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** IR 개최 공시 본문에서 일시·목적·방법을 읽는다. */
function parseIr_(text) {
  const when = text.match(/일시\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/);
  if (!when) return null;
  const purpose = (text.match(/개최목적\s*(.+?)\s*4\.\s*개최방법/) || [])[1] || '';
  const method = (text.match(/개최방법\s*(.+?)\s*5\./) || [])[1] || '';
  return { date: when[1], time: when[2] || null, purpose: purpose, method: method };
}

/** '2026년 3분기 실적발표' → '2026Q3'. 연간·결산은 4분기로 본다. */
function quarterKey_(purpose) {
  const q = purpose.match(/(\d{4})\s*년\s*(\d)\s*분기/);
  if (q) return q[1] + 'Q' + q[2];
  const y = purpose.match(/(\d{4})\s*년.*(연간|결산)/);
  return y ? y[1] + 'Q4' : null;
}

function isEarningsReport_(row) {
  return row.report_nm.indexOf(KR_EARNINGS_REPORT) !== -1 && row.report_nm.indexOf('기재정정') === -1;
}

function krTargets_(stocks, today, until) {
  const targets = {};
  const todayStr = ymd_(today), untilStr = ymd_(until);

  stocks.forEach(([code, name, corpCode]) => {
    if (!corpCode) return;
    const recent = dartList_(corpCode, ymd_(addDays_(today, -KR_RECENT_DAYS), ''), ymd_(today, ''));

    // 1) 확정: 개최목적에 '실적'이 들어간 IR 공시. 정정 공시가 있으면 최신 공시를 쓴다.
    const confirmedDates = [];
    const seen = {};
    recent.filter(r => r.report_nm.indexOf('기업설명회') !== -1).forEach(r => {
      const ir = parseIr_(dartDocumentText_(r.rcept_no));
      Utilities.sleep(200);
      if (!ir || ir.purpose.indexOf('실적') === -1) return;
      if (ir.date < todayStr || ir.date > untilStr) return;
      const quarter = quarterKey_(ir.purpose) || ir.date;
      if (seen[quarter]) return;
      seen[quarter] = true;
      confirmedDates.push(ir.date);

      const description = [
        ir.purpose,
        '방법: ' + ir.method,
        'IR 공시: https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + r.rcept_no,
        '갱신: ' + new Date().toLocaleString('ko-KR'),
      ].join('\n');
      const key = 'KR_' + code + '_' + quarter;
      if (ir.time) {
        const start = Utilities.parseDate(ir.date + ' ' + ir.time, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
        targets[key] = {
          key: key, title: name + ' 실적발표 (IR)', allDay: false, start: start,
          end: new Date(start.getTime() + KR_IR_MINUTES * 60 * 1000), description: description,
        };
      } else {
        targets[key] = { key: key, title: name + ' 실적발표 (IR)', allDay: true, start: dateOnly_(ir.date), description: description };
      }
    });

    // 2) 예상: 작년 같은 시기의 분기 실적 공시일 + 364일(같은 요일).
    //    확정 IR이나 이미 나온 올해 실적 공시와 가까우면 넣지 않는다.
    const announced = recent.filter(isEarningsReport_).map(r => toDash_(r.rcept_dt));
    const lastYear = dartList_(corpCode, ymd_(addDays_(today, -364), ''), ymd_(addDays_(until, -364), ''));
    const estimates = [];
    lastYear.filter(isEarningsReport_).forEach(r => {
      const est = ymd_(addDays_(dateOnly_(toDash_(r.rcept_dt)), 364));
      if (est < todayStr || est > untilStr) return;
      const near = d => Math.abs(dateOnly_(d) - dateOnly_(est)) <= KR_MATCH_DAYS * DAY_MS;
      if (confirmedDates.some(near) || announced.some(near)) return;
      if (estimates.some(d => Math.abs(dateOnly_(d) - dateOnly_(est)) <= 3 * DAY_MS)) return;
      estimates.push(est);

      const key = 'KR_' + code + '_EST_' + est.replace(/-/g, '');
      targets[key] = {
        key: key,
        title: name + ' 실적 (예상)',
        allDay: true,
        start: dateOnly_(est),
        description: [
          '작년 실적 공시일(' + toDash_(r.rcept_dt) + ') 기준 예상 일정입니다.',
          '회사가 IR 개최를 공시하면 확정 일정으로 바뀝니다.',
          '작년 공시: https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + r.rcept_no,
          '갱신: ' + new Date().toLocaleString('ko-KR'),
        ].join('\n'),
      };
    });
  });
  return targets;
}

/* ───────────── 날짜 도우미 (스크립트 시간대: 서울) ───────────── */

/** 'yyyy-MM-dd' → 그날 0시 Date */
function dateOnly_(str) {
  const p = str.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function addDays_(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Date → 'yyyy-MM-dd' (sep를 ''로 주면 'yyyyMMdd') */
function ymd_(date, sep) {
  const s = sep === undefined ? '-' : sep;
  return Utilities.formatDate(date, Session.getScriptTimeZone(), ['yyyy', 'MM', 'dd'].join(s));
}

/** 'yyyyMMdd' → 'yyyy-MM-dd' */
function toDash_(str) {
  return str.slice(0, 4) + '-' + str.slice(4, 6) + '-' + str.slice(6, 8);
}

/* ───────────── 캘린더 반영 ───────────── */

function sameTiming_(event, target) {
  if (event.isAllDayEvent() !== target.allDay) return false;
  const start = target.allDay ? event.getAllDayStartDate() : event.getStartTime();
  return start.getTime() === target.start.getTime();
}

function createEvent_(calendar, target) {
  const event = target.allDay
    ? calendar.createAllDayEvent(target.title, target.start, { description: target.description })
    : calendar.createEvent(target.title, target.start, target.end, { description: target.description });
  event.setTag(TAG_KEY, target.key);
}

function startLabel_(eventOrTarget) {
  const isEvent = typeof eventOrTarget.getStartTime === 'function';
  const allDay = isEvent ? eventOrTarget.isAllDayEvent() : eventOrTarget.allDay;
  const start = isEvent ? (allDay ? eventOrTarget.getAllDayStartDate() : eventOrTarget.getStartTime()) : eventOrTarget.start;
  return Utilities.formatDate(start, Session.getScriptTimeZone(), allDay ? 'MM/dd' : 'MM/dd HH:mm');
}

/** 국내 일정 키에서 종목코드를 꺼낸다. 'KR_005930_2026Q3' → '005930' */
function krCode_(key) {
  return key.split('_')[1];
}

/** 실행 결과를 '운영기록' 시트에 한 줄 추가한다. */
function appendLog_(row) {
  const sheet = getSheet_(LOG_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_HEADER);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow(row);
}

/** 매일 실행: 관심종목의 실적 일정을 캘린더에 생성·수정·정리하고 결과를 운영기록에 남긴다. */
function syncEarnings() {
  const runAt = new Date();
  try {
    const s = syncEarnings_();
    appendLog_([runAt, '성공', s.usCount, s.krStockCount, s.total, s.krCount,
      s.created, s.updated, s.removed, s.converted, s.failed.join(', '), s.changes.join('\n')]);
  } catch (error) {
    appendLog_([runAt, '실패', '', '', '', '', '', '', '', '', '', String(error)]);
    throw error; // 구글이 실패 알림 메일을 보내도록 다시 던진다.
  }
}

function syncEarnings_() {
  const calendar = CalendarApp.getCalendarById(props_().getProperty('CALENDAR_ID'));
  if (!calendar) throw new Error('CALENDAR_ID에 해당하는 캘린더를 찾을 수 없습니다.');

  const symbols = readRows_(SHEET_NAME, 1).map(row => row[0]);
  if (!symbols.length) throw new Error("'관심종목' 시트가 비어 있습니다. PC에서 sync_watchlist.py를 먼저 실행하세요.");
  const krStocks = readRows_(KR_SHEET_NAME, 3);
  const krNames = {};
  krStocks.forEach(([code, name]) => { krNames[code] = name; });

  const today = dateOnly_(ymd_(new Date()));
  const until = addDays_(today, LOOKAHEAD_DAYS);

  const us = usTargets_(symbols, ymd_(today), ymd_(until));
  const targets = us.targets;
  let krCount = 0;
  if (krStocks.length && props_().getProperty('OPENDART_API_KEY')) {
    const kr = krTargets_(krStocks, today, until);
    krCount = Object.keys(kr).length;
    Object.assign(targets, kr);
  }

  // 이 스크립트가 만든 일정만 대상으로 한다(태그로 구분).
  const existing = {};
  calendar.getEvents(addDays_(today, -1), addDays_(until, 2)).forEach(event => {
    const key = event.getTag(TAG_KEY);
    if (key) existing[key] = event;
  });

  const changes = [];
  const createdKrConfirmed = [];
  let created = 0, updated = 0, removed = 0;
  Object.keys(targets).forEach(key => {
    const target = targets[key];
    const event = existing[key];
    if (!event) {
      createEvent_(calendar, target);
      created++;
      changes.push('추가: ' + target.title + ' ' + startLabel_(target));
      if (key.indexOf('KR_') === 0 && key.indexOf('_EST_') === -1) createdKrConfirmed.push(krCode_(key));
    } else if (!sameTiming_(event, target)) {
      changes.push('변경: ' + target.title + ' ' + startLabel_(event) + ' → ' + startLabel_(target));
      event.deleteEvent();
      createEvent_(calendar, target);
      updated++;
    } else {
      event.setTitle(target.title);
      event.setDescription(target.description);
    }
  });

  // 앞으로 남은 일정 중 더 이상 필요 없는 것을 지운다.
  //  - 국내: 매번 전부 다시 계산하므로 이번 결과에 없으면 지운다(예상 → 확정 전환 포함).
  //  - 미국: 관심종목에서 빠진 종목만 지운다.
  let converted = 0;
  Object.keys(existing).forEach(key => {
    const event = existing[key];
    if (key in targets || event.getStartTime() < today) return;
    const isKr = key.indexOf('KR_') === 0;
    if (isKr || symbols.indexOf(key.split('_')[0]) === -1) {
      if (isKr && key.indexOf('_EST_') !== -1 && createdKrConfirmed.indexOf(krCode_(key)) !== -1) {
        converted++;
        changes.push('예상→확정: ' + (krNames[krCode_(key)] || krCode_(key)) + ' 예상 ' + startLabel_(event) + ' 삭제');
      } else {
        changes.push('삭제: ' + event.getTitle() + ' ' + startLabel_(event));
      }
      event.deleteEvent();
      removed++;
    }
  });

  const summary = {
    usCount: symbols.length, krStockCount: krStocks.length, total: Object.keys(targets).length,
    krCount: krCount, created: created, updated: updated, removed: removed, converted: converted,
    failed: us.failed, changes: changes,
  };
  console.log('미국 ' + summary.usCount + '종목, 국내 ' + summary.krStockCount + '종목 → 일정 '
    + summary.total + '건 (국내 ' + krCount + '건, 새로 만듦 ' + created + ', 시간 변경 ' + updated
    + ', 삭제 ' + removed + ', 예상→확정 ' + converted + ', 미국 조회 실패 ' + us.failed.length + ')');
  return summary;
}

/** 한 번만 실행: 매일 오전 7시(한국 시간) 자동 실행 트리거를 만든다. */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncEarnings')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncEarnings').timeBased().everyDays(1).atHour(7).create();
}
