// Apps Script 전역 객체(캘린더, 시트, 속성, 메일, URL 호출)를 흉내 내어 Code.gs를 Node에서 실행한다.
// 외부 API는 테스트가 넘겨주는 가짜 응답으로 대신하므로 키 없이 돌아간다.
process.env.TZ = 'Asia/Seoul';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// GAS_CODE_PATH로 다른 Code.gs를 지정할 수 있다(일부러 고장 낸 코드로 테스트가 실패하는지 확인할 때).
const CODE_PATH = process.env.GAS_CODE_PATH || path.join(__dirname, '..', 'apps_script', 'Code.gs');
const FIXTURES = path.join(__dirname, 'fixtures');
const DAY_MS = 24 * 60 * 60 * 1000;

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/* ── 시간대 계산 (Utilities.parseDate / formatDate 대체) ── */

function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return { y: get('year'), M: get('month'), d: get('day'), H: get('hour'), m: get('minute'), s: get('second') };
}

function tzOffset(utcMs, tz) {
  const p = zonedParts(new Date(utcMs), tz);
  return Date.UTC(+p.y, +p.M - 1, +p.d, +p.H, +p.m, +p.s) - utcMs;
}

/** tz 기준 현지 시각 'yyyy-MM-dd HH:mm'을 실제 시각(Date)으로 바꾼다. 서머타임 반영. */
function parseZoned(text, tz) {
  const [d, t] = text.split(' ');
  const [y, M, day] = d.split('-').map(Number);
  const [H, m] = (t || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, M - 1, day, H, m);
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz);
  return new Date(utc);
}

function formatZoned(date, tz, pattern) {
  const p = zonedParts(date, tz);
  return pattern.replace('yyyy', p.y).replace('MM', p.M).replace('dd', p.d).replace('HH', p.H).replace('mm', p.m);
}

/** 서울 기준 오늘에서 offset일 떨어진 날짜 'yyyy-MM-dd' */
function seoulDate(offsetDays = 0) {
  return formatZoned(new Date(Date.now() + offsetDays * DAY_MS), 'Asia/Seoul', 'yyyy-MM-dd');
}

/* ── 시트 ── */

function makeSheet() {
  const sheet = {
    rows: [],
    numberFormats: [],
    clearContents() { this.rows = []; },
    getLastRow() { return this.rows.length; },
    appendRow(row) { this.rows.push(row.slice()); },
    setFrozenRows() {},
    getRange(r, c, nr, nc) {
      return {
        setValues: values => {
          values.forEach((row, i) => {
            const target = sheet.rows[r - 1 + i] || [];
            row.forEach((v, j) => { target[c - 1 + j] = v; });
            sheet.rows[r - 1 + i] = target;
          });
          return this.getRange(r, c, nr, nc);
        },
        setNumberFormat: format => { sheet.numberFormats.push({ r, c, nr, nc, format }); return this.getRange(r, c, nr, nc); },
        getValues: () => sheet.rows.slice(r - 1, r - 1 + nr).map(row => {
          const out = [];
          for (let j = 0; j < nc; j++) out.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          return out;
        }),
      };
    },
  };
  return sheet;
}

/* ── 캘린더 ── */

function makeCalendar() {
  const calendar = {
    events: [],
    add(title, start, end, allDay, tag, description = '') {
      const event = {
        title, start, end, allDay, description, tags: {},
        getTag(k) { return this.tags[k]; },
        setTag(k, v) { this.tags[k] = v; },
        isAllDayEvent() { return this.allDay; },
        getAllDayStartDate() { return this.start; },
        getStartTime() { return this.start; },
        getTitle() { return this.title; },
        setTitle(t) { this.title = t; },
        setDescription(d) { this.description = d; },
        deleteEvent() { calendar.events = calendar.events.filter(e => e !== this); },
      };
      if (tag) event.tags.earningsKey = tag;
      calendar.events.push(event);
      return event;
    },
    getEvents(from, to) { return calendar.events.filter(e => e.start >= from && e.start < to); },
    createEvent(title, start, end, opts) { return calendar.add(title, start, end, false, null, opts && opts.description); },
    createAllDayEvent(title, start, opts) { return calendar.add(title, start, null, true, null, opts && opts.description); },
    find(title) { return calendar.events.find(e => e.title.startsWith(title)); },
  };
  return calendar;
}

/* ── 가짜 외부 응답 ── */

/** Finnhub: { SYMBOL: [rows] } 또는 { SYMBOL: 401 } */
function finnhubHandler(bySymbol) {
  return url => {
    const symbol = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]);
    const value = bySymbol[symbol] === undefined ? [] : bySymbol[symbol];
    if (typeof value === 'number') return { code: value, text: '' };
    return { code: 200, text: JSON.stringify({ earningsCalendar: value }) };
  };
}

/** OpenDART: lists = { corpCode: [{rcept_dt, report_nm, rcept_no}] (최신순) }, docs = { rcept_no: 본문 } */
function dartHandler(lists, docs) {
  return url => {
    const q = Object.fromEntries(new URL(url).searchParams);
    if (url.includes('/list.json')) {
      const rows = (lists[q.corp_code] || []).filter(r => r.rcept_dt >= q.bgn_de && r.rcept_dt <= q.end_de);
      if (!rows.length) return { code: 200, text: JSON.stringify({ status: '013', message: '조회된 데이타가 없습니다.' }) };
      return { code: 200, text: JSON.stringify({ status: '000', total_page: 1, list: rows }) };
    }
    if (url.includes('/document.xml')) return { code: 200, zipText: docs[q.rcept_no] || '' };
    throw new Error('예상하지 못한 URL: ' + url);
  };
}

/* ── Apps Script 환경 만들기 ── */

function createGas(options = {}) {
  const props = Object.assign({ CALENDAR_ID: 'cal', SYNC_TOKEN: 'secret-token', FINNHUB_API_KEY: 'test' }, options.props);
  const sheets = {};
  const calendar = makeCalendar();
  const mails = [];
  const logs = [];
  const fetchers = { finnhub: options.finnhub || (() => ({ code: 200, text: '{"earningsCalendar":[]}' })), dart: options.dart };

  const response = r => ({
    getResponseCode: () => r.code,
    getContentText: () => r.text,
    getBlob: () => ({
      _text: r.zipText,
      getBytes: () => [r.zipText ? 0x50 : 0x7b],
      setContentType() { return this; },
    }),
  });

  const context = {
    console: { log: m => logs.push(m), warn: m => logs.push(m) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: name => sheets[name] || null,
      insertSheet: name => (sheets[name] = makeSheet()),
      getUrl: () => 'https://docs.google.com/spreadsheets/d/test',
    }) },
    CalendarApp: { getCalendarById: id => (id === props.CALENDAR_ID ? calendar : null) },
    UrlFetchApp: { fetch: url => response(url.includes('opendart') ? fetchers.dart(url) : fetchers.finnhub(url)) },
    Utilities: {
      parseDate: (text, tz) => parseZoned(text, tz),
      formatDate: formatZoned,
      sleep() {},
      unzip: blob => [{ getDataAsString: () => blob._text }],
    },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
    MailApp: { sendEmail: mail => mails.push(mail) },
    ContentService: {
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' },
    },
    ScriptApp: {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context);

  return {
    context, props, sheets, calendar, mails, logs,
    sheet: name => sheets[name] || (sheets[name] = makeSheet()),
    /** Code.gs 안의 함수를 테스트용으로 바꾼다. */
    replace: (name, fn) => { context.__replacement = fn; vm.runInContext(name + ' = __replacement;', context); },
    /** 관심종목 시트를 채운다. */
    setWatchlist(symbols, krRows = []) {
      this.sheet('관심종목').rows = [['종목', '마지막 동기화']].concat(symbols.map(s => [s]));
      if (krRows.length) this.sheet('국내종목').rows = [['종목코드', '종목명', 'DART 고유번호']].concat(krRows);
    },
    logRow: () => { const rows = sheets['운영기록'].rows; return rows[rows.length - 1]; },
    logValue(column) { return this.logRow()[sheets['운영기록'].rows[0].indexOf(column)]; },
  };
}

module.exports = { createGas, finnhubHandler, dartHandler, fixture, parseZoned, formatZoned, seoulDate, DAY_MS };
