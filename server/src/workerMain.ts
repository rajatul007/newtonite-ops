// Standalone worker process. Several can run at once: job leasing makes them cooperate safely.
import { openDb, systemClock } from './db';
import { Worker } from './jobs';
import { notifyHandler, cleanupHandler } from './notifications';

const db = openDb();
const worker = new Worker(db, systemClock, { notify: notifyHandler(db, systemClock), cleanup: cleanupHandler(db, systemClock) }, console.warn);
worker.start(500);
console.log(`${worker.id} started`);
process.on('SIGINT', () => {
  worker.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
