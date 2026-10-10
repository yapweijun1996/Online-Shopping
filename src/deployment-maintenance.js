// A host operator flag on the backend's read-only volume quiesces work before database snapshots.
import { existsSync } from 'node:fs';
export const MAINTENANCE_FILE = `${process.env.DEPLOYMENT_STATE_DIR === '/run/deployment' ? '/run/deployment' : '/tmp'}/online-shopping-maintenance`;
export const deploymentPaused = (path = MAINTENANCE_FILE) => existsSync(path);
