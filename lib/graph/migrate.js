import { isPredictionErrorDirection } from './prediction.js';
export function migratePegDocument(doc) {
    let changed = 0;
    const events = doc.events.map((event) => {
        if (event.op !== 'record_error' || event.error === undefined)
            return event;
        if (isPredictionErrorDirection(event.error.direction))
            return event;
        changed += 1;
        return { ...event, error: { ...event.error, direction: 'worse' } };
    });
    if (changed === 0 && doc.schemaVersion === 2)
        return { doc, changed };
    return { doc: { ...doc, schemaVersion: 2, events }, changed };
}
