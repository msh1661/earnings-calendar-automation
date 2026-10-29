/**
 * 실적발표 캘린더 자동화 (구글 시트에 연결된 Apps Script)
 *
 * - doPost: PC의 sync_watchlist.py가 보낸 키움 관심종목을 시트에 저장한다.
 *     미국 종목은 '관심종목' 시트, 국내 지정 그룹은 '국내종목' 시트.
 * - syncEarnings: 매일 트리거로 실행되어 실적 일정을 캘린더에 반영한다.
 *     미국: Finnhub 실적 캘린더
 *     국내: OpenDART '기업설명회(IR) 개최' 공시(확정) + 작년 같은 시기 실적 공시일(예상)
 *     발표가 끝난 최근 일정에는 실제 실적(미국)이나 잠정실적 공시 링크(국내)를 덧붙인다.
 *     PC 동기화가 오래 멈췄거나 실행이 실패하면 경고 메일을 보낸다.
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 다음 값을 넣는다.
 *   FINNHUB_API_KEY, SYNC_TOKEN, CALENDAR_ID, OPENDART_API_KEY
 *   ALERT_EMAILS: 경고 메일 받을 주소(쉼표로 구분, 선택)
 */

const LOOKAHEAD_DAYS = 90;
const RESULT_LOOKBACK_DAYS = 7; // 발표 후 실제 실적을 덧붙일 기간
const SHEET_NAME = '관심종목';
const KR_SHEET_NAME = '국내종목';
const LOG_SHEET_NAME = '운영기록';
const LOG_HEADER = ['실행 시각', '결과', '미국 종목', '국내 종목', '전체 일정', '국내 일정',
  '새로 만듦', '시간 변경', '삭제', '예상→확정 전환', '미국 조회 실패', '변경 내역',
  '실적 결과 반영', '경고'];

// 경고: PC 동기화가 이 일수 이상 없으면 경고, 같은 경고는 이 일수 안에 다시 보내지 않는다.
const SYNC_STALE_DAYS = 7;
const ALERT_REPEAT_DAYS = 3;
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
  props_().setProperty('LAST_SYNC_AT', new Date().toISOString());
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

/** 예상 대비 실제 차이(%). 비교할 수 없으면 null. */
function surprise_(actual, estimate) {
  if (actual == null || estimate == null || estimate === 0) return null;
  return (actual - estimate) / Math.abs(estimate) * 100;
}

/**
 * 발표가 끝난 행이면 제목에 붙일 요약과 설명에 넣을 결과 줄을 만든다. 아직이면 null.
 * EPS 차이가 ±1% 안이면 '부합'으로 본다.
 */
function resultInfo_(row) {
  if (row.epsActual == null && row.revenueActual == null) return null;
  const pct = v => (v == null ? '' : ' (' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%)');
  const billions = v => (v ? (v / 1e9).toFixed(1) + 'B' : '-');
  const epsSurprise = surprise_(row.epsActual, row.epsEstimate);
  const parts = [];
  if (row.epsActual != null) {
    parts.push('EPS 실제 ' + row.epsActual.toFixed(2) + ' / 예상 '
      + (row.epsEstimate == null ? '-' : row.epsEstimate.toFixed(2)) + pct(epsSurprise));
  }
  if (row.revenueActual != null) {
    parts.push('매출 실제 ' + billions(row.revenueActual) + ' / 예상 ' + billions(row.revenueEstimate)
      + pct(surprise_(row.revenueActual, row.revenueEstimate)));
  }
  const label = epsSurprise == null ? '발표 완료'
    : epsSurprise > 1 ? 'EPS 상회' : epsSurprise < -1 ? 'EPS 하회' : 'EPS 부합';
  return { label: label, line: '[발표 결과] ' + parts.join(' · ') };
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
  const result = resultInfo_(row);
  const description = [
    quarter + ' 실적',
    '미국 현지 발표일: ' + row.date + (info ? ' (' + info.label + ', 대표 시각 ' + info.time + ' ET)' : ' (시간 미정)'),
    'EPS 예상: ' + eps,
    '매출 예상: ' + revenue,
  ].concat(result ? [result.line] : [], [
    '시각은 대표값입니다. 정확한 시각은 회사 IR 공지를 확인하세요.',
    '갱신: ' + new Date().toLocaleString('ko-KR'),
  ]).join('\n');
  const suffix = result ? ' · ' + result.label : '';

  if (info) {
    const start = Utilities.parseDate(row.date + ' ' + info.time, 'America/New_York', 'yyyy-MM-dd HH:mm');
    return {
      key: symbol + '_' + row.year + 'Q' + row.quarter,
      title: symbol + ' 실적 (' + info.label + ')' + suffix,
      allDay: false,
      start: start,
      end: new Date(start.getTime() + EVENT_MINUTES * 60 * 1000),
      description: description,
      hasResult: !!result,
    };
  }
  return {
    key: symbol + '_' + row.year + 'Q' + row.quarter,
    title: symbol + ' 실적 (' + (result ? '발표' : '예정') + ')' + suffix,
    allDay: true,
    start: dateOnly_(row.date),
    description: description,
    hasResult: !!result,
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

const dartLink_ = rceptNo => 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + rceptNo;

/**
 * 국내 종목 일정. from~until 사이의 확정 IR과 today~until 사이의 예상 일정을 만든다.
 * from은 발표가 끝난 IR에 잠정실적 공시 링크를 붙이기 위해 today보다 앞선 날짜를 준다.
 */
function krTargets_(stocks, today, until, from) {
  const targets = {};
  const todayStr = ymd_(today), untilStr = ymd_(until), fromStr = ymd_(from || today);

  stocks.forEach(([code, name, corpCode]) => {
    if (!corpCode) return;
    const recent = dartList_(corpCode, ymd_(addDays_(today, -KR_RECENT_DAYS), ''), ymd_(today, ''));
    const reports = recent.filter(isEarningsReport_);

    // 1) 확정: 개최목적에 '실적'이 들어간 IR 공시. 정정 공시가 있으면 최신 공시를 쓴다.
    const confirmedDates = [];
    const seen = {};
    recent.filter(r => r.report_nm.indexOf('기업설명회') !== -1).forEach(r => {
      const ir = parseIr_(dartDocumentText_(r.rcept_no));
      Utilities.sleep(200);
      if (!ir || ir.purpose.indexOf('실적') === -1) return;
      if (ir.date < fromStr || ir.date > untilStr) return;
      const quarter = quarterKey_(ir.purpose) || ir.date;
      if (seen[quarter]) return;
      seen[quarter] = true;
      confirmedDates.push(ir.date);

      // IR 일시 전후 3일 안에 올라온 잠정실적 공시를 발표 결과로 본다.
      const report = reports.find(p => Math.abs(dateOnly_(toDash_(p.rcept_dt)) - dateOnly_(ir.date)) <= 3 * DAY_MS);
      const description = [
        ir.purpose,
        '방법: ' + ir.method,
        'IR 공시: ' + dartLink_(r.rcept_no),
      ].concat(report ? ['[발표 결과] ' + report.report_nm.trim() + ': ' + dartLink_(report.rcept_no)] : [], [
        '갱신: ' + new Date().toLocaleString('ko-KR'),
      ]).join('\n');
      const key = 'KR_' + code + '_' + quarter;
      const title = name + ' 실적발표 (IR)' + (report ? ' · 공시됨' : '');
      if (ir.time) {
        const start = Utilities.parseDate(ir.date + ' ' + ir.time, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
        targets[key] = {
          key: key, title: title, allDay: false, start: start,
          end: new Date(start.getTime() + KR_IR_MINUTES * 60 * 1000), description: description, hasResult: !!report,
        };
      } else {
        targets[key] = { key: key, title: title, allDay: true, start: dateOnly_(ir.date), description: description, hasResult: !!report };
      }
    });

    // 2) 예상: 작년 같은 시기의 분기 실적 공시일 + 364일(같은 요일).
    //    확정 IR이나 이미 나온 올해 실적 공시와 가까우면 넣지 않는다.
    const announced = reports.map(r => toDash_(r.rcept_dt));
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
          '작년 공시: ' + dartLink_(r.rcept_no),
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

/** 실행 결과를 '운영기록' 시트에 한 줄 추가한다. 열이 늘어난 경우 머리글도 최신으로 맞춘다. */
function appendLog_(row) {
  const sheet = getSheet_(LOG_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_HEADER);
    sheet.setFrozenRows(1);
  } else {
    sheet.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]);
  }
  sheet.appendRow(row);
}

/* ───────────── 경고 메일 ───────────── */

/** PC에서 마지막으로 관심종목을 보낸 시각. 예전 웹앱 버전이면 시트 머리글의 표시 시각을 읽는다. */
function lastSyncAt_() {
  const saved = props_().getProperty('LAST_SYNC_AT');
  if (saved) return new Date(saved);
  const header = String(getSheet_(SHEET_NAME).getRange(1, 2, 1, 1).getValues()[0][0] || '');
  const m = header.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[5]) % 12 + (m[4] === '오후' ? 12 : 0);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, Number(m[6]));
}

function alertRecipients_() {
  return (props_().getProperty('ALERT_EMAILS') || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** ALERT_EMAILS로 경고를 보낸다. 같은 종류는 ALERT_REPEAT_DAYS 안에 다시 보내지 않는다. 보냈으면 true. */
function sendAlert_(type, subject, body) {
  const to = alertRecipients_();
  if (!to.length) return false;
  const sentKey = 'ALERT_SENT_' + type;
  const lastSent = Number(props_().getProperty(sentKey) || 0);
  if (Date.now() - lastSent < ALERT_REPEAT_DAYS * DAY_MS) return false;
  MailApp.sendEmail({
    to: to.join(','),
    subject: '[실적 캘린더] ' + subject,
    body: body + '\n\n운영기록: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  });
  props_().setProperty(sentKey, String(Date.now()));
  return true;
}

/** 실행 결과를 보고 경고가 필요한 상황을 찾아 메일을 보낸다. 운영기록에 남길 문구 목록을 돌려준다. */
function checkAlerts_(summary) {
  const notes = [];
  const record = (text, sent) => notes.push(text + (sent ? ' · 메일 발송' : ' · 메일 생략(최근 발송 또는 수신자 없음)'));

  const last = lastSyncAt_();
  const days = last ? Math.floor((Date.now() - last.getTime()) / DAY_MS) : null;
  if (days === null || days >= SYNC_STALE_DAYS) {
    const what = days === null ? '관심종목 동기화 기록이 없습니다' : '관심종목 동기화가 ' + days + '일째 없습니다';
    record(what, sendAlert_('STALE_SYNC', what,
      'PC의 sync_watchlist.py가 실행되지 않았거나 실패했습니다.\n'
      + '키움 키 만료, 집 공인 IP 변경(오류 8010), PC 미사용 등을 확인하고 PC의 sync.log를 열어 보세요.\n'
      + '실적 일정은 마지막으로 저장된 관심종목으로 계속 갱신되고 있습니다.'));
  }
  if (summary.failed.length && summary.failed.length * 2 >= summary.usCount) {
    const what = '미국 종목 ' + summary.usCount + '개 중 ' + summary.failed.length + '개 조회 실패';
    record(what, sendAlert_('US_FETCH', what,
      '실패 종목: ' + summary.failed.join(', ') + '\nFinnhub 키(스크립트 속성 FINNHUB_API_KEY)나 호출 제한을 확인하세요.'));
  }
  return notes;
}

/** 매일 실행: 관심종목의 실적 일정을 캘린더에 생성·수정·정리하고 결과를 운영기록에 남긴다. */
function syncEarnings() {
  const runAt = new Date();
  let s;
  try {
    s = syncEarnings_();
  } catch (error) {
    let note = '';
    try {
      note = sendAlert_('RUN_FAILED', '매일 실행 실패', String(error)) ? '실행 실패 · 메일 발송' : '실행 실패';
    } catch (mailError) {
      note = '실행 실패 · 메일 오류: ' + mailError;
    }
    appendLog_([runAt, '실패', '', '', '', '', '', '', '', '', '', String(error), '', note]);
    throw error; // 구글 기본 실패 알림도 받을 수 있도록 다시 던진다.
  }
  const alerts = checkAlerts_(s);
  appendLog_([runAt, '성공', s.usCount, s.krStockCount, s.total, s.krCount,
    s.created, s.updated, s.removed, s.converted, s.failed.join(', '), s.changes.join('\n'),
    s.results, alerts.join('\n')]);
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
  const from = addDays_(today, -RESULT_LOOKBACK_DAYS);

  const us = usTargets_(symbols, ymd_(from), ymd_(until));
  const targets = us.targets;
  let krCount = 0;
  if (krStocks.length && props_().getProperty('OPENDART_API_KEY')) {
    const kr = krTargets_(krStocks, today, until, from);
    krCount = Object.keys(kr).length;
    Object.assign(targets, kr);
  }

  // 이 스크립트가 만든 일정만 대상으로 한다(태그로 구분).
  const existing = {};
  calendar.getEvents(addDays_(from, -1), addDays_(until, 2)).forEach(event => {
    const key = event.getTag(TAG_KEY);
    if (key) existing[key] = event;
  });

  const changes = [];
  const createdKrConfirmed = [];
  let created = 0, updated = 0, removed = 0, results = 0;
  Object.keys(targets).forEach(key => {
    const target = targets[key];
    const event = existing[key];
    // 발표 결과가 새로 붙는 경우(처음 만들거나 제목이 바뀌는 경우)를 센다.
    if (target.hasResult && (!event || event.getTitle() !== target.title)) {
      results++;
      changes.push('결과: ' + target.title);
    }
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
    results: results, failed: us.failed, changes: changes,
  };
  console.log('미국 ' + summary.usCount + '종목, 국내 ' + summary.krStockCount + '종목 → 일정 '
    + summary.total + '건 (국내 ' + krCount + '건, 새로 만듦 ' + created + ', 시간 변경 ' + updated
    + ', 삭제 ' + removed + ', 예상→확정 ' + converted + ', 실적 결과 ' + results
    + ', 미국 조회 실패 ' + us.failed.length + ')');
  return summary;
}

/** 필요할 때 실행: ALERT_EMAILS로 테스트 메일을 보내 수신 여부를 확인한다. 경고 중복 방지 기록은 바꾸지 않는다. */
function sendTestAlert() {
  const to = alertRecipients_();
  if (!to.length) throw new Error('스크립트 속성 ALERT_EMAILS가 비어 있습니다.');
  const last = lastSyncAt_();
  MailApp.sendEmail({
    to: to.join(','),
    subject: '[실적 캘린더] 테스트 메일',
    body: '경고 메일 수신 확인용 테스트입니다. 실제 문제가 생긴 것은 아닙니다.\n\n'
      + '받는 주소: ' + to.join(', ') + '\n'
      + '마지막 PC 동기화: ' + (last ? last.toLocaleString('ko-KR') : '기록 없음') + '\n'
      + '경고 조건: 동기화 ' + SYNC_STALE_DAYS + '일 이상 없음, 매일 실행 실패, 미국 종목 절반 이상 조회 실패'
      + '\n\n운영기록: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  });
  console.log(to.length + '개 주소로 테스트 메일을 보냈습니다: ' + to.join(', '));
}

/** 한 번만 실행: 매일 오전 7시(한국 시간) 자동 실행 트리거를 만든다. */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncEarnings')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncEarnings').timeBased().everyDays(1).atHour(7).create();
}
