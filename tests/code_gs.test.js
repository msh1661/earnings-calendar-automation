// Code.gs 검증. 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas, finnhubHandler, dartHandler, earningsReportText, fixture, formatZoned, seoulDate, DAY_MS } = require('./gas_harness');

const kst = date => formatZoned(date, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
const usRow = (overrides = {}) => Object.assign({
  symbol: 'AAPL', date: seoulDate(5), hour: 'amc', year: 2026, quarter: 4,
  epsEstimate: 2.02, epsActual: null, revenueEstimate: 115.5e9, revenueActual: null,
}, overrides);

/* ───────── 미국 일정 변환 ───────── */

test('장후 발표는 서머타임 기간과 이후의 한국 시각이 다르다', () => {
  const { context } = createGas();
  assert.equal(kst(context.toEvent_(usRow({ date: '2026-10-29' }), 'AAPL').start), '2026-10-30 05:00');
  assert.equal(kst(context.toEvent_(usRow({ date: '2026-11-02' }), 'AAPL').start), '2026-11-03 06:00');
});

test('장전 발표는 한국 시각 같은 날 밤으로 들어간다', () => {
  const { context } = createGas();
  const event = context.toEvent_(usRow({ date: '2026-11-02', hour: 'bmo' }), 'TEM');
  assert.equal(kst(event.start), '2026-11-02 21:00');
  assert.equal(event.title, 'TEM 실적 (장전)');
});

test('발표 시간이 없으면 종일 일정(예정)으로 만든다', () => {
  const { context } = createGas();
  const event = context.toEvent_(usRow({ date: '2026-12-08', hour: '' }), 'ORCL');
  assert.equal(event.allDay, true);
  assert.equal(event.title, 'ORCL 실적 (예정)');
});

test('ADR은 요청한 티커로 표시하고 금액은 현지 통화로 표기한다', () => {
  const { context } = createGas();
  const event = context.toEvent_(usRow({ symbol: '2330.TW' }), 'TSM');
  assert.equal(event.key, 'TSM_2026Q4');
  assert.match(event.title, /^TSM /);
  assert.match(event.description, /2330\.TW 현지 통화/);
});

test('발표 후 실제 EPS로 상회·부합·하회를 붙인다', () => {
  const { context } = createGas();
  const beat = context.toEvent_(usRow({ epsActual: 2.15, revenueActual: 118.2e9 }), 'AAPL');
  assert.equal(beat.title, 'AAPL 실적 (장후) · EPS 상회');
  assert.equal(beat.hasResult, true);
  assert.match(beat.description, /EPS 실제 2\.15 \/ 예상 2\.02 \(\+6\.4%\)/);
  assert.match(beat.description, /매출 실제 118\.2B \/ 예상 115\.5B \(\+2\.3%\)/);
  assert.match(context.toEvent_(usRow({ epsActual: 2.03 }), 'AAPL').title, /EPS 부합$/);
  assert.match(context.toEvent_(usRow({ epsActual: 1.80 }), 'AAPL').title, /EPS 하회$/);
  assert.equal(context.toEvent_(usRow(), 'AAPL').hasResult, false);
});

/* ───────── 국내 IR 공시 해석 ───────── */

test('실적 IR 공시에서 일시와 분기를 읽는다', () => {
  const { context } = createGas();
  const ir = context.parseIr_(fixture('dart_ir_naver_q3.txt'));
  assert.equal(ir.date, '2026-11-12');
  assert.equal(ir.time, '09:00');
  assert.match(ir.purpose, /실적/);
  assert.equal(context.quarterKey_(ir.purpose), '2026Q3');
});

test('컨퍼런스 참가 IR은 실적 목적이 아니다', () => {
  const { context } = createGas();
  const ir = context.parseIr_(fixture('dart_ir_hyundai_conference.txt'));
  assert.equal(ir.date, '2026-09-09');
  assert.doesNotMatch(ir.purpose, /실적/);
});

test('연간·결산 IR은 4분기로 본다', () => {
  const { context } = createGas();
  assert.equal(context.quarterKey_('2026년 연간 경영실적 발표'), '2026Q4');
  assert.equal(context.quarterKey_('투자자 이해도 제고'), null);
});

/* ───────── 국내 일정 만들기 (기준일 2026-10-29 고정) ───────── */

function krCase() {
  const doc = (date, purpose) => '기업설명회(IR) 개최(안내공시) 1. 일시 및 장소 일시 ' + date
    + ' 장소 - 2. 참가 대상자 투자자 3. 개최목적 ' + purpose + ' 4. 개최방법 컨퍼런스콜 5. 후원기관 자사 주관';
  const lists = {
    // NAVER: 실적 IR(11/12)
    N: [{ rcept_dt: '20261020', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 'n-ir' }],
    // 현대차: 컨퍼런스 IR만 있고(지난 것, 앞으로 열릴 것), 작년 같은 시기에는 월별 판매 공시(영업(잠정)실적)만 있음
    H: [
      { rcept_dt: '20261015', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 'h-conf-next' },
      { rcept_dt: '20260903', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 'h-conf' },
      { rcept_dt: '20251201', report_nm: '영업(잠정)실적(공정공시)', rcept_no: 'h-sales' },
    ],
    // SK하이닉스: 지난 IR(10/28)과 같은 날 잠정실적, 정정 IR(최신)과 원래 IR
    S: [
      { rcept_dt: '20261028', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 's-result' },
      { rcept_dt: '20261020', report_nm: '[기재정정]기업설명회(IR)개최(안내공시)', rcept_no: 's-ir-fix' },
      { rcept_dt: '20261014', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 's-ir' },
    ],
    // 삼성전자: 작년 1/8 잠정실적 → 올해 예상 1/7, 작년 1/9 정정 공시는 무시
    E: [
      { rcept_dt: '20260109', report_nm: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'e-fix' },
      { rcept_dt: '20260108', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'e-last' },
    ],
    // LG전자: 작년 1/9 잠정실적이 있지만 올해 1/8 확정 IR이 이미 공시됨 → 예상 생략
    L: [
      { rcept_dt: '20261027', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 'l-ir' },
      { rcept_dt: '20260109', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'l-last' },
    ],
  };
  const docs = {
    'n-ir': fixture('dart_ir_naver_q3.txt'),
    'h-conf': fixture('dart_ir_hyundai_conference.txt'),
    // 날짜 조건을 통과하는 컨퍼런스 IR. '실적' 목적 필터만으로 걸러져야 한다.
    'h-conf-next': doc('2026-11-20 09:00', '컨퍼런스 참가를 통한 투자자 당사 이해도 제고'),
    's-ir-fix': doc('2026-10-28 09:00', '2026년 3분기 경영실적 발표'),
    's-ir': doc('2026-10-27 09:00', '2026년 3분기 경영실적 발표'),
    'l-ir': doc('2027-01-08 16:00', '2026년 4분기 경영실적 발표'),
  };
  const gas = createGas({ dart: dartHandler(lists, docs), props: { OPENDART_API_KEY: 'test' } });
  const { context } = gas;
  const today = context.dateOnly_('2026-10-29');
  const targets = context.krTargets_(
    [['035420', 'NAVER', 'N'], ['005380', '현대차', 'H'], ['000660', 'SK하이닉스', 'S'],
      ['005930', '삼성전자', 'E'], ['066570', 'LG전자', 'L']],
    today, context.addDays_(today, 90), context.addDays_(today, -7));
  return { targets, context };
}

test('실적 IR만 확정 일정이 되고 컨퍼런스 IR과 월별 판매 공시는 무시한다', () => {
  const { targets } = krCase();
  const keys = Object.keys(targets).sort();
  assert.deepEqual(keys, ['KR_000660_2026Q3', 'KR_005930_EST_20270107', 'KR_035420_2026Q3', 'KR_066570_2026Q4']);
  assert.equal(kst(targets.KR_035420_2026Q3.start), '2026-11-12 09:00');
  assert.equal(targets.KR_035420_2026Q3.title, 'NAVER 실적발표 (IR)');
});

test('정정 IR이 있으면 최신 공시의 일시를 쓴다', () => {
  const { targets } = krCase();
  assert.equal(kst(targets.KR_000660_2026Q3.start), '2026-10-28 09:00');
});

test('발표가 끝난 IR에는 같은 날 잠정실적 공시 링크를 붙인다', () => {
  const { targets } = krCase();
  const event = targets.KR_000660_2026Q3;
  assert.equal(event.title, 'SK하이닉스 실적발표 (IR) · 공시됨');
  assert.equal(event.hasResult, true);
  assert.match(event.description, /rcpNo=s-result/);
});

test('예상 일정은 작년 공시일 + 364일, 정정 공시는 제외, 확정 IR과 가까우면 생략', () => {
  const { targets } = krCase();
  const estimate = targets.KR_005930_EST_20270107;
  assert.equal(estimate.title, '삼성전자 실적 (예상)');
  assert.equal(estimate.allDay, true);
  assert.equal(Object.keys(targets).filter(k => k.startsWith('KR_066570_EST')).length, 0);
});

/* ───────── 국내 잠정실적 공시 해석 ───────── */

test('실제 잠정실적 공시에서 단위, 금액, 전기 대비, 전년 동기 대비를 읽는다', () => {
  const { context } = createGas();
  const report = context.parseEarningsReport_(fixture('dart_earnings_samsung_q3.txt'));
  assert.equal(report.unit, '억원');
  assert.equal(report.profit.current, 1074405);
  assert.equal(report.profit.qoq, 20.06);
  assert.equal(report.profit.lastYear, 121661);
  assert.equal(report.profit.yoy, 783.11);
  assert.equal(context.formatKrw_(report.revenue.current, report.unit), '195조 2,532억');
});

test('백만원 단위 공시도 같은 금액 표기로 바꾼다', () => {
  const { context } = createGas();
  const report = context.parseEarningsReport_(fixture('dart_earnings_skhynix_q3.txt'));
  assert.equal(report.unit, '백만원');
  assert.equal(context.formatKrw_(report.revenue.current, report.unit), '104조 6,155억');
  assert.equal(context.formatKrw_(94847, '백만원'), '948억');
});

test('조원 단위 잠정 공시와 전환 열이 없는 예전 양식도 읽는다', () => {
  const { context } = createGas();
  const billions = context.parseEarningsReport_(earningsReportText('조원',
    '195.00 171.50 13.70 - 86.06 126.59 -', '107.40 89.49 20.01 - 12.17 782.50 -'));
  assert.equal(context.formatKrw_(billions.revenue.current, billions.unit), '195조');
  assert.equal(context.formatKrw_(billions.profit.current, billions.unit), '107조 4,000억');
  const old = context.parseEarningsReport_(earningsReportText('조원',
    '74.00 79.14 -6.49 74.07 -0.09', '4.60 6.69 -31.24 10.44 -55.94'));
  assert.equal(old.profit.yoy, -55.94);
});

test('정정 전후 값만 있는 정정 공시를 읽지 못하면 같은 날 원 공시 값을 쓴다', () => {
  const gas = createGas({ props: { OPENDART_API_KEY: 'test' }, dart: dartHandler({
    S: [
      { rcept_dt: '20261029', report_nm: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'fix' },
      { rcept_dt: '20261029', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'orig' },
    ],
  }, {
    fix: '정정사항 정정전 정정후 매출액(당해실적) - 영업이익(당해실적) 195.00 107.40 195.25 107.44',
    orig: fixture('dart_earnings_samsung_q3.txt'),
  }) });
  const { context } = gas;
  const today = context.dateOnly_('2026-10-30');
  const targets = context.krTargets_([['005930', '삼성전자', 'S']], today, context.addDays_(today, 90), context.addDays_(today, -7));
  const event = targets.KR_005930_RESULT_20261029;
  assert.match(event.description, /매출 195조 2,532억/);
  assert.match(event.description, /rcpNo=orig/);
});

test('감소한 공시는 제목에 전년 대비 감소로 표시한다', () => {
  const { context } = createGas();
  const report = context.parseEarningsReport_(earningsReportText('백만원',
    '6,367,124 5,527,241 15.2 - 5,369,431 18.6 -', '94,847 245,754 -61.4 - 203,749 -53.4 -'));
  assert.equal(context.reportLabel_(report), '영업이익 전년 대비 감소');
  const lines = context.reportLines_({ rcept_no: 'x', report_nm: '실적' }, report).join('\n');
  assert.match(lines, /영업이익 948억 \(전년 동기 대비 -53\.4%, 직전 분기 대비 -61\.4%\)/);
});

test('흑자전환은 증감율 대신 전환 여부로 표시한다', () => {
  const { context } = createGas();
  const report = context.parseEarningsReport_(earningsReportText('억원',
    '1,000 900 11.1 - 800 25.0 -', '100 -50 - 흑자전환 -30 - 흑자전환'));
  assert.equal(context.reportLabel_(report), '영업이익 흑자전환');
  assert.match(context.reportLines_({ rcept_no: 'x', report_nm: '실적' }, report).join('\n'), /영업이익 100억 \(전년 동기 대비 흑자전환, 직전 분기 대비 흑자전환\)/);
});

test('공시 증감율과 금액이 맞지 않으면 열을 잘못 읽은 것으로 보고 수치를 쓰지 않는다', () => {
  const { context } = createGas();
  assert.equal(context.parseEarningsReport_(earningsReportText('억원',
    '1,000 900 11.1 - 800 25.0 -', '100 90 11.1 - 80 99.0 -')), null);
});

test('단위나 항목을 읽지 못하면 수치 없이 공시 링크만 남긴다', () => {
  const { context } = createGas();
  assert.equal(context.parseEarningsReport_('양식이 다른 공시 본문'), null);
  const lines = context.reportLines_({ rcept_no: 'abc', report_nm: '연결재무제표기준영업(잠정)실적' }, null).join('\n');
  assert.match(lines, /rcpNo=abc/);
  assert.doesNotMatch(lines, /전년 동기 대비/);
});

test('정정 공시가 있으면 최신 값을 IR 일정 결과로 쓴다', () => {
  const gas = createGas({ props: { OPENDART_API_KEY: 'test' }, dart: dartHandler({
    L: [
      { rcept_dt: '20261028', report_nm: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'fix' },
      { rcept_dt: '20261028', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: 'ir' },
    ],
  }, {
    fix: earningsReportText('억원', '238,241 238,265 -0.01 - 218,737 8.9 -', '7,819 15,791 -50.5 - 6,889 13.5 -'),
    ir: '일시 2026-10-28 16:00 장소 - 3. 개최목적 2026년 3분기 경영실적 발표 4. 개최방법 컨퍼런스콜 5. 후원기관',
  }) });
  const { context } = gas;
  const today = context.dateOnly_('2026-10-29');
  const targets = context.krTargets_([['066570', 'LG전자', 'L']], today, context.addDays_(today, 90), context.addDays_(today, -7));
  const event = targets.KR_066570_2026Q3;
  assert.equal(event.title, 'LG전자 실적발표 (IR) · 영업이익 전년 대비 증가');
  assert.match(event.description, /매출 23조 8,241억/);
  assert.equal(Object.keys(targets).filter(k => k.includes('_RESULT_')).length, 0);
});

test('IR 없이 낸 잠정실적도 공시일 결과 일정으로 남긴다', () => {
  const gas = createGas({ props: { OPENDART_API_KEY: 'test' }, dart: dartHandler({
    I: [{ rcept_dt: '20261027', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: 'r' }],
  }, { r: earningsReportText('백만원', '6,367,124 5,527,241 15.2 - 5,369,431 18.6 -', '94,847 245,754 -61.4 - 203,749 -53.4 -') }) });
  const { context } = gas;
  const today = context.dateOnly_('2026-10-29');
  const targets = context.krTargets_([['011070', 'LG이노텍', 'I']], today, context.addDays_(today, 90), context.addDays_(today, -7));
  const event = targets.KR_011070_RESULT_20261027;
  assert.equal(event.title, 'LG이노텍 잠정실적 · 영업이익 전년 대비 감소');
  assert.equal(event.allDay, true);
  assert.equal(event.hasResult, true);
});

test('날짜가 지난 예상 일정은 실제 일정이 생겨야 지우고, 없으면 남겨 둔다', () => {
  const past = new Date(Date.now() - 2 * DAY_MS);
  const run = targets => {
    const gas = createGas({ props: { OPENDART_API_KEY: 'test' } });
    gas.setWatchlist(['AAPL'], [['005930', '삼성전자', 'E']]);
    gas.props.LAST_SYNC_AT = new Date().toISOString();
    gas.calendar.add('삼성전자 실적 (예상)', past, null, true, 'KR_005930_EST_X');
    gas.replace('krTargets_', () => targets);
    gas.context.syncEarnings();
    return gas;
  };
  assert.equal(run({}).calendar.find('삼성전자 실적 (예상)').title, '삼성전자 실적 (예상)');
  const replaced = run({ KR_005930_RESULT_X: { key: 'KR_005930_RESULT_X', title: '삼성전자 잠정실적 · 공시됨', allDay: true, start: past, description: '', hasResult: true } });
  assert.equal(replaced.calendar.find('삼성전자 실적 (예상)'), undefined);
  assert.equal(replaced.logValue('예상→확정 전환'), 1);
});

/* ───────── 매일 실행 (캘린더 반영과 운영기록) ───────── */

test('일정을 만들고 운영기록 머리글과 한 줄을 남긴다', () => {
  const gas = createGas({ finnhub: finnhubHandler({ AAPL: [usRow()] }) });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  gas.context.syncEarnings();
  assert.equal(gas.calendar.events.length, 1);
  assert.equal(gas.calendar.events[0].getTag('earningsKey'), 'AAPL_2026Q4');
  assert.equal(gas.sheets['운영기록'].rows[0][0], '실행 시각');
  assert.equal(gas.logValue('결과'), '성공');
  assert.equal(gas.logValue('새로 만듦'), 1);
  assert.equal(gas.logValue('경고'), '');
});

test('태그가 없는 개인 일정은 건드리지 않는다', () => {
  const gas = createGas({ finnhub: finnhubHandler({}) });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  const personal = gas.calendar.add('개인 약속', new Date(Date.now() + 3 * DAY_MS), null, false, null);
  gas.context.syncEarnings();
  assert.ok(gas.calendar.events.includes(personal));
  assert.equal(gas.logValue('삭제'), 0);
});

test('발표일이 바뀌면 기존 일정을 옮기고 변경 내역에 남긴다', () => {
  const gas = createGas({ finnhub: finnhubHandler({ AAPL: [usRow({ date: seoulDate(6) })] }) });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  gas.calendar.add('AAPL 실적 (장후)', new Date(Date.now() + 4 * DAY_MS), null, false, 'AAPL_2026Q4');
  gas.context.syncEarnings();
  assert.equal(gas.calendar.events.length, 1);
  assert.equal(gas.logValue('시간 변경'), 1);
  assert.match(gas.logValue('변경 내역'), /^변경: AAPL 실적 \(장후\)/);
});

test('관심종목에서 빠진 미국 종목의 앞으로 남은 일정은 지운다', () => {
  const gas = createGas({ finnhub: finnhubHandler({}) });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  gas.calendar.add('OLD 실적 (장후)', new Date(Date.now() + 10 * DAY_MS), null, false, 'OLD_2026Q4');
  gas.context.syncEarnings();
  assert.equal(gas.calendar.events.length, 0);
  assert.match(gas.logValue('변경 내역'), /삭제: OLD/);
});

test('국내 확정 IR이 생기면 같은 종목의 예상 일정을 지우고 전환으로 센다', () => {
  const gas = createGas({ props: { OPENDART_API_KEY: 'test' } });
  gas.setWatchlist(['AAPL'], [['005930', '삼성전자', 'E']]);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  const start = new Date(Date.now() + 20 * DAY_MS);
  gas.calendar.add('삼성전자 실적 (예상)', start, null, true, 'KR_005930_EST_X');
  gas.replace('krTargets_', () => ({
    KR_005930_2026Q4: { key: 'KR_005930_2026Q4', title: '삼성전자 실적발표 (IR)', allDay: false,
      start, end: new Date(start.getTime() + 3600e3), description: '' },
  }));
  gas.context.syncEarnings();
  assert.equal(gas.logValue('예상→확정 전환'), 1);
  assert.deepEqual(gas.calendar.events.map(e => e.title), ['삼성전자 실적발표 (IR)']);
});

test('발표가 끝난 지난 일정에 실제 실적을 붙이고 결과 반영으로 센다', () => {
  const yesterday = seoulDate(-1);
  const gas = createGas({ finnhub: finnhubHandler({ AAPL: [usRow({ date: yesterday, epsActual: 2.15 })] }) });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  const start = gas.context.toEvent_(usRow({ date: yesterday }), 'AAPL').start;
  const event = gas.calendar.add('AAPL 실적 (장후)', start, null, false, 'AAPL_2026Q4');
  gas.context.syncEarnings();
  assert.equal(event.title, 'AAPL 실적 (장후) · EPS 상회');
  assert.equal(gas.logValue('실적 결과 반영'), 1);
  gas.context.syncEarnings(); // 이미 반영된 결과는 다시 세지 않는다
  assert.equal(gas.logValue('실적 결과 반영'), 0);
});

test('시트가 비면 아무것도 지우지 않고 실패로 기록하며 경고 메일을 보낸다', () => {
  const gas = createGas({ props: { ALERT_EMAILS: 'a@example.com, b@example.com' } });
  const event = gas.calendar.add('AAPL 실적 (장후)', new Date(Date.now() + 5 * DAY_MS), null, false, 'AAPL_2026Q4');
  assert.throws(() => gas.context.syncEarnings(), /비어 있습니다/);
  assert.ok(gas.calendar.events.includes(event));
  assert.equal(gas.logValue('결과'), '실패');
  assert.equal(gas.mails.length, 1);
  assert.equal(gas.mails[0].to, 'a@example.com,b@example.com');
});

/* ───────── 경고 메일 ───────── */

test('PC 동기화가 7일 넘게 없으면 경고하고, 3일 안에는 다시 보내지 않는다', () => {
  const gas = createGas({ props: { ALERT_EMAILS: 'a@example.com' } });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date(Date.now() - 8 * DAY_MS).toISOString();
  gas.context.syncEarnings();
  assert.equal(gas.mails.length, 1);
  assert.match(gas.mails[0].subject, /8일째/);
  assert.match(gas.logValue('경고'), /메일 발송/);
  gas.context.syncEarnings();
  assert.equal(gas.mails.length, 1);
  assert.match(gas.logValue('경고'), /메일 생략/);
});

test('동기화가 최근이면 경고하지 않는다', () => {
  const gas = createGas({ props: { ALERT_EMAILS: 'a@example.com' } });
  gas.setWatchlist(['AAPL']);
  gas.props.LAST_SYNC_AT = new Date(Date.now() - 2 * DAY_MS).toISOString();
  gas.context.syncEarnings();
  assert.equal(gas.mails.length, 0);
});

test('미국 종목 절반 이상이 조회에 실패하면 경고한다', () => {
  const gas = createGas({ props: { ALERT_EMAILS: 'a@example.com' }, finnhub: finnhubHandler({ AAPL: 401, MSFT: 401, NVDA: [] }) });
  gas.setWatchlist(['AAPL', 'MSFT', 'NVDA']);
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  gas.context.syncEarnings();
  assert.equal(gas.logValue('미국 조회 실패'), 'AAPL, MSFT');
  assert.equal(gas.mails.length, 1);
  assert.match(gas.mails[0].subject, /3개 중 2개 조회 실패/);
});

test('테스트 메일은 모든 수신자에게 보내고 경고 중복 방지 기록은 바꾸지 않는다', () => {
  const gas = createGas({ props: { ALERT_EMAILS: 'a@example.com, b@example.com' } });
  gas.props.LAST_SYNC_AT = new Date().toISOString();
  gas.context.sendTestAlert();
  assert.equal(gas.mails.length, 1);
  assert.equal(gas.mails[0].to, 'a@example.com,b@example.com');
  assert.match(gas.mails[0].subject, /테스트 메일/);
  assert.equal(Object.keys(gas.props).filter(k => k.startsWith('ALERT_SENT_')).length, 0);
});

test('수신자가 없으면 테스트 메일 대신 오류를 알린다', () => {
  const gas = createGas();
  assert.throws(() => gas.context.sendTestAlert(), /ALERT_EMAILS/);
});

test('예전 웹앱이 남긴 시트 머리글 시각으로도 마지막 동기화를 읽는다', () => {
  const gas = createGas();
  gas.sheet('관심종목').rows = [['종목', '마지막 동기화: 2026. 10. 29. 오후 6:26:41']];
  assert.equal(formatZoned(gas.context.lastSyncAt_(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'), '2026-10-29 18:26');
});

/* ───────── 웹앱 doPost ───────── */

test('동기화 암호가 틀리면 시트를 바꾸지 않는다', () => {
  const gas = createGas();
  const out = gas.context.doPost({ postData: { contents: JSON.stringify({ token: 'wrong', symbols: ['AAPL'] }) } });
  assert.deepEqual(JSON.parse(out.text), { ok: false, error: 'invalid token' });
  assert.equal(gas.sheets['관심종목'], undefined);
});

test('관심종목을 저장하고 국내 코드는 텍스트 서식으로 쓴다', () => {
  const gas = createGas();
  const body = { token: 'secret-token', symbols: ['AAPL', ' MSFT '], krStocks: [{ code: '005930', name: '삼성전자', corpCode: '00126380' }] };
  const out = JSON.parse(gas.context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  assert.deepEqual(out, { ok: true, count: 2, krCount: 1 });
  assert.deepEqual(gas.sheets['관심종목'].rows.slice(1), [['AAPL'], ['MSFT']]);
  assert.equal(gas.sheets['국내종목'].rows[1][0], '005930');
  assert.ok(gas.sheets['국내종목'].numberFormats.some(f => f.format === '@'));
  assert.ok(gas.props.LAST_SYNC_AT);
});

test('국내 목록을 보내지 않는 예전 PC 스크립트면 국내 시트를 그대로 둔다', () => {
  const gas = createGas();
  gas.sheet('국내종목').rows = [['종목코드'], ['005930', '삼성전자', '00126380']];
  gas.context.doPost({ postData: { contents: JSON.stringify({ token: 'secret-token', symbols: ['AAPL'] }) } });
  assert.equal(gas.sheets['국내종목'].rows.length, 2);
});
