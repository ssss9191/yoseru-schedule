'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localUid = DemoStore.identity();
const sampleId = DemoStore.sampleId;
const weekdays = [...'日月火水木金土'];
const marks = { yes: ['○', '参加できる'], maybe: ['△', '時間しだい'], no: ['×', '参加できない'] };
const dayMs = 86400000;
const view = $('#view');
const dialog = $('#dialog');
const drafts = new Map();
let eventId;
let record;
let cloud;
let store = DemoStore;
let baseUid = localUid;
let uid = baseUid;
let stopWatching = () => {};
let screen;
let org;
let simulated = [];
let busy = false;
let toastTimer;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const pad = value => String(value).padStart(2, '0');
const event = () => record.event;
const owner = () => event().ownerUid === uid;
const dateUTC = iso => new Date(iso + 'T00:00:00Z');
const isoDate = date => date.toISOString().slice(0, 10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateText = iso => {
  const date = dateUTC(iso);
  return (date.getUTCMonth() + 1) + '/' + date.getUTCDate() + '（' + weekdays[date.getUTCDay()] + '）';
};
const minutesText = value => {
  const minute = ((value % Schedule.DAY) + Schedule.DAY) % Schedule.DAY;
  return pad(Math.floor(minute / 60)) + ':' + pad(minute % 60);
};
const rangeText = (start, end) => {
  const label = value => (value < 0 ? '前日 ' : value >= Schedule.DAY ? '翌日 ' : '') + minutesText(value);
  return label(start) + (end === null ? '〜' : '〜' + label(end));
};
const shiftText = value => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value) + '分';
const badge = mark => '<span class="mark ' + mark + '" aria-label="' + marks[mark][1] + '">' + marks[mark][0] + '</span>';
const btn = (label, action, style = '', attrs = '') => '<button type="button" class="button ' + style + '" data-action="' + action + '" ' + attrs + '>' + label + '</button>';
const empty = (title, description) => '<div class="empty"><strong>' + title + '</strong><p>' + description + '</p></div>';

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4300);
}

function shareURL(id = eventId) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (id && url.protocol === 'file:') url.hash = 'event=' + encodeURIComponent(id);
  else if (id) url.searchParams.set('event', id);
  return url.href;
}

function eventFromURL() {
  const params = location.protocol === 'file:' ? location.hash.slice(1) : location.search;
  const id = new URLSearchParams(params).get('event');
  return id && /^(demo|[a-f0-9]{24})$/.test(id) ? id : null;
}

function resetOrganizer() {
  const initial = dateUTC(event().slots[0]?.date || today());
  org = {
    month: new Date(Date.UTC(initial.getUTCFullYear(), initial.getUTCMonth(), 1)),
    dates: new Set(), selected: new Set(), title: event().title, minimum: String(event().minimum),
    time: { sh: '18', sm: '00', eh: '20', em: '00' }, hasEnd: false, addDraft: null
  };
}

function openEvent(id, initialView, replace = false) {
  stopWatching();
  stopWatching = () => {};
  const local = DemoStore.get(id);
  store = local || !cloud ? DemoStore : cloud;
  eventId = id;
  baseUid = store.identity();
  uid = baseUid;
  screen = initialView;
  const state = { eventId, screen };
  if (replace) history.replaceState(state, '', shareURL());
  else history.pushState(state, '', shareURL());

  function firstRender(next) {
    record = next;
    simulated = store === DemoStore && record ? DemoStore.profiles(id) : [];
    if (record) resetOrganizer();
    if (!record || !owner()) screen = 'answer';
    history.replaceState({ eventId, screen }, '', shareURL());
    render();
    if (!replace) $('#view-title')?.focus();
  }

  if (store === DemoStore) {
    firstRender(local);
  } else {
    record = null;
    renderLoading('イベントを読み込み中…');
    let first = true;
    stopWatching = store.watchEvent(id, next => {
      if (first) {
        first = false;
        firstRender(next);
      } else refreshEvent(next);
    }, error => {
      if (first) renderLoading('共有イベントを読み込めませんでした');
      toast(connectionError(error));
    });
  }
}

function openHome(replace = false) {
  stopWatching();
  stopWatching = () => {};
  eventId = null;
  record = null;
  screen = 'home';
  if (replace) history.replaceState({ screen }, '', shareURL());
  else history.pushState({ screen }, '', shareURL());
  render();
  if (cloud) stopWatching = cloud.watchOwned(renderHome, error => toast(connectionError(error)));
  if (!replace) $('#view-title').focus();
}

function setScreen(next, focus = true) {
  screen = next;
  history.replaceState({ eventId, screen }, '', shareURL());
  render();
  if (focus) $('#view-title')?.focus();
}

function template(name) {
  return $('#' + name + '-template').content.cloneNode(true);
}

function renderLoading(message) {
  $('#event-header').hidden = true;
  $('#views').hidden = true;
  $('#go-home').removeAttribute('aria-current');
  view.removeAttribute('aria-labelledby');
  view.innerHTML = '<div class="panel view-heading" role="status">' + esc(message) + '</div>';
}

function connectionError(error) {
  if (error.code === 'permission-denied') return 'この操作は許可されていません。共有設定を確認してください。';
  if (error.code === 'unavailable') return '接続できません。通信を確認して、もう一度お試しください。';
  return error.message;
}

function renderHome() {
  const content = template('home');
  const events = [...(cloud?.listOwned() ?? []), ...DemoStore.listOwned(localUid)];
  const updated = event => event.updatedAt?.toMillis?.() ?? event.updatedAt ?? 0;
  events.sort((a, b) => updated(b.event) - updated(a.event));
  $('#home-count', content).textContent = events.length + '件';
  $('#home-empty', content).hidden = events.length > 0;
  const list = $('#home-events', content);
  list.hidden = !events.length;
  for (const { event, responses } of events) {
    const item = template('home-event');
    $('[data-action=open-event]', item).dataset.eventId = event.id;
    $('[data-event-title]', item).textContent = event.title;
    const status = $('[data-event-state]', item);
    const closed = event.status === 'closed';
    status.classList.toggle('closed', closed || !event.slots.length);
    status.textContent = closed ? '確定済み' : event.slots.length ? '受付中' : '準備中';
    const isShared = event.responseVersion !== undefined;
    const mode = cloud ? (isShared ? '共有 · ' : 'ローカル · ') : '';
    const count = event.responseCount ?? responses.length;
    $('[data-event-summary]', item).textContent = mode + '候補 ' + event.slots.length + '件 · 回答 ' + count + '人';
    if (event.final) {
      const { date, start, end } = event.final;
      const final = $('[data-event-final]', item);
      final.hidden = false;
      final.textContent = '確定 ' + dateText(date) + ' ' + rangeText(start, end);
    }
    list.append(item);
  }
  view.replaceChildren(content);
}

function render() {
  const header = $('#event-header');
  const nav = $('#views');
  const home = screen === 'home';
  const shared = Boolean(cloud && (home || store === cloud));
  $('#mode-label').textContent = shared ? '共有モード' : 'ローカルデモ';
  $('#storage-note').textContent = shared ? '保存済みの回答を、同じイベントのURLで共有します' : 'デモの回答はこのブラウザに保存されます';
  const homeButton = $('#go-home');
  $('#new-event').hidden = home;
  header.hidden = home;
  nav.hidden = home;
  if (home) {
    homeButton.setAttribute('aria-current', 'page');
    view.setAttribute('aria-labelledby', 'view-title');
    document.title = 'イベント一覧 | よせる';
    renderHome();
    return;
  }
  homeButton.removeAttribute('aria-current');
  if (!record) {
    header.innerHTML = '<p class="eyebrow">ローカルデモ</p><h1>イベントが見つかりません</h1><p>このブラウザに保存されているイベントを開くか、回答入りデモをお試しください。</p>';
    nav.replaceChildren();
    const hint = shared ? 'イベントを作った人から、共有モードのリンクを受け取ってください。' :
      'ローカルデモで作ったイベントは、作成したブラウザで開けます。';
    view.innerHTML = '<div class="panel">' + empty('イベントを開けません', hint) + '</div>';
    view.removeAttribute('aria-labelledby');
    return;
  }
  view.setAttribute('aria-labelledby', 'view-title');
  document.title = event().title + ' | よせる';
  const closed = event().status === 'closed';
  const content = template('event');
  $('#event-title', content).textContent = event().title;
  const status = $('#event-state', content);
  status.classList.toggle('closed', closed);
  status.textContent = closed ? '受付終了' : '受付中';
  $('#event-slot-count', content).textContent = event().slots.length + ' 候補';
  $('#submitted-count', content).textContent = record.responses.length + ' 人回答済み';
  $('#event-minimum', content).textContent = '最低 ' + event().minimum + ' 分';

  const options = [[baseUid, event().ownerUid === baseUid ? '主催者（自分）' : '自分']]
    .concat(simulated.map((id, i) => [id, '参加者 ' + (i + 1)]))
    .concat(eventId === sampleId ? [['demo-a', '青木（例）'], ['demo-b', '佐藤（例）'], ['demo-c', '田中（例）']] : []);
  const profiles = $('#profile', content);
  profiles.closest('.profile').hidden = shared;
  profiles.prepend(...options.map(([id, label]) => new Option(label, id)));
  profiles.value = uid;
  if (closed) {
    $('.final-banner', content).hidden = false;
    const final = event().final;
    $('#final-time', content).textContent = dateText(final.date) + ' ' + rangeText(final.start, final.end);
    $('#final-attendance', content).textContent = final.count + '人参加可能 · 回答受付終了';
    $('[data-action=reopen]', content).hidden = !owner();
  }
  header.replaceChildren(content);

  const navigation = template('navigation');
  if (!owner()) $('[data-key=organizer]', navigation).remove();
  $('[data-key="' + screen + '"]', navigation)?.setAttribute('aria-current', 'page');
  nav.replaceChildren(navigation);
  if (screen === 'organizer') renderOrganizer();
  if (screen === 'answer') renderAnswer();
  if (screen === 'results') renderResults();
}

function renderCalendar() {
  const year = org.month.getUTCFullYear();
  const month = org.month.getUTCMonth();
  const start = org.month.getUTCDay();
  const end = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = Array.from({ length: end }, (_, i) => isoDate(new Date(Date.UTC(year, month, i + 1))));
  return '<div class="month-heading">' + btn('‹', 'month', 'icon', 'data-value="-1" aria-label="前の月"') +
    '<strong>' + year + '年 ' + (month + 1) + '月</strong>' + btn('›', 'month', 'icon', 'data-value="1" aria-label="次の月"') +
    '</div><div class="calendar-grid">' + weekdays.map((day, i) =>
      '<button type="button" class="weekday" data-action="weekday" data-value="' + i + '" aria-label="この月の' + day + '曜日を一括選択・解除" aria-pressed="' +
      dates.filter(iso => dateUTC(iso).getUTCDay() === i).every(iso => org.dates.has(iso)) + '">' + day + '</button>').join('') +
    '<span class="blank-day" aria-hidden="true"></span>'.repeat(start) + dates.map((iso, index) => {
      const added = event().slots.some(slot => slot.date === iso);
      return '<button type="button" class="day' + (added ? ' has-slot' : '') + '" data-action="date" data-date="' + iso +
        '" aria-label="' + dateText(iso) + (added ? ' 登録済み候補あり' : '') + '" aria-pressed="' + org.dates.has(iso) + '">' + (index + 1) + '</button>';
    }).join('') + '</div>';
}

function timeField(prefix, title) {
  const content = template('clock-field');
  for (const [part, unit, count, step] of [['h', '時', 24, 1], ['m', '分', 6, 10]]) {
    const key = prefix + part;
    const input = $('[data-clock="' + part + '"]', content);
    input.id = key;
    input.dataset.clock = key;
    input.value = org.time[key];
    input.setAttribute('aria-label', title + 'の' + unit);
    const options = $('[data-clock-options="' + part + '"]', content);
    options.setAttribute('aria-label', title + 'の' + unit + 'の選択肢');
    options.innerHTML = Array.from({ length: count }, (_, index) => {
      const value = pad(index * step);
      return '<button type="button" data-action="clock-value" data-value="' + value + '" data-key="' + key +
        '" aria-label="' + value + unit + '">' + value + '</button>';
    }).join('');
  }
  const list = $('.combo-list', content);
  list.id = 'choices-' + prefix;
  const toggle = $('.combo-toggle', content);
  toggle.setAttribute('aria-label', title + '時刻を選ぶ');
  toggle.setAttribute('aria-controls', list.id);
  return content;
}

function slotList(editable) {
  const slots = event().slots;
  if (!slots.length) return empty('候補はまだありません', '日付と時間を指定して、最初の候補を登録してください。');
  return '<div class="slot-list">' + slots.map(slot => '<label class="slot-row">' +
    (editable ? '<input type="checkbox" data-slot="' + slot.id + '"' + (org.selected.has(slot.id) ? ' checked' : '') + '>' : '') +
    '<strong>' + dateText(slot.date) + '</strong><span class="numbers">' + rangeText(slot.start, slot.end) + '</span>' +
    (slot.end === null ? '<small class="pill">終了未定</small>' : '') + '</label>').join('') + '</div>';
}

function renderOrganizer() {
  const content = template('organizer');
  const closed = event().status === 'closed';
  const slotCount = event().slots.length;
  const editing = org.selected.size > 0;
  $('#organizer-locked', content).hidden = !closed;
  $('#organizer-edit-note', content).hidden = closed || !event().locked;
  $('.event-settings', content).hidden = closed || event().locked;
  $('.organizer-grid', content).hidden = closed;

  if (!closed) {
    $('#event-name', content).value = org.title;
    $('#minimum', content).value = org.minimum;
    $('#calendar', content).innerHTML = renderCalendar();
    $('#date-count', content).textContent = org.dates.size;
    $('[data-action=clear-dates]', content).hidden = !org.dates.size;
    $('.selected-dates', content).innerHTML = [...org.dates].sort()
      .map(date => '<span class="pill">' + dateText(date) + '</span>').join('');
    $('.selected-dates', content).hidden = !org.dates.size;

    for (const field of $$('[data-clock-field]', content)) {
      const prefix = field.dataset.clockField;
      field.replaceWith(timeField(prefix, prefix === 's' ? '開始' : '終了'));
    }
    $('#end-time', content).hidden = !org.hasEnd;
    $('#has-end', content).checked = org.hasEnd;
    $('#edit-date-row', content).hidden = org.selected.size !== 1;
    $('#edit-date', content).value = org.editDate ?? '';
    $('#edit-slot-count', content).textContent = org.selected.size;
    for (const selector of ['#add-time-title', '#add-time-hint', '[data-action=add-slots]']) {
      $(selector, content).hidden = editing;
    }
    for (const selector of ['#edit-time-title', '#edit-time-hint', '[data-action=apply-edit]', '[data-action=cancel-edit]']) {
      $(selector, content).hidden = !editing;
    }
  }

  if (closed) $('#slot-list-step', content).textContent = '✓';
  $('#registered-count', content).textContent = slotCount + '件';
  $('#registered-slots', content).innerHTML = slotList(!closed);
  $('#select-all-slots', content).hidden = closed || !slotCount;
  $('#all-slots', content).checked = slotCount > 0 && org.selected.size === slotCount;
  $('.bulk', content).hidden = closed || !slotCount;
  $('#bulk-count', content).textContent = org.selected.size;
  $('#edit-selection-hint', content).hidden = !editing;
  $('[data-action=delete-slots]', content).disabled = !org.selected.size;
  view.replaceChildren(content);
}

function draft() {
  const key = eventId + '/' + uid;
  const saved = record.responses.find(response => response.uid === uid);
  let current = drafts.get(key);
  if (!current || (!current.dirty && current.saved !== saved)) {
    current = { name: saved?.name ?? '', answers: structuredClone(saved?.answers ?? {}), revision: event().revision, dirty: false, saved };
    drafts.set(key, current);
  }
  if (current.revision !== event().revision) {
    const slots = event().slots;
    current.answers = Object.fromEntries(slots.filter(slot => current.answers[slot.id])
      .map(slot => [slot.id, current.answers[slot.id]]));
    current.revision = event().revision;
    current.stale = slots.some(slot => !current.answers[slot.id]);
  }
  return current;
}

function slider(slot, key, answer) {
  const title = key === 'from' ? '開始' : '終了';
  const yes = answer.mark === 'yes';
  const min = yes && key === 'to' ? 0 : -120;
  const max = yes && key === 'from' ? 0 : 120;
  const value = answer[key] ?? 0;
  return '<label class="slider"><span><strong>' + title + '時刻</strong><output id="shift-' + key + '-' + slot.id + '">' + shiftText(value) +
    '</output></span><input type="range" min="' + min + '" max="' + max + '" step="10" value="' + value + '" data-offset="' + key +
    '" aria-label="' + dateText(slot.date) + ' ' + minutesText(slot.start) + ' ' + title + '時刻の調整" aria-valuetext="' + shiftText(value) + '">' +
    '<span class="ticks"><small>' + shiftText(min) + '</small>' + (!yes ? '<small>0分</small>' : '') + '<small>' + shiftText(max) + '</small></span></label>';
}

function answerControls(slot, answer) {
  const content = template('time-compare');
  const date = dateText(slot.date);
  $('[data-original]', content).textContent = date + ' ' + rangeText(slot.start, slot.end);
  $('[data-available]', content).textContent = date + ' ' + rangeText(...Schedule.availability(slot, answer));
  $('.sliders', content).innerHTML = slider(slot, 'from', answer) + slider(slot, 'to', answer);
  const error = Schedule.answerError(slot, answer);
  const message = $('[data-slot-error]', content);
  message.hidden = !error;
  message.textContent = error;
  return content;
}

function updateBufferButton(card, slot, answer) {
  const button = $('[data-action=zero-buffer]', card);
  if (button) {
    const zeroSelected = !Schedule.needsBuffer(slot, answer) && !answer.from && !answer.to;
    button.setAttribute('aria-pressed', String(zeroSelected));
  }
}

function answerCard(slot, answer) {
  const content = template('answer-card');
  const date = dateText(slot.date);
  $('[data-answer]', content).dataset.answer = slot.id;
  $('.slot-date', content).textContent = date;
  $('[data-slot-time]', content).textContent = rangeText(slot.start, slot.end);
  $('[data-no-end]', content).hidden = slot.end !== null;
  $('.choices', content).setAttribute('aria-label', date + ' ' + minutesText(slot.start) + ' の回答');
  for (const choice of $$('[data-mark]', content)) {
    choice.setAttribute('aria-pressed', String(answer?.mark === choice.dataset.mark));
  }

  const yesBuffer = $('[data-yes-buffer]', content);
  const maybeBuffer = $('[data-maybe-buffer]', content);
  if (slot.end !== null && answer?.mark === 'yes') {
    yesBuffer.hidden = false;
    updateBufferButton(yesBuffer, slot, answer);
    yesBuffer.append(answerControls(slot, answer));
  } else yesBuffer.remove();
  if (slot.end !== null && answer?.mark === 'maybe') {
    maybeBuffer.hidden = false;
    maybeBuffer.append(answerControls(slot, answer));
  } else maybeBuffer.remove();
  return content;
}

function renderAnswer() {
  const content = template('answer');
  const closed = event().status === 'closed';
  if (closed || !event().slots.length) {
    $(closed ? '#answer-closed' : '#answer-empty', content).hidden = false;
    view.replaceChildren(content);
    return;
  }
  const current = draft();
  $('#answer-form', content).hidden = false;
  $('#answer-name', content).value = current.name;
  const needsNewAnswers = current.saved && event().slots.some(slot => !current.saved.answers[slot.id]);
  $('#answer-stale', content).hidden = !current.stale && !needsNewAnswers;
  $('.answer-list', content).append(...event().slots.map(slot => answerCard(slot, current.answers[slot.id])));
  const save = $('#save-answer', content);
  if (record.responses.some(response => response.uid === uid)) save.textContent = save.dataset.updateLabel;
  view.replaceChildren(content);
  updateAnswerStatus();
}

function updateAnswerStatus() {
  const current = draft();
  const slots = event().slots;
  const pending = slots.filter(slot => Schedule.needsBuffer(slot, current.answers[slot.id])).length;
  const filled = slots.filter(slot => current.answers[slot.id]?.mark).length - pending;
  const invalid = slots.some(slot => current.answers[slot.id]?.mark && Schedule.answerError(slot, current.answers[slot.id]));
  $('#answer-count').textContent = filled + ' / ' + slots.length + ' 件に回答';
  $('#answer-note').textContent = invalid ? '赤字の時刻を直すと保存できます。' :
    pending ? '○の候補は、前後の余裕を指定すると保存できます。' :
    current.dirty ? '入力途中の回答は、保存するまで一覧に表示されません。' :
    record.responses.some(response => response.uid === uid) ? '保存済みの回答を表示しています。' : '入力途中の回答は、保存するまで一覧に表示されません。';
  $('#save-answer').disabled = invalid;
}

function resultTable() {
  const people = record.responses;
  if (!people.length) return empty('まだ回答がありません', '回答が保存されると、全員の一覧に表示されます。');
  return '<div class="table-scroll" tabindex="0" aria-label="回答表。列が多い場合は横にスクロールできます"><table><thead><tr><th scope="col">元の候補日時</th>' +
    people.map(person => '<th scope="col">' + esc(person.name) + '</th>').join('') + '<th scope="col">○ / △ / ×</th></tr></thead><tbody>' +
    event().slots.map(slot => {
      const counts = { yes: 0, maybe: 0, no: 0 };
      const cells = people.map(person => {
        const answer = person.answers[slot.id];
        if (!answer) return '<td><small>未回答</small></td>';
        counts[answer.mark]++;
        const interval = Schedule.availability(slot, answer);
        return '<td>' + badge(answer.mark) + (interval ? '<small class="numbers">' + rangeText(...interval) + '</small>' : '') + '</td>';
      }).join('');
      return '<tr><th scope="row">' + dateText(slot.date) + '<small class="numbers">' + rangeText(slot.start, slot.end) +
        (slot.end === null ? ' 終了未定' : '') + '</small></th>' + cells +
        '<td class="numbers totals">' + counts.yes + ' / ' + counts.maybe + ' / ' + counts.no + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function renderResults() {
  const content = template('results');
  const proposals = Schedule.proposals(event(), record.responses);
  const responseCount = record.responses.length;
  $('#results-minimum', content).textContent = event().minimum;
  $('#no-proposals', content).hidden = proposals.length > 0;
  $('#no-proposals-unmet', content).hidden = !responseCount;
  $('#no-proposals-pending', content).hidden = Boolean(responseCount);
  $('.proposal-list', content).hidden = !proposals.length;

  const cards = proposals.map((item, index) => {
    const card = template('proposal');
    const originalYes = record.responses.filter(person => person.answers[item.slot.id]?.mark === 'yes').length;
    $('.proposal', card).classList.toggle('best', index === 0);
    $('.rank', card).textContent = index + 1;
    $('[data-source-time]', card).textContent = dateText(item.slot.date) + ' ' + rangeText(item.slot.start, item.slot.end);
    $('[data-original-yes]', card).textContent = originalYes;
    $('[data-proposed-date]', card).textContent = dateText(item.slot.date);
    $('[data-proposed-time]', card).textContent = rangeText(item.start, item.end);
    $('[data-duration]', card).textContent = item.end - item.start;
    $('[data-people]', card).textContent = item.people.map(person => person.name).join('、');
    $('[data-attending]', card).textContent = item.people.length;
    $('[data-total]', card).textContent = responseCount;
    const finalize = $('[data-action=finalize]', card);
    finalize.dataset.index = index;
    finalize.hidden = !owner() || event().status !== 'open';
    return card;
  });
  $('.proposal-list', content).append(...cards);
  $('#results-response-count', content).textContent = responseCount + '人回答済み';
  $('#results-answers', content).innerHTML = resultTable();
  view.replaceChildren(content);
}

function errorAt(selector, message) {
  const el = $(selector);
  if (!el) return toast(message);
  el.hidden = false;
  el.textContent = message;
}

function ask(title, content, action, button) {
  dialog.innerHTML = '<h2 id="dialog-title">' + title + '</h2>' + content + '<div class="actions">' +
    btn('閉じる', 'close-dialog', 'secondary') + (action ? btn(button, action, 'primary') : '') + '</div>';
  dialog.showModal();
}

function changeMonth(by) {
  org.month = new Date(Date.UTC(org.month.getUTCFullYear(), org.month.getUTCMonth() + by, 1));
}

function toggleWeekday(weekday) {
  const first = org.month.valueOf();
  const end = Date.UTC(org.month.getUTCFullYear(), org.month.getUTCMonth() + 1, 1);
  const same = [];
  for (let day = first; day < end; day += dayMs) {
    const date = new Date(day);
    if (date.getUTCDay() === weekday) same.push(isoDate(date));
  }
  const clear = same.every(date => org.dates.has(date));
  same.forEach(date => clear ? org.dates.delete(date) : org.dates.add(date));
}

function closeClocks() {
  $$('.combo-list').forEach(list => { list.hidden = true; });
  $$('.combo-toggle').forEach(toggle => toggle.setAttribute('aria-expanded', 'false'));
}

function updateClockChoices(combo) {
  for (const group of $$('.clock-options', combo)) {
    const options = $$('button', group);
    const value = org.time[options[0].dataset.key];
    const selected = value && options.find(option => option.dataset.value === pad(value));
    for (const option of options) {
      option.setAttribute('aria-pressed', String(option === selected));
      option.tabIndex = option === (selected || options[0]) ? 0 : -1;
    }
  }
}

function focusClockChoice(combo, part) {
  $('[data-clock-options="' + part + '"] button[tabindex="0"]', combo).focus({ preventScroll: true });
}

function openClock(combo, part = 'h') {
  closeClocks();
  updateClockChoices(combo);
  $('.combo-list', combo).hidden = false;
  $('.combo-toggle', combo).setAttribute('aria-expanded', 'true');
  focusClockChoice(combo, part);
}

function setClock(button) {
  const { key, value } = button.dataset;
  org.time[key] = value;
  const input = $('#' + key);
  input.value = value;
  if (key.endsWith('h')) {
    const combo = button.closest('.combo');
    updateClockChoices(combo);
    focusClockChoice(combo, 'm');
  } else {
    closeClocks();
    input.focus({ preventScroll: true });
  }
}

function chosenTimes() {
  const { sh, sm, eh, em } = org.time;
  const start = Schedule.readClock(sh, sm);
  const end = org.hasEnd ? Schedule.readClock(eh, em) : null;
  if (start === null || (org.hasEnd && end === null)) throw new Error('時は0〜23、分は0〜59の半角数字で入力してください。');
  if (end !== null && start >= end) throw new Error('終了時刻は開始時刻より後にしてください。');
  return { start, end };
}

function setSelectedSlots(selected) {
  if (selected.size === 1) {
    const [id] = selected;
    if (org.selected.size !== 1 || !org.selected.has(id)) org.editDate = event().slots.find(slot => slot.id === id).date;
  }
  org.selected = selected;
  if (selected.size && !org.addDraft) {
    const first = event().slots.find(slot => selected.has(slot.id));
    org.addDraft = { time: org.time, hasEnd: org.hasEnd };
    const [sh, sm] = minutesText(first.start).split(':');
    const [eh, em] = minutesText(first.end ?? first.start + 60).split(':');
    org.time = { sh, sm, eh, em };
    org.hasEnd = first.end !== null;
  }
  if (!selected.size && org.addDraft) {
    org.time = org.addDraft.time;
    org.hasEnd = org.addDraft.hasEnd;
    org.addDraft = null;
  }
}

async function saveSlots(editing) {
  if (editing ? !org.selected.size : !org.dates.size) throw new Error(editing ? '編集する候補を選んでください。' : 'カレンダーで日付を選んでください。');
  const time = chosenTimes();
  const old = event().slots;
  let editDate;
  if (editing && org.selected.size === 1) {
    editDate = org.editDate;
    const parsed = dateUTC(editDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editDate) || Number.isNaN(parsed.getTime()) || isoDate(parsed) !== editDate) {
      throw new Error('変更後の日付を指定してください。');
    }
  }
  const slots = editing ? old.map(slot => org.selected.has(slot.id) ? { ...slot, ...time, date: editDate ?? slot.date } : slot) :
    old.concat([...org.dates].map(date => ({ id: store.id(), date, ...time })));
  const keys = slots.map(slot => [slot.date, slot.start, slot.end].join('/'));
  if (new Set(keys).size < keys.length) throw new Error('同じ日付・時刻の候補がすでにあります。時間を変えるか、日付の選択を見直してください。');
  await store.update(eventId, uid, event().revision, { slots: slots.sort(Schedule.slotOrder) });
  if (editing) setSelectedSlots(new Set());
  render();
  toast(editing ? '選択した候補を更新しました。' : org.dates.size + '件の候補を追加しました。');
}

function selectMark(button) {
  const card = button.closest('[data-answer]');
  const slot = event().slots.find(item => item.id === card.dataset.answer);
  const current = draft();
  const mark = button.dataset.mark;
  if (current.answers[slot.id]?.mark === mark) return;
  current.answers[slot.id] = { mark };
  current.dirty = true;
  card.replaceWith(answerCard(slot, current.answers[slot.id]));
  $('[data-answer="' + slot.id + '"] [data-mark="' + mark + '"]').focus();
  $('#answer-error').hidden = true;
  updateAnswerStatus();
}

function showShare() {
  const message = store === cloud
    ? 'このURLを知っている人が、回答を登録し、保存済みの名前と回答を確認できます。'
    : 'ローカルデモのイベントと回答は、作成したブラウザで確認できます。';
  ask('イベントリンク', '<p>' + message + '</p>' +
    '<label>イベントのURL<input id="share-url" readonly value="' + esc(shareURL()) + '"></label>', 'copy', 'リンクをコピー');
}

let pendingFinal;
let pendingReopen;
const actions = {
  home: () => { if (screen !== 'home') openHome(); },
  'new-event': async () => {
    const destination = cloud || DemoStore;
    openEvent(await destination.create(destination.identity()), 'organizer');
  },
  'open-event': button => openEvent(button.dataset.eventId, 'organizer'),
  view: button => setScreen(button.dataset.key),
  share: showShare,
  'close-dialog': () => dialog.close(),
  copy: async () => {
    const input = $('#share-url');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('リンクをコピーしました。');
    } catch {
      input.focus();
      input.select();
      toast('選択したURLをコピーできます。');
    }
  },
  month: button => { changeMonth(+button.dataset.value); renderOrganizer(); $('[data-action=month][data-value="' + button.dataset.value + '"]').focus(); },
  date: button => {
    const { date } = button.dataset;
    org.dates.has(date) ? org.dates.delete(date) : org.dates.add(date);
    renderOrganizer();
    $('[data-date="' + date + '"]').focus();
  },
  weekday: button => { toggleWeekday(+button.dataset.value); renderOrganizer(); $('[data-action=weekday][data-value="' + button.dataset.value + '"]').focus(); },
  'clear-dates': () => { org.dates.clear(); renderOrganizer(); $('.weekday').focus(); },
  clock: button => {
    const combo = button.closest('.combo');
    if (button.getAttribute('aria-expanded') === 'true') closeClocks();
    else openClock(combo);
  },
  'clock-value': setClock,
  settings: async () => {
    const title = org.title.trim();
    const minimum = +org.minimum;
    if (!title) { $('#event-name').focus(); throw new Error('イベント名を入力してください。'); }
    if (!/^\d+$/.test(org.minimum) || minimum < 1 || minimum > Schedule.DAY) {
      $('#minimum').focus();
      throw new Error('最低開催時間は1〜1440分で入力してください。');
    }
    await store.update(eventId, uid, event().revision, { title, minimum });
    toast('イベント設定を保存しました。');
  },
  'add-slots': () => saveSlots(false),
  'apply-edit': () => saveSlots(true),
  'cancel-edit': () => {
    setSelectedSlots(new Set());
    renderOrganizer();
    $('[data-action=add-slots]').focus();
  },
  'delete-slots': () => ask('候補を削除しますか？', '<p>選んだ ' + org.selected.size + ' 件の候補を削除します。</p>', 'confirm-delete', '削除する'),
  'confirm-delete': async () => {
    await store.update(eventId, uid, event().revision, { slots: event().slots.filter(slot => !org.selected.has(slot.id)) });
    setSelectedSlots(new Set());
    dialog.close();
    render();
    toast('選択した候補を削除しました。');
  },
  mark: selectMark,
  'zero-buffer': button => {
    const card = button.closest('[data-answer]');
    const slot = event().slots.find(item => item.id === card.dataset.answer);
    const current = draft();
    const answer = current.answers[slot.id];
    answer.from = 0;
    answer.to = 0;
    current.dirty = true;
    card.replaceWith(answerCard(slot, answer));
    $('[data-answer="' + slot.id + '"] [data-action=zero-buffer]').focus();
    $('#answer-error').hidden = true;
    updateAnswerStatus();
  },
  'save-answer': async () => {
    const current = draft();
    if (!current.name.trim()) { $('#answer-name').focus(); throw new Error('名前を入力してください。'); }
    const missing = event().slots.find(slot => !current.answers[slot.id]?.mark);
    if (missing) {
      $('[data-answer="' + missing.id + '"] [data-mark=yes]').focus();
      throw new Error(dateText(missing.date) + ' ' + minutesText(missing.start) + ' の回答を選んでください。');
    }
    const missingBuffer = event().slots.find(slot => Schedule.needsBuffer(slot, current.answers[slot.id]));
    if (missingBuffer) {
      $('[data-answer="' + missingBuffer.id + '"] [data-action=zero-buffer]').focus();
      throw new Error(dateText(missingBuffer.date) + ' ' + minutesText(missingBuffer.start) + ' の前後の余裕を指定してください。');
    }
    await store.submit(eventId, uid, current.revision, current);
    current.dirty = false;
    current.stale = false;
    setScreen('results');
    toast('回答を保存しました。');
  },
  finalize: button => {
    pendingFinal = Schedule.proposals(event(), record.responses)[+button.dataset.index];
    if (!pendingFinal) throw new Error('最新の提案を確認してください。');
    ask('この日程で確定しますか？', '<p><strong>' + dateText(pendingFinal.slot.date) + ' ' + rangeText(pendingFinal.start, pendingFinal.end) +
      '</strong></p><p>確定すると回答の受付を終了し、全員の画面に確定日時を表示します。</p>', 'confirm-final', '確定して受付終了');
  },
  'confirm-final': async () => {
    await store.finalize(eventId, uid, pendingFinal);
    dialog.close();
    toast('日程を確定しました。');
  },
  reopen: () => {
    pendingReopen = event().final;
    ask('日程の確定を取り消しますか？',
      '<p><strong>' + dateText(pendingReopen.date) + ' ' + rangeText(pendingReopen.start, pendingReopen.end) +
      '</strong></p><p>回答受付を再開します。保存済みの回答から引き続き調整できます。</p>',
      'confirm-reopen', '取り消して受付再開');
  },
  'confirm-reopen': async () => {
    await store.reopen(eventId, uid, pendingReopen);
    dialog.close();
    $('#view-title')?.focus({ preventScroll: true });
    toast('日程の確定を取り消し、回答受付を再開しました。');
  }
};

document.addEventListener('click', async evt => {
  if (!evt.target.closest('.combo')) closeClocks();
  const button = evt.target.closest('button[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  busy = true;
  try {
    await actions[action](button);
  } catch (error) {
    const message = connectionError(error);
    if (action === 'save-answer') errorAt('#answer-error', message);
    else if (['apply-edit', 'add-slots'].includes(action)) errorAt('#org-error', message);
    else toast(message);
  } finally {
    busy = false;
  }
});

document.addEventListener('keydown', evt => {
  const combo = evt.target.closest('.combo');
  if (!combo) return;
  if (evt.key === 'Escape' && !$('.combo-list', combo).hidden) {
    evt.preventDefault();
    closeClocks();
    $('.combo-toggle', combo).focus({ preventScroll: true });
  }
  if (evt.key === 'ArrowDown' && evt.target.matches('[data-clock]')) {
    evt.preventDefault();
    openClock(combo, evt.target.dataset.clock.slice(-1));
  }
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 }[evt.key];
  if (evt.target.matches('[data-action=clock-value]') && move) {
    evt.preventDefault();
    const options = $$('button', evt.target.parentElement);
    const next = options[options.indexOf(evt.target) + move];
    if (next) {
      evt.target.tabIndex = -1;
      next.tabIndex = 0;
      next.focus({ preventScroll: true });
    }
  }
});

view.addEventListener('focusout', evt => {
  const combo = evt.target.closest('.combo');
  if (combo && !combo.contains(evt.relatedTarget)) closeClocks();
});

view.addEventListener('input', evt => {
  const field = evt.target;
  if (field.dataset.clock) {
    org.time[field.dataset.clock] = field.value;
    const combo = field.closest('.combo');
    if (!$('.combo-list', combo).hidden) updateClockChoices(combo);
  }
  if (field.id === 'event-name') org.title = field.value;
  if (field.id === 'minimum') org.minimum = field.value;
  if (field.id === 'edit-date') org.editDate = field.value;
  if (field.id === 'answer-name') {
    const current = draft();
    current.name = field.value;
    current.dirty = true;
    $('#answer-error').hidden = true;
    updateAnswerStatus();
  }
  if (field.dataset.offset) {
    const card = field.closest('[data-answer]');
    const slot = event().slots.find(item => item.id === card.dataset.answer);
    const current = draft();
    const answer = current.answers[slot.id];
    const value = +field.value;
    answer[field.dataset.offset] = value;
    current.dirty = true;
    $('#shift-' + field.dataset.offset + '-' + slot.id).textContent = shiftText(value);
    field.setAttribute('aria-valuetext', shiftText(value));
    $('[data-available]', card).textContent = dateText(slot.date) + ' ' + rangeText(...Schedule.availability(slot, answer));
    const error = Schedule.answerError(slot, answer);
    $('[data-slot-error]', card).hidden = !error;
    $('[data-slot-error]', card).textContent = error;
    updateBufferButton(card, slot, answer);
    $('#answer-error').hidden = true;
    updateAnswerStatus();
  }
});

document.addEventListener('change', evt => {
  const field = evt.target;
  if (field.id === 'profile') {
    if (field.value === 'new') {
      uid = DemoStore.addProfile(eventId);
      simulated.push(uid);
    } else uid = field.value;
    setScreen(owner() && screen === 'organizer' ? 'organizer' : 'answer');
    return;
  }
  if (field.id === 'has-end') {
    org.hasEnd = field.checked;
    renderOrganizer();
    $('#has-end').focus();
  }
  if (field.dataset.slot) {
    const selected = new Set(org.selected);
    field.checked ? selected.add(field.dataset.slot) : selected.delete(field.dataset.slot);
    setSelectedSlots(selected);
    renderOrganizer();
    $('[data-slot="' + field.dataset.slot + '"]').focus();
  }
  if (field.id === 'all-slots') {
    setSelectedSlots(new Set(field.checked ? event().slots.map(slot => slot.id) : []));
    renderOrganizer();
    $('#all-slots').focus();
  }
});

function refreshEvent(next) {
  const previous = record;
  record = next;
  if (screen === 'answer' && record && previous && record.event.status === previous.event.status &&
      record.event.revision === previous.event.revision && draft().dirty) {
    const count = $('#submitted-count');
    if (count) count.textContent = record.responses.length + ' 人回答済み';
    return;
  }
  if (screen === 'organizer' && record && !busy && record.event.revision !== previous?.event.revision) resetOrganizer();
  render();
}

DemoStore.subscribe(id => {
  if (screen === 'home') {
    renderHome();
    return;
  }
  if (store === DemoStore && id === eventId) refreshEvent(DemoStore.get(id));
});

$('#sample').addEventListener('click', () => { if (!busy) openEvent(sampleId, 'results'); });
$('.skip').addEventListener('click', evt => {
  evt.preventDefault();
  $('#main').focus();
});
function restoreRoute() {
  const id = eventFromURL();
  if (id) openEvent(id, history.state?.screen || 'answer', true);
  else openHome(true);
}
async function start() {
  let failed = false;
  if (globalThis.YOSERU_FIREBASE_CONFIG) {
    const controls = [$('#go-home'), $('#new-event'), $('#sample')];
    controls.forEach(control => { control.disabled = true; });
    renderLoading('共有モードに接続中…');
    try {
      cloud = await FirebaseStore.connect(globalThis.YOSERU_FIREBASE_CONFIG);
    } catch {
      failed = true;
    } finally {
      controls.forEach(control => { control.disabled = false; });
    }
  }
  window.addEventListener('popstate', restoreRoute);
  restoreRoute();
  if (failed) toast('Firebaseに接続できませんでした。ローカルデモを表示しています。');
  else if (!DemoStore.persistent) toast('ブラウザの保存機能が無効です。このタブを閉じるまで操作できます。');
}

start();
