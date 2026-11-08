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
  const memo = event().memo ?? '';
  org = {
    month: new Date(Date.UTC(initial.getUTCFullYear(), initial.getUTCMonth(), 1)),
    dates: new Set(), selected: new Set(), title: event().title, minimum: String(event().minimum),
    minimumPeople: String(event().minimumPeople ?? 1), memo, savedMemo: memo,
    time: { sh: '18', sm: '00', eh: '20', em: '00' }, hasEnd: false, addDraft: null
  };
}

function openEvent(id, initialView, replace = false) {
  closeMenu();
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
    rememberPersonalEvent();
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
  closeMenu();
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

function closeMenu(restoreFocus = false) {
  const toggle = $('#menu-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') return;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) toggle.focus();
}

function renderLoading(message) {
  $('#event-header').hidden = true;
  $('#views').hidden = true;
  $('#go-home').removeAttribute('aria-current');
  $('#sample').removeAttribute('aria-current');
  renderPins();
  view.removeAttribute('aria-labelledby');
  view.innerHTML = '<div class="panel view-heading" role="status">' + esc(message) + '</div>';
}

function connectionError(error) {
  if (error.code === 'permission-denied') return 'この操作は許可されていません。共有設定を確認してください。';
  if (error.code === 'unavailable') return '接続できません。通信を確認して、もう一度お試しください。';
  return error.message;
}

function personalIdentities() {
  return new Set(cloud ? [localUid, cloud.identity()] : [localUid]);
}

function rememberPersonalEvent(submitted = false) {
  if (!record) return;
  const { id, title, ownerUid } = event();
  try {
    if (DemoStore.isPinned(baseUid, id)) DemoStore.pin(baseUid, id, title);
    if (id !== sampleId && ownerUid !== baseUid && (submitted || record.responses.some(response => response.uid === baseUid))) {
      DemoStore.rememberJoined(baseUid, id, title);
    }
  } catch {
    toast('このブラウザーのイベント一覧を更新できませんでした。');
  }
}

function renderEventMemo(root) {
  const memo = event().memo ?? '';
  $('#event-overview', root).hidden = !memo;
  $('#event-memo', root).textContent = memo;
}

function updatePinButton(button) {
  const pinned = DemoStore.isPinned(baseUid, eventId);
  button.setAttribute('aria-pressed', pinned);
  button.querySelector('span').textContent = pinned ? '★' : '☆';
}

function renderPins() {
  const items = [];
  for (const identity of personalIdentities()) {
    for (const { id, title } of DemoStore.listPinned(identity)) {
      const item = template('pin');
      const open = $('.pinned-open', item);
      open.dataset.eventId = id;
      open.textContent = title;
      if (id === eventId) open.setAttribute('aria-current', 'page');
      const remove = $('.pinned-remove', item);
      remove.dataset.eventId = id;
      remove.dataset.identity = identity;
      remove.setAttribute('aria-label', `「${title}」のピン留めを外す`);
      items.push(item);
    }
  }
  $('#pinned-events').replaceChildren(...items);
  $('#pinned-empty').hidden = items.length > 0;
}

function renderHome() {
  const content = template('home');
  const events = [...(cloud?.listOwned() ?? []), ...DemoStore.listOwned(localUid)];
  const updated = event => event.updatedAt?.toMillis?.() ?? event.updatedAt ?? 0;
  events.sort((a, b) => updated(b.event) - updated(a.event));
  $('#home-count', content).textContent = events.length + '件';
  $('#home-empty', content).hidden = events.length > 0;
  $('#home-columns', content).hidden = !events.length;
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
  const ownedIds = new Set(events.map(({ event }) => event.id));
  const joined = new Map();
  for (const identity of personalIdentities()) {
    for (const { id, title } of DemoStore.listJoined(identity)) {
      if (!ownedIds.has(id)) joined.set(id, title);
    }
  }
  const joinedList = $('#joined-events', content);
  for (const [id, title] of joined) {
    const item = template('joined-event');
    $('[data-action=open-event]', item).dataset.eventId = id;
    $('[data-event-title]', item).textContent = title;
    joinedList.append(item);
  }
  $('#joined-count', content).textContent = joined.size + '件';
  $('#joined-empty', content).hidden = joined.size > 0;
  joinedList.hidden = !joined.size;
  view.replaceChildren(content);
}

function render() {
  const header = $('#event-header');
  const nav = $('#views');
  const home = screen === 'home';
  renderPins();
  const shared = Boolean(cloud && (home || store === cloud));
  $('#mode-label').textContent = shared ? '共有モード' : 'ローカルデモ';
  $('#storage-note').textContent = shared ? '保存済みの回答を、同じイベントのURLで共有します' : 'デモの回答はこのブラウザに保存されます';
  const homeButton = $('#go-home');
  const sampleButton = $('#sample');
  if (!home && eventId === sampleId) sampleButton.setAttribute('aria-current', 'page');
  else sampleButton.removeAttribute('aria-current');
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
    header.innerHTML = '<div><h1>イベントが見つかりません</h1><p>このブラウザに保存されているイベントを開くか、回答入りデモをお試しください。</p></div>';
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
  $('#event-minimum-people', content).textContent = '最低 ' + (event().minimumPeople ?? 1) + ' 人';
  updatePinButton($('[data-action=pin-event]', content));
  renderEventMemo(content);

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
  const settings = $('.event-settings', content);
  const previousSettings = $('.event-settings', view);
  settings.dataset.eventId = eventId;
  settings.hidden = closed || event().locked;
  settings.open = previousSettings?.dataset.eventId === eventId ? previousSettings.open : !slotCount;
  $('#organizer-memo', content).value = org.memo;
  if (settings.hidden) {
    $('[data-action=settings]', content).textContent = 'メモを保存';
    $('#settings-save-help', content).textContent = 'このイベントの概要を保存します。';
  }
  $('.organizer-grid', content).hidden = closed;
  $('#calendar-section', content).hidden = editing;
  $('#time-section', content).setAttribute('aria-labelledby', editing ? 'edit-time-title' : 'add-time-title');
  const editorButton = $('#jump-to-editor', content);
  editorButton.hidden = closed;
  if (editing) editorButton.textContent = '日時を編集';

  if (!closed) {
    $('#event-name', content).value = org.title;
    $('#minimum', content).value = org.minimum;
    $('#minimum-people', content).value = org.minimumPeople;
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
    if (org.checkedSlots) checkSlotInputs(content);
  }
  if (!settings.hidden && org.checkedSettings) checkSettings(content);

  $('#registered-count', content).textContent = slotCount + '件';
  $('#registered-slots', content).innerHTML = slotList(!closed);
  $('#slot-list-tools', content).hidden = closed || !slotCount;
  $('#all-slots', content).checked = slotCount > 0 && org.selected.size === slotCount;
  $('#bulk-count', content).textContent = org.selected.size;
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
  $('[data-slot-error]', content).id = 'time-error-' + slot.id;
  return content;
}

function answerCard(slot, answer) {
  const content = template('answer-card');
  const date = dateText(slot.date);
  $('[data-answer]', content).dataset.answer = slot.id;
  $('.slot-date', content).textContent = date;
  $('[data-slot-time]', content).textContent = rangeText(slot.start, slot.end);
  $('[data-no-end]', content).hidden = slot.end !== null;
  $('[data-answer-required]', content).id = 'answer-required-' + slot.id;
  $('.choices', content).setAttribute('aria-label', date + ' ' + minutesText(slot.start) + ' の回答');
  for (const choice of $$('[data-mark]', content)) {
    choice.setAttribute('aria-pressed', String(answer?.mark === choice.dataset.mark));
  }

  const yesBuffer = $('[data-yes-buffer]', content);
  const maybeBuffer = $('[data-maybe-buffer]', content);
  if (slot.end !== null && answer?.mark === 'yes') {
    yesBuffer.hidden = false;
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
  $('#answer-minimum', content).textContent = event().minimum;
  $('#answer-minimum-people', content).textContent = event().minimumPeople ?? 1;
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
  const name = $('#answer-name');
  const missingName = current.checked && !current.name.trim();
  showInputError([name], $('#answer-name-error'), missingName ? '名前を入力してください。' : '');
  let firstError = missingName ? name : null;
  let filled = 0;
  const cards = $$('[data-answer]', view);
  slots.forEach((slot, index) => {
    const card = cards[index];
    const answer = current.answers[slot.id];
    const error = Schedule.answerError(slot, answer);
    const missing = !answer?.mark;
    if (!missing) filled++;
    const missingError = missing && current.checked ? error : '';
    const timeError = missing ? '' : error;
    const group = $('.choices', card);
    showInputError([group], $('[data-answer-required]', card), missingError);
    const timing = $('[data-slot-error]', card);
    const sliders = $$('[data-offset]', card);
    if (timing) showInputError(sliders, timing, timeError);
    card.classList.toggle('has-error', Boolean(missingError || timeError));
    if (missingError) firstError ??= $('[data-mark=yes]', group);
    if (timeError) firstError ??= sliders[0] ?? $('[data-mark=yes]', group);
  });
  $('#answer-count').textContent = filled + ' / ' + slots.length + ' 件に回答';
  $('#answer-note').textContent = firstError ? '赤く表示された項目を確認してください。' :
    current.dirty ? '入力途中の回答は、保存するまで一覧に表示されません。' :
    record.responses.some(response => response.uid === uid) ? '保存済みの回答を表示しています。' : '入力途中の回答は、保存するまで一覧に表示されません。';
  return firstError;
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
  $('#results-minimum-people', content).textContent = event().minimumPeople ?? 1;
  $('#no-proposals', content).hidden = proposals.length > 0;
  $('#no-proposals-unmet', content).hidden = !responseCount;
  $('#no-proposals-pending', content).hidden = Boolean(responseCount);
  $('.proposal-table', content).hidden = !proposals.length;
  const canFinalize = owner() && event().status === 'open';
  $('#proposal-action', content).hidden = !canFinalize;

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
    finalize.closest('td').hidden = !canFinalize;
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

function showInputError(fields, error, message, invalidFields = fields) {
  if (error.textContent !== message) error.textContent = message;
  error.hidden = !message;
  for (const field of fields) {
    if (message && invalidFields.includes(field)) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', error.id);
    } else if (field.getAttribute('aria-describedby') === error.id) {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
    }
  }
}

function checkSettings(root = view) {
  const validNumber = (text, max) => /^\d+$/.test(text) && +text >= 1 && +text <= max;
  const checks = [
    ['event-name', org.title.trim(), 'イベント名を入力してください。'],
    ['minimum', validNumber(org.minimum, Schedule.DAY), '1〜1440分で入力してください。'],
    ['minimum-people', validNumber(org.minimumPeople, Schedule.MAX_PEOPLE), '1〜9999人で入力してください。']
  ];
  let firstError = null;
  for (const [id, valid, message] of checks) {
    const field = $('#' + id, root);
    showInputError([field], $('#' + id + '-error', root), valid ? '' : message);
    if (!valid) firstError ??= field;
  }
  return firstError;
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
  if (org.checkedSlots) checkSlotInputs();
  if (key.endsWith('h')) {
    const combo = button.closest('.combo');
    updateClockChoices(combo);
    focusClockChoice(combo, 'm');
  } else {
    closeClocks();
    input.focus({ preventScroll: true });
  }
}

function checkSlotInputs(root = view) {
  const { sh, sm, eh, em } = org.time;
  const start = Schedule.readClock(sh, sm);
  const end = org.hasEnd ? Schedule.readClock(eh, em) : null;
  const calendarTitle = $('#calendar-title', root);
  const missingDate = !org.selected.size && !org.dates.size;
  showInputError([calendarTitle], $('#calendar-error', root), missingDate ? 'カレンダーで日付を選んでください。' : '');
  $('#calendar-section', root).classList.toggle('has-error', missingDate);

  const editDate = $('#edit-date', root);
  const parsed = dateUTC(org.editDate);
  const badEditDate = org.selected.size === 1 &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(org.editDate) || Number.isNaN(parsed.getTime()) || isoDate(parsed) !== org.editDate);
  showInputError([editDate], $('#edit-date-error', root), badEditDate ? '変更後の日付を指定してください。' : '');
  let firstError = missingDate ? calendarTitle : badEditDate ? editDate : null;

  for (const [prefix, hour, minute, enabled] of [['s', sh, sm, true], ['e', eh, em, org.hasEnd]]) {
    const fields = [$('#' + prefix + 'h', root), $('#' + prefix + 'm', root)];
    const wrongOrder = prefix === 'e' && start !== null && end !== null && start >= end;
    const invalid = enabled ? fields.filter((_, index) => wrongOrder || (index === 0
      ? Schedule.readClock(hour, '0') === null : Schedule.readClock('0', minute) === null)) : [];
    const message = wrongOrder ? '終了時刻は開始時刻より後にしてください。' : invalid.length ? '時は0〜23、分は0〜59の半角数字で入力してください。' : '';
    showInputError(fields, $('#' + prefix + '-clock-error', root), message, invalid);
    firstError ??= invalid[0];
  }
  return { firstError, start, end };
}

function setSelectedSlots(selected) {
  org.checkedSlots = false;
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
  if (editing && !org.selected.size) throw new Error('編集する候補を選んでください。');
  $('#org-error').hidden = true;
  org.checkedSlots = true;
  const { firstError, start, end } = checkSlotInputs();
  if (firstError) { firstError.focus(); return; }
  const time = { start, end };
  const old = event().slots;
  const editDate = editing && org.selected.size === 1 ? org.editDate : null;
  const slots = editing ? old.map(slot => org.selected.has(slot.id) ? { ...slot, ...time, date: editDate ?? slot.date } : slot) :
    old.concat([...org.dates].map(date => ({ id: store.id(), date, ...time })));
  const keys = slots.map(slot => [slot.date, slot.start, slot.end].join('/'));
  if (new Set(keys).size < keys.length) throw new Error('同じ日付・時刻の候補がすでにあります。時間を変えるか、日付の選択を見直してください。');
  await store.update(eventId, uid, event().revision, { slots: slots.sort(Schedule.slotOrder) });
  org.checkedSlots = false;
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

function showShare(saved = false) {
  const content = template('share');
  $('#share-saved', content).hidden = !saved;
  const input = $('#share-url', content);
  input.value = shareURL();
  input.addEventListener('click', () => input.select());
  let message = '参加者に送ると、このリンクから回答・結果の確認ができます。';
  if (event().status === 'closed') message = '参加者に送ると、確定した日程と結果を確認できます。';
  else if (!event().slots.length) message = '候補日時を追加すると、参加者がこのリンクから回答できます。';
  if (store !== cloud) message = 'ローカルデモのリンクです。イベントは作成したブラウザーで確認できます。';
  $('#share-message', content).textContent = message;
  dialog.replaceChildren(content);
  dialog.showModal();
}

let pendingFinal;
let pendingReopen;
const actions = {
  home: () => { if (screen !== 'home') openHome(); else closeMenu(true); },
  'toggle-menu': button => button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') !== 'true'),
  'new-event': async () => {
    const destination = cloud || DemoStore;
    openEvent(await destination.create(destination.identity()), 'organizer');
  },
  'open-event': button => openEvent(button.dataset.eventId, 'organizer'),
  'pin-event': button => {
    if (DemoStore.isPinned(baseUid, eventId)) DemoStore.unpin(baseUid, eventId);
    else DemoStore.pin(baseUid, eventId, event().title);
    updatePinButton(button);
    renderPins();
  },
  'unpin-event': button => {
    const { identity, eventId: id } = button.dataset;
    DemoStore.unpin(identity, id);
    const currentPin = $('[data-action=pin-event]');
    if (currentPin && id === eventId && identity === baseUid) updatePinButton(currentPin);
    renderPins();
    ($('#pinned-events .pinned-open') ?? $('#go-home')).focus();
  },
  view: button => setScreen(button.dataset.key),
  'focus-editor': () => $(org.selected.size ? '#edit-time-title' : '#calendar-title').focus(),
  share: () => showShare(),
  help: () => {
    dialog.replaceChildren(template('help'));
    dialog.showModal();
  },
  'close-dialog': () => dialog.close(),
  copy: async () => {
    const input = $('#share-url');
    try {
      await navigator.clipboard.writeText(input.value);
      $('#share-status').textContent = 'リンクをコピーしました。';
    } catch {
      input.focus();
      input.select();
      $('#share-status').textContent = '選択されたリンクをコピーしてください。';
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
    const savingSettings = !event().locked && event().status === 'open';
    const savingEventId = eventId;
    const changes = {};
    const memoInput = org.memo;
    const memo = memoInput.trim();
    if (memo !== org.savedMemo) changes.memo = memo;
    if (savingSettings) {
      org.checkedSettings = true;
      const firstError = checkSettings();
      if (firstError) {
        $('.event-settings').open = true;
        firstError.focus();
        return;
      }
      const title = org.title.trim();
      const minimum = +org.minimum;
      const minimumPeople = +org.minimumPeople;
      org.checkedSettings = false;
      if (title !== event().title || minimum !== event().minimum || minimumPeople !== (event().minimumPeople ?? 1)) {
        Object.assign(changes, { title, minimum, minimumPeople });
      }
    }
    if (!Object.keys(changes).length) {
      if (savingSettings) showShare();
      else toast('変更はありません。');
      return;
    }
    await store.update(eventId, uid, event().revision, changes, org.savedMemo);
    if (eventId !== savingEventId || screen !== 'organizer') return;
    if (changes.memo !== undefined) {
      org.savedMemo = memo;
      if (org.memo === memoInput) {
        org.memo = memo;
        $('#organizer-memo').value = memo;
      }
    }
    if (savingSettings) {
      $('[data-action=settings]').focus({ preventScroll: true });
      showShare(true);
    } else toast('イベント概要を保存しました。');
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
    $('#answer-error').hidden = true;
    current.checked = true;
    const firstError = updateAnswerStatus();
    if (firstError) { firstError.focus(); return; }
    await store.submit(eventId, uid, current.revision, current);
    if (uid === baseUid) rememberPersonalEvent(true);
    current.dirty = false;
    current.stale = false;
    current.checked = false;
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
  if (evt.key === 'Escape' && evt.target.closest('.sidebar')) closeMenu(true);
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
  if (field.id === 'minimum-people') org.minimumPeople = field.value;
  if (field.id === 'organizer-memo') org.memo = field.value;
  if (field.id === 'edit-date') org.editDate = field.value;
  if (org?.checkedSettings && ['event-name', 'minimum', 'minimum-people'].includes(field.id)) checkSettings();
  if (org?.checkedSlots && (field.dataset.clock || field.id === 'edit-date')) {
    $('#org-error').hidden = true;
    checkSlotInputs();
  }
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
  rememberPersonalEvent();
  if (record && org) {
    const { memo, savedMemo } = org;
    if (screen === 'organizer' && !busy && record.event.revision !== previous?.event.revision) resetOrganizer();
    if (memo !== savedMemo) Object.assign(org, { memo, savedMemo });
    else org.memo = org.savedMemo = event().memo ?? '';
  }
  if (screen === 'answer' && record && previous && record.event.status === previous.event.status &&
      record.event.revision === previous.event.revision && draft().dirty) {
    const count = $('#submitted-count');
    if (count) count.textContent = record.responses.length + ' 人回答済み';
    renderEventMemo(document);
    return;
  }
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
    const controls = [$('#go-home'), $('#sample'), $('#new-event')];
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
