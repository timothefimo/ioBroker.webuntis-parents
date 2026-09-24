'use strict';
const assert = require('assert');
const { UntisClient, parseWeek, normalize, summarize, splitDays, slug } = require('../lib/untis');

// --- Beispieldaten im Format von /api/public/timetable/weekly/data ---
const SID = 4711;
const week = {
    elements: [
        { type: 1, id: 10, name: '7b', longName: 'Klasse 7b' },
        { type: 2, id: 20, name: 'MÜ', longName: 'Müller' },
        { type: 2, id: 21, name: 'ME', longName: 'Meier' },
        { type: 3, id: 30, name: 'M', longName: 'Mathematik' },
        { type: 3, id: 31, name: 'D', longName: 'Deutsch' },
        { type: 4, id: 40, name: 'R101', longName: 'Raum 101' },
    ],
    elementPeriods: {
        [SID]: [
            { date: 20260924, startTime: 935, endTime: 1020, cellState: 'CANCEL',
                elements: [{ type: 3, id: 31 }, { type: 2, id: 21 }, { type: 4, id: 40 }] },
            { date: 20260924, startTime: 800, endTime: 845, cellState: 'SUBSTITUTION', substText: 'Vertretung',
                elements: [{ type: 1, id: 10 }, { type: 3, id: 30 }, { type: 2, id: 20, orgId: 21 }, { type: 4, id: 40 }] },
            { date: 20260925, startTime: 800, endTime: 845, cellState: 'STANDARD',
                elements: [{ type: 3, id: 30 }, { type: 2, id: 21 }, { type: 4, id: 40 }] },
        ],
    },
};

const lessons = normalize(parseWeek(week, SID).concat(parseWeek(week, SID)));
assert.strictEqual(lessons.length, 3, 'Duplikate entfernt');
assert.strictEqual(lessons[0].start, '08:00');
assert.strictEqual(lessons[0].subjectLong, 'Mathematik');
assert.strictEqual(lessons[0].teacher, 'MÜ');
assert.strictEqual(lessons[0].teacherOrg, 'ME');
assert.strictEqual(lessons[0].info, 'Vertretung');
assert.strictEqual(lessons[1].cancelled, true);

const days = splitDays(lessons, '2026-09-24');
assert.strictEqual(days.today.length, 2);
assert.strictEqual(days.nextDate, '2026-09-25');
const sum = summarize(days.today);
assert.deepStrictEqual(sum, { count: 1, begin: '08:00', end: '08:45', cancelled: true, changed: true });
assert.strictEqual(slug('Lena Müller'), 'lena_mueller');

// --- Client-Ablauf mit gemocktem HTTP ---
(async () => {
    const c = new UntisClient({ server: 'https://xyz.webuntis.com/WebUntis/', school: 'my-school', username: 'papa', password: 'x' });
    assert.strictEqual(c.base, 'https://xyz.webuntis.com/WebUntis');
    const calls = [];
    c.http = {
        post: async (url, body, opt) => {
            calls.push(body.method);
            return { data: { result: { sessionId: 'ABC', personType: 12, personId: 1 } } };
        },
        get: async (url, opt) => {
            calls.push(url.replace(c.base, ''));
            if (url.endsWith('/api/token/new')) return { data: 'JWT123' };
            if (url.includes('/app/data')) return { data: { user: { students: [{ id: SID, displayName: 'Lena Müller' }] } } };
            if (url.includes('/weekly/data')) {
                assert.strictEqual(opt.headers.Authorization, 'Bearer JWT123');
                assert.ok(opt.headers.Cookie.includes('JSESSIONID=ABC'));
                return { data: { data: { result: { data: week } } } };
            }
            throw new Error('unexpected ' + url);
        },
    };
    await c.login();
    const st = await c.getStudents();
    assert.deepStrictEqual(st, [{ id: SID, name: 'Lena Müller' }]);
    const w = await c.getWeek(SID, '2026-09-24');
    assert.strictEqual(w.length, 3);
    await c.logout();
    assert.deepStrictEqual(calls, ['authenticate', '/api/token/new', '/api/rest/view/v1/app/data', '/api/public/timetable/weekly/data', 'logout']);
    console.log('Alle Tests OK');
})().catch(e => { console.error(e); process.exit(1); });
