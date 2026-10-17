import { mkdirSync } from 'node:fs';
import { openDb, systemClock } from './db';
import { Bus } from './bus';
import { createApp } from './app';
import { Worker, enqueue } from './jobs';
import { notifyHandler, cleanupHandler } from './notifications';

mkdirSync('data', { recursive: true });
const db = openDb();
const clock = systemClock;
const bus = new Bus();
const app = createApp({ db, clock, bus });

// The worker runs in-process by default. Set RUN_WORKER=false and start `npm run worker` to run it separately
// (it then can't push live notifications, and clients pick them up by polling).
if (process.env.RUN_WORKER !== 'false') {
  const worker = new Worker(db, clock, { notify: notifyHandler(db, clock, bus), cleanup: cleanupHandler(db, clock) }, (m) => console.warn(m));
  worker.start();
  const scheduleCleanup = () =>
    enqueue(db, clock, 'cleanup', {}, { dedupeKey: `cleanup:${clock.now().toISOString().slice(0, 13)}` });
  scheduleCleanup();
  setInterval(scheduleCleanup, 10 * 60_000).unref();
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Newtonite Ops API listening on http://localhost:${port}`));
