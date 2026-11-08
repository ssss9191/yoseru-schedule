(function () {
  'use strict';

  const DAY = 1440;
  const MAX_PEOPLE = 9999;
  const MARKS = ['yes', 'maybe', 'no'];

  function readClock(hour, minute) {
    if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return null;
    if (+hour > 23 || +minute > 59) return null;
    return +hour * 60 + +minute;
  }

  function availability(slot, answer) {
    if (!answer || answer.mark === 'no') return null;
    const end = slot.end === null ? answer.until ?? null : slot.end + (answer.to ?? 0);
    return [slot.start + (answer.from ?? 0), end];
  }

  function answerError(slot, answer) {
    if (!MARKS.includes(answer?.mark)) return '○・△・×から選んでください。';
    if (answer.mark === 'no') return '';
    const offsets = [answer.from ?? 0, slot.end === null ? 0 : answer.to ?? 0];
    if (offsets.some(value => !Number.isInteger(value) || value % 10 !== 0 || Math.abs(value) > 120)) {
      return '時間の調整は前後120分以内、10分刻みで指定してください。';
    }
    if (answer.mark === 'yes' && (offsets[0] > 0 || offsets[1] < 0)) {
      return slot.end === null ? '○では元の枠より早い開始を指定できます。' : '○では元の枠より早い開始・遅い終了を指定できます。';
    }
    const [start, end] = availability(slot, answer);
    if (slot.end === null) {
      if (end === null) return '';
      if (!Number.isInteger(end) || end < 0 || end >= 2 * DAY) return '参加できる上限時刻を当日または翌日で指定してください。';
      return start >= end ? '参加できる上限時刻は、開始時刻より後にしてください。' : '';
    }
    return start >= end ? '開始を終了より前にしてください。' : '';
  }

  function compareProposals(a, b) {
    return b.people.length - a.people.length || a.shift - b.shift ||
      a.slot.date.localeCompare(b.slot.date) || a.start - b.start || (a.end ?? 2 * DAY) - (b.end ?? 2 * DAY) || a.slot.id.localeCompare(b.slot.id);
  }

  function bestForOpenSlot(slot, responses) {
    const people = responses.flatMap(response => {
      const interval = availability(slot, response.answers[slot.id]);
      return interval ? [{ uid: response.uid, name: response.name, start: interval[0], end: interval[1] }] : [];
    });
    const starts = new Set([slot.start]);
    for (const person of people) {
      starts.add(person.start);
      if (person.end !== null) starts.add(person.end - 1);
    }
    let best = null;
    for (const start of starts) {
      const attending = people.filter(person => person.start <= start && (person.end === null || start < person.end));
      if (!attending.length) continue;
      const proposal = { slot, start, end: null, people: attending, shift: Math.abs(start - slot.start) };
      if (!best || compareProposals(proposal, best) < 0) best = proposal;
    }
    return best;
  }

  function bestForSlot(slot, responses, minimum) {
    if (slot.end === null) return bestForOpenSlot(slot, responses);
    const intervals = responses.flatMap(response => {
      const interval = availability(slot, response.answers[slot.id]);
      return interval && interval[1] - interval[0] >= minimum
        ? [{ uid: response.uid, name: response.name, start: interval[0], end: interval[1] }]
        : [];
    });
    if (!intervals.length) return null;

    const starts = new Set();
    // A minimum-length window finds the cohort. Include boundaries so an
    // exact fit is found even when manually entered minutes are off the grid.
    for (const interval of intervals) {
      starts.add(interval.start);
      starts.add(interval.end - minimum);
      const firstStep = Math.ceil((interval.start - slot.start) / 10);
      for (let start = slot.start + firstStep * 10; start <= interval.end - minimum; start += 10) {
        starts.add(start);
      }
    }

    let best = null;
    for (const anchor of starts) {
      const people = intervals.filter(interval => interval.start <= anchor && interval.end >= anchor + minimum);
      if (!people.length || people.length < (best?.people.length ?? 0)) continue;
      const earliest = Math.max(...people.map(person => person.start));
      const latest = Math.min(...people.map(person => person.end));
      const start = Math.max(earliest, Math.min(slot.start, latest - minimum));
      const end = Math.max(start + minimum, Math.min(slot.end, latest));
      const shift = Math.abs(start - slot.start) + Math.abs(end - slot.end);
      const proposal = { slot, start, end, shift, people };
      if (!best || compareProposals(proposal, best) < 0) best = proposal;
    }
    return best;
  }

  function proposals(event, responses) {
    const minimumPeople = event.minimumPeople ?? 1;
    if (responses.length < minimumPeople) return [];
    return event.slots.map(slot => bestForSlot(slot, responses, event.minimum))
      .filter(proposal => proposal && proposal.people.length >= minimumPeople)
      .sort(compareProposals).slice(0, 3);
  }

  function slotOrder(a, b) {
    return a.date.localeCompare(b.date) || a.start - b.start || (a.end ?? DAY) - (b.end ?? DAY);
  }

  globalThis.Schedule = { DAY, MAX_PEOPLE, readClock, availability, answerError, proposals, slotOrder };
})();
