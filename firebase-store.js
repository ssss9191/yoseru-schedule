(function () {
  'use strict';

  const sdk = 'https://www.gstatic.com/firebasejs/13.2.0/';

  async function connect(config) {
    const [appSdk, authSdk, firestore] = await Promise.all([
      import(sdk + 'firebase-app.js'),
      import(sdk + 'firebase-auth.js'),
      import(sdk + 'firebase-firestore.js')
    ]);
    const app = appSdk.initializeApp(config);
    const auth = authSdk.getAuth(app);
    await auth.authStateReady();
    const user = auth.currentUser || (await authSdk.signInAnonymously(auth)).user;
    const db = firestore.getFirestore(app);
    const events = firestore.collection(db, 'events');
    const eventRef = id => firestore.doc(events, id);
    const responsesRef = id => firestore.collection(eventRef(id), 'responses');
    const model = EventModel;
    let owned = [];

    function readEvent(document) {
      const event = document.data();
      const badSlot = slot => !slot || typeof slot.id !== 'string' || typeof slot.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || Number.isNaN(Date.parse(slot.date + 'T00:00:00Z')) ||
        !Number.isInteger(slot.start) || slot.start < 0 || slot.start >= Schedule.DAY ||
        (slot.end !== null && (!Number.isInteger(slot.end) || slot.end <= slot.start || slot.end >= Schedule.DAY));
      if (!event || event.id !== document.id || typeof event.title !== 'string' ||
          !Number.isInteger(event.minimum) || !Array.isArray(event.slots) || event.slots.some(badSlot) ||
          !Array.isArray(event.slotIds) || event.slots.length !== event.slotIds.length ||
          event.slots.some((slot, index) => slot.id !== event.slotIds[index])) {
        throw new Error('イベントの候補日時を読み込めませんでした。');
      }
      return event;
    }

    function readResponses(snapshot, event) {
      return snapshot.docs.flatMap(document => {
        const response = document.data();
        if (response.uid !== document.id || typeof response.name !== 'string' ||
            !response.name.trim() || response.name.length > 40 || !response.answers ||
            event.slots.some(slot => Schedule.needsBuffer(slot, response.answers[slot.id]) ||
              Schedule.answerError(slot, response.answers[slot.id]))) return [];
        return [{ uid: response.uid, name: response.name, answers: response.answers }];
      });
    }

    function watchEvent(id, onChange, onError) {
      let currentEvent;
      let currentResponses;
      let stopResponses;
      function emit() {
        if (currentEvent && currentResponses) {
          onChange({ event: currentEvent, responses: readResponses(currentResponses, currentEvent) });
        }
      }
      const stopEvent = firestore.onSnapshot(eventRef(id), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.exists()) {
          currentEvent = null;
          currentResponses = null;
          stopResponses?.();
          stopResponses = undefined;
          if (!snapshot.metadata.fromCache) onChange(null);
          return;
        }
        try {
          currentEvent = readEvent(snapshot);
        } catch (error) {
          onError(error);
          return;
        }
        if (!stopResponses) {
          stopResponses = firestore.onSnapshot(responsesRef(id), { includeMetadataChanges: true }, answers => {
            if (answers.metadata.hasPendingWrites) return;
            currentResponses = answers;
            emit();
          }, onError);
        } else emit();
      }, onError);
      return () => {
        stopEvent();
        stopResponses?.();
      };
    }

    function watchOwned(onChange, onError) {
      const query = firestore.query(events, firestore.where('ownerUid', '==', user.uid));
      return firestore.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
        try {
          owned = snapshot.docs.filter(document => !document.metadata.hasPendingWrites)
            .map(document => ({ event: readEvent(document) }));
          onChange();
        } catch (error) {
          onError(error);
        }
      }, onError);
    }

    async function create() {
      const event = model.makeEvent(model.id(), user.uid, '新しい日程調整', []);
      await firestore.runTransaction(db, async transaction => {
        const ref = eventRef(event.id);
        if ((await transaction.get(ref)).exists()) throw new Error('もう一度、イベントを作成してください。');
        transaction.set(ref, {
          ...event, slotIds: [], responseCount: 0, responseVersion: 0, updatedAt: firestore.serverTimestamp()
        });
      });
      return event.id;
    }

    function changeEvent(id, change) {
      return firestore.runTransaction(db, async transaction => {
        const ref = eventRef(id);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('イベントが見つかりません。');
        const changes = await change(readEvent(snapshot), transaction);
        transaction.update(ref, { ...changes, updatedAt: firestore.serverTimestamp() });
      });
    }

    function update(id, uid, revision, changes) {
      return changeEvent(id, event => {
        model.editEvent(event, uid, revision, changes);
        const { title, minimum, slots } = event;
        return { title, minimum, slots, slotIds: slots.map(slot => slot.id), revision: event.revision };
      });
    }

    function submit(id, uid, revision, draft) {
      return changeEvent(id, async (event, transaction) => {
        const response = model.makeResponse(event, uid, revision, draft);
        const ref = firestore.doc(responsesRef(id), uid);
        const previous = await transaction.get(ref);
        transaction.set(ref, { ...response, updatedAt: firestore.serverTimestamp() });
        return {
          locked: true, responseCount: event.responseCount + (previous.exists() ? 0 : 1),
          responseVersion: event.responseVersion + 1
        };
      });
    }

    async function finalize(id, uid, selected) {
      const snapshot = await firestore.getDocFromServer(eventRef(id));
      if (!snapshot.exists()) throw new Error('イベントが見つかりません。');
      const before = readEvent(snapshot);
      const responses = readResponses(await firestore.getDocsFromServer(responsesRef(id)), before);
      return changeEvent(id, event => {
        if (event.responseVersion !== before.responseVersion) throw new Error('回答が更新されました。最新の提案を確認してください。');
        model.setFinal(event, responses, uid, selected);
        return { status: event.status, final: event.final };
      });
    }

    function reopen(id, uid, expectedFinal) {
      return changeEvent(id, event => {
        model.clearFinal(event, uid, expectedFinal);
        return { status: event.status, final: event.final };
      });
    }

    return {
      identity: () => user.uid, id: model.id, listOwned: () => owned,
      watchEvent, watchOwned, create, update, submit, finalize, reopen
    };
  }

  globalThis.FirebaseStore = { connect };
})();
