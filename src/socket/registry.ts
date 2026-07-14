/**
 * Tiny holder for the initialised Socket.IO server so non-socket code (e.g.
 * REST routes) can broadcast without importing src/index.ts — which would
 * create a circular import (index.ts imports the routes). index.ts calls
 * setIO(io) once at startup; callers use getIO() (lazily require()'d inside a
 * handler) and tolerate null (io not up yet / test context).
 */
import type { TypedServer } from './types';

let io: TypedServer | null = null;

export function setIO(server: TypedServer): void { io = server; }
export function getIO(): TypedServer | null { return io; }
