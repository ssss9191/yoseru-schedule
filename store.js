(function () {
  'use strict';

  const prefix = 'yoseru.v1.';
  const sampleId = 'demo';
  const cache = new Map();
  const listeners = new Set();
  let persistent = true;
  try {
    localStorage.setItem(`${prefix}probe`, '1');
    localStorage.removeItem(`${prefix}probe`);
  } catch {
    persistent = false;
  }

  function read(key) {
    const value = persistent ? localStorage.getItem(prefix + key) : cache.get(key);
    return value ? JSON.parse(value) : null;
  }

  function write(key, value) {
    const json = JSON.stringify(value);
    if (persistent) localStorage.setItem(prefix + key, json);
    else cache.set(key, json);
  }

  function remove(key) {
    if (persistent) localStorage.removeItem(prefix + key);
    else cache.delete(key);
  }

  function keysStartingWith(start) {
    const keys = persistent
      ? Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter(key => key?.startsWith(prefix)).map(key => key.slice(prefix.length))
      : [...cache.keys()];
    return keys.filter(key => key.startsWith(start));
  }

  function listReferences(kind, uid) {
    const start = `${kind}.${uid}.`;
    return keysStartingWith(start).map(key => ({ id: key.slice(start.length), title: read(key) }));
  }

  function rememberReference(kind, uid, eventId, title) {
    const key = `${kind}.${uid}.${eventId}`;
    if (read(key) !== title) write(key, title);
  }

  function id() {
    return [...crypto.getRandomValues(new Uint8Array(12))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function identity() {
    let uid = read('uid');
    if (!uid) {
      uid = id();
      write('uid', uid);
    }
    return uid;
  }

  function sampleSlots() {
    return [
      { id: id(), date: '2026-11-16', start: 1080, end: 1200 },
      { id: id(), date: '2026-11-16', start: 1230, end: 1320 },
      { id: id(), date: '2026-11-18', start: 1140, end: 1260 },
      { id: id(), date: '2026-11-20', start: 1080, end: null }
    ];
  }

  function makeEvent(eventId, ownerUid, title, slots) {
    return {
      id: eventId, ownerUid, title, slots, minimum: 60, minimumPeople: 1, status: 'open',
      locked: false, revision: 0, final: null, updatedAt: Date.now()
    };
  }

  function initializeSample(uid) {
    if (read(`event.${sampleId}`)) return;
    const slots = sampleSlots();
    const event = makeEvent(sampleId, uid, 'ゼミ発表の打ち合わせ', slots);
    event.locked = true;
    const yes = (from = 0, to = 0) => ({ mark: 'yes', from, to });
    const maybe = (from = 0, to = 0) => ({ mark: 'maybe', from, to });
    const no = { mark: 'no', from: 0, to: 0 };
    const responses = [
      ['demo-a', '青木', [yes(), no, no, yes()]],
      ['demo-b', '佐藤', [maybe(30, -30), yes(), yes(), maybe()]],
      ['demo-c', '田中', [yes(-30, 30), no, yes(), no]]
    ].map(([uid, name, answers]) => ({ uid, name, answers: Object.fromEntries(slots.map((slot, index) => [slot.id, answers[index]])) }));
    write(`event.${sampleId}`, { event, responses });
  }

  function get(eventId) {
    if (eventId === sampleId) initializeSample(identity());
    const record = read(`event.${eventId}`);
    return record?.event.status === 'deleted' ? null : record;
  }

  function listOwned(uid) {
    return keysStartingWith('event.').filter(key => key !== `event.${sampleId}`)
      .map(key => read(key))
      .filter(record => record?.event?.ownerUid === uid && record.event.status !== 'deleted')
      .sort((a, b) => (b.event.updatedAt ?? 0) - (a.event.updatedAt ?? 0) ||
        a.event.title.localeCompare(b.event.title, 'ja') || a.event.id.localeCompare(b.event.id));
  }

  function notify(eventId) {
    listeners.forEach(listener => listener(eventId));
  }

  function withEvent(eventId, change) {
    const save = () => {
      const record = get(eventId);
      if (!record) throw new Error('イベントが見つかりません。');
      change(record);
      record.event.updatedAt = Date.now();
      write(`event.${eventId}`, record);
      notify(eventId);
      return record;
    };
    if (navigator.locks && persistent) return navigator.locks.request(prefix + eventId, save);
    return Promise.resolve().then(save);
  }

  function requireOwner(event, uid) {
    if (event.ownerUid !== uid) throw new Error('主催者として操作してください。');
  }

  function create(uid) {
    const event = makeEvent(id(), uid, '新しい日程調整', []);
    write(`event.${event.id}`, { event, responses: [] });
    return event.id;
  }

  function deleteEvent(eventId, uid) {
    if (eventId === sampleId) throw new Error('デモは削除できません。');
    return withEvent(eventId, record => {
      requireOwner(record.event, uid);
      record.event = { id: eventId, ownerUid: uid, status: 'deleted' };
      record.responses = [];
    });
  }

  function editEvent(event, uid, revision, changes, expectedMemo) {
    requireOwner(event, uid);
    if (changes.memo !== undefined) {
      if (typeof changes.memo !== 'string' || changes.memo.length > 500) {
        throw new Error('イベント概要は500文字以内で入力してください。');
      }
      if (expectedMemo !== undefined && (event.memo ?? '') !== expectedMemo) {
        throw new Error('イベント概要が更新されました。開き直して内容を確認してください。');
      }
      if (Object.keys(changes).length === 1) {
        event.memo = changes.memo;
        return;
      }
    }
    if (event.status === 'closed') throw new Error('確定を取り消してから候補を編集してください。');
    if (event.revision !== revision) throw new Error('別のタブで候補が変更されました。最新の候補を確認してください。');
    if (changes.title !== undefined && (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.length > 60)) {
      throw new Error('イベント名は1〜60文字で入力してください。');
    }
    if (changes.minimum !== undefined && (!Number.isInteger(changes.minimum) || changes.minimum < 1 || changes.minimum > Schedule.DAY)) {
      throw new Error('最低開催時間は1〜1440分で入力してください。');
    }
    if (changes.minimumPeople !== undefined && (!Number.isInteger(changes.minimumPeople) ||
        changes.minimumPeople < 1 || changes.minimumPeople > Schedule.MAX_PEOPLE)) {
      throw new Error('最低参加人数は1〜9999人で入力してください。');
    }
    if (changes.slots) {
      const previous = new Map(event.slots.map(slot => [slot.id, slot]));
      // A changed time is a new choice. Its previous answers cannot follow it.
      changes = { ...changes, slots: changes.slots.map(slot => {
        const old = previous.get(slot.id);
        return old && (old.date !== slot.date || old.start !== slot.start || old.end !== slot.end)
          ? { ...slot, id: id() } : slot;
      }) };
    }
    Object.assign(event, changes, { revision: revision + 1 });
  }

  function makeResponse(event, uid, revision, draft) {
    if (event.status === 'closed') throw new Error('日程が確定し、回答受付は終了しました。');
    if (event.revision !== revision) throw new Error('候補が変更されました。最新の日時を確認してから保存してください。');
    const name = draft.name.trim();
    if (!name || name.length > 40) throw new Error('名前を1〜40文字で入力してください。');
    if (!event.slots.length) throw new Error('回答できる候補がまだありません。');
    const answers = Object.fromEntries(event.slots.map(slot => {
      const answer = draft.answers[slot.id];
      const error = Schedule.answerError(slot, answer);
      if (error) throw new Error(error);
      const attending = answer.mark !== 'no';
      const saved = {
        mark: answer.mark,
        from: attending ? answer.from ?? 0 : 0,
        to: attending && slot.end !== null ? answer.to ?? 0 : 0
      };
      if (attending && slot.end === null && answer.until != null) saved.until = answer.until;
      return [slot.id, saved];
    }));
    return { uid, name, answers };
  }

  function update(eventId, uid, revision, changes, expectedMemo) {
    return withEvent(eventId, ({ event }) => editEvent(event, uid, revision, changes, expectedMemo)).then(record => record.event);
  }

  function submit(eventId, uid, revision, draft) {
    return withEvent(eventId, ({ event, responses }) => {
      const response = makeResponse(event, uid, revision, draft);
      const index = responses.findIndex(item => item.uid === uid);
      if (index < 0) responses.push(response);
      else responses[index] = response;
      event.locked = true;
    });
  }

  function setFinal(event, responses, uid, selected) {
    requireOwner(event, uid);
    if (event.status === 'closed') throw new Error('この日程は確定済みです。');
    const proposal = Schedule.proposals(event, responses).find(item =>
      item.slot.id === selected.slot.id && item.start === selected.start && item.end === selected.end &&
      item.people.length === selected.people.length && item.people.every(person => selected.people.some(old => old.uid === person.uid)));
    if (!proposal) throw new Error('回答が更新されました。最新の提案を確認してください。');
    event.final = { slotId: proposal.slot.id, date: proposal.slot.date, start: proposal.start, end: proposal.end, count: proposal.people.length };
    if (proposal.end === null) event.final.sourceStart = proposal.slot.start;
    event.status = 'closed';
    event.locked = true;
  }

  function clearFinal(event, uid, expectedFinal) {
    requireOwner(event, uid);
    const final = event.final;
    if (event.status !== 'closed' || !final) throw new Error('回答受付はすでに再開されています。');
    if (final.slotId !== expectedFinal.slotId || final.start !== expectedFinal.start || final.end !== expectedFinal.end) {
      throw new Error('確定日時が変わりました。最新の日時を確認してください。');
    }
    event.final = null;
    event.status = 'open';
  }

  function finalize(eventId, uid, selected) {
    return withEvent(eventId, ({ event, responses }) => setFinal(event, responses, uid, selected));
  }

  function reopen(eventId, uid, expectedFinal) {
    return withEvent(eventId, ({ event }) => clearFinal(event, uid, expectedFinal));
  }

  window.addEventListener('storage', event => {
    const eventPrefix = `${prefix}event.`;
    if (event.key?.startsWith(eventPrefix)) notify(event.key.slice(eventPrefix.length));
  });

  globalThis.EventModel = { id, makeEvent, editEvent, makeResponse, setFinal, clearFinal };

  // The view never writes
  // directly to browser storage or publishes a draft response.
  globalThis.DemoStore = {
    get, listOwned, create, update, submit, finalize, reopen, deleteEvent, identity, id, sampleId, persistent,
    listPinned: uid => listReferences('pin', uid),
    isPinned: (uid, eventId) => read(`pin.${uid}.${eventId}`) !== null,
    pin: (uid, eventId, title) => rememberReference('pin', uid, eventId, title),
    unpin: (uid, eventId) => remove(`pin.${uid}.${eventId}`),
    listJoined: uid => listReferences('joined', uid),
    rememberJoined: (uid, eventId, title) => rememberReference('joined', uid, eventId, title),
    forgetJoined: (uid, eventId) => remove(`joined.${uid}.${eventId}`),
    profiles(eventId) { return read('profiles.' + eventId) ?? []; },
    addProfile(eventId) {
      const uid = id();
      write('profiles.' + eventId, [...this.profiles(eventId), uid]);
      return uid;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
})();
