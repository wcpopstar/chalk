"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Central list of queue names. Add one line here for every new queue
// (push notifications, file processing, ...) so the producer (queues/) and
// consumer (workers/) sides can't accidentally drift on the string.
module.exports = {
    EMAIL: 'email',
};
//# sourceMappingURL=queueNames.js.map