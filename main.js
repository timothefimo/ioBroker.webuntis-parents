'use strict';

/*
 * ioBroker.webuntis-parents
 * Stundenplan aus WebUntis – funktioniert mit Eltern- und Schülerlogin.
 */

const utils = require('@iobroker/adapter-core');
const { UntisClient, normalize, summarize, splitDays, isoDate, slug } = require('./lib/untis');

const LESSON_FIELDS = [
    ['start', 'Beginn', 'string', 'text'],
    ['end', 'Ende', 'string', 'text'],
    ['subject', 'Fach', 'string', 'text'],
    ['subjectLong', 'Fach (lang)', 'string', 'text'],
    ['teacher', 'Lehrer', 'string', 'text'],
    ['teacherOrg', 'Ursprünglicher Lehrer', 'string', 'text'],
    ['room', 'Raum', 'string', 'text'],
    ['roomOrg', 'Ursprünglicher Raum', 'string', 'text'],
    ['state', 'Status (STANDARD, CANCEL, SUBSTITUTION, …)', 'string', 'text'],
    ['cancelled', 'Entfall', 'boolean', 'indicator'],
    ['changed', 'Änderung', 'boolean', 'indicator'],
    ['info', 'Info / Vertretungstext', 'string', 'text'],
];

class WebuntisParents extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'webuntis-parents' });
        this.pollTimer = null;
        this.tickTimer = null;
        this.running = false;
        this.createdObjects = new Set();
        this.cache = {};          // key -> { name, today: [], next: [] }
        this.lastDay = isoDate(new Date());
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);

        const c = this.config;
        if (!c.server || !c.school || !c.username || !c.password) {
            this.log.error('Bitte Server, Schule, Benutzername und Passwort in der Instanz-Konfiguration eintragen.');
            return;
        }
        this.intervalMin = Math.max(10, parseInt(c.interval, 10) || 30);

        await this.setObjectNotExistsAsync('refresh', {
            type: 'state',
            common: { name: 'Jetzt aktualisieren', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        this.subscribeStates('refresh');

        await this.update();
        this.tick();
    }

    /** Planmäßiger Abruf */
    schedule() {
        if (this.pollTimer) this.clearTimeout(this.pollTimer);
        this.pollTimer = this.setTimeout(() => this.update(), this.intervalMin * 60000);
    }

    /** Minütlich: aktuelle/nächste Stunde berechnen, bei Tageswechsel neu laden */
    tick() {
        const today = isoDate(new Date());
        if (today !== this.lastDay) {
            this.lastDay = today;
            this.update();
        } else {
            this.updateCurrent().catch(e => this.log.debug(`updateCurrent: ${e.message}`));
        }
        const now = new Date();
        const msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 500;
        this.tickTimer = this.setTimeout(() => this.tick(), msToNextMinute);
    }

    async update() {
        if (this.running) return;
        this.running = true;
        const c = this.config;
        const client = new UntisClient({
            server: c.server, school: c.school, username: c.username, password: c.password,
            formatId: parseInt(c.formatId, 10) || 1,
        });

        try {
            const session = await client.login();
            this.log.debug(`Login ok (personType ${session.personType}, personId ${session.personId})`);

            let students;
            const manualIds = String(c.studentIds || '').split(/[,;\s]+/).map(s => parseInt(s, 10)).filter(n => n > 0);
            if (manualIds.length) {
                const auto = await client.getStudents();
                students = manualIds.map(id => auto.find(s => s.id === id) || { id, name: `student_${id}` });
            } else {
                students = await client.getStudents();
            }
            if (!students.length) {
                throw new Error('Keine Schüler gefunden. Schüler-ID in der Konfiguration eintragen (steht in der WebUntis-URL, wenn man den Stundenplan des Kindes öffnet).');
            }
            this.log.debug(`Schüler: ${students.map(s => `${s.name} (${s.id})`).join(', ')}`);

            const now = new Date();
            const today = isoDate(now);
            const inAWeek = isoDate(new Date(now.getTime() + 7 * 86400000));

            for (const s of students) {
                let lessons = [];
                for (const d of [today, inAWeek]) {
                    try {
                        lessons = lessons.concat(await client.getWeek(s.id, d));
                    } catch (e) {
                        this.log.warn(`Stundenplan ${s.name} (${d}): ${e.message}${e.response ? ` (HTTP ${e.response.status})` : ''}`);
                        if (e.raw) this.log.debug(`Antwort: ${JSON.stringify(e.raw).slice(0, 500)}`);
                    }
                }
                lessons = normalize(lessons);
                const days = splitDays(lessons, today);
                const key = slug(s.name);
                this.cache[key] = { name: s.name, today: days.today, next: days.next };
                await this.writeStudent(key, s, days);
            }

            await this.setState('info.connection', true, true);
            await this.setState('info.lastUpdate', Date.now(), true);
            await this.updateCurrent();
        } catch (e) {
            await this.setState('info.connection', false, true);
            this.log.error(`WebUntis: ${e.message}${e.response ? ` (HTTP ${e.response.status})` : ''}`);
        } finally {
            await client.logout();
            this.running = false;
            this.schedule();
        }
    }

    // ---------- Objekte & States ----------

    async ensureObject(id, obj) {
        if (this.createdObjects.has(id)) return;
        await this.extendObjectAsync(id, obj);
        this.createdObjects.add(id);
    }

    async setVal(id, name, type, role, val) {
        await this.ensureObject(id, {
            type: 'state',
            common: { name, type, role, read: true, write: false, def: type === 'boolean' ? false : type === 'number' ? 0 : '' },
            native: {},
        });
        await this.setStateChangedAsync(id, { val, ack: true });
    }

    async writeStudent(key, student, days) {
        await this.ensureObject(key, { type: 'device', common: { name: student.name }, native: { studentId: student.id } });
        await this.setVal(`${key}.id`, 'Schüler-ID', 'number', 'value', student.id);
        await this.setVal(`${key}.name`, 'Name', 'string', 'text', student.name);

        await this.writeDay(`${key}.today`, 'Heute', isoDate(new Date()), days.today);
        await this.writeDay(`${key}.next`, 'Nächster Schultag', days.nextDate, days.next);
    }

    async writeDay(prefix, name, date, lessons) {
        await this.ensureObject(prefix, { type: 'channel', common: { name }, native: {} });
        const sum = summarize(lessons);
        await this.setVal(`${prefix}.date`, 'Datum', 'string', 'date', date || '');
        await this.setVal(`${prefix}.json`, 'Stunden als JSON', 'string', 'json', JSON.stringify(lessons));
        await this.setVal(`${prefix}.lessonCount`, 'Anzahl Stunden (ohne Entfall)', 'number', 'value', sum.count);
        await this.setVal(`${prefix}.begin`, 'Unterrichtsbeginn', 'string', 'text', sum.begin);
        await this.setVal(`${prefix}.end`, 'Unterrichtsende', 'string', 'text', sum.end);
        await this.setVal(`${prefix}.hasCancellation`, 'Entfall vorhanden', 'boolean', 'indicator', sum.cancelled);
        await this.setVal(`${prefix}.hasChange`, 'Änderung vorhanden', 'boolean', 'indicator', sum.changed);

        await this.ensureObject(`${prefix}.lessons`, { type: 'folder', common: { name: 'Stunden' }, native: {} });
        for (let i = 0; i < lessons.length; i++) {
            const lp = `${prefix}.lessons.${String(i + 1).padStart(2, '0')}`;
            const l = lessons[i];
            await this.ensureObject(lp, { type: 'channel', common: { name: `${l.start} ${l.subject}` }, native: {} });
            for (const [f, n, t, r] of LESSON_FIELDS) {
                await this.setVal(`${lp}.${f}`, n, t, r, l[f]);
            }
        }
        await this.cleanupLessons(prefix, lessons.length);
    }

    /** Überzählige Stunden-Channels vom Vortag löschen */
    async cleanupLessons(prefix, count) {
        const objs = await this.getForeignObjectsAsync(`${this.namespace}.${prefix}.lessons.*`, 'channel');
        for (const fullId of Object.keys(objs || {})) {
            const m = fullId.match(/\.lessons\.(\d+)$/);
            if (m && parseInt(m[1], 10) > count) {
                const rel = fullId.substring(this.namespace.length + 1);
                await this.delObjectAsync(rel, { recursive: true });
                for (const id of [...this.createdObjects]) {
                    if (id === rel || id.startsWith(`${rel}.`)) this.createdObjects.delete(id);
                }
            }
        }
    }

    /** Aktuelle und nächste Stunde (für VIS/Alexa) */
    async updateCurrent() {
        const now = new Date();
        const today = isoDate(now);
        const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        for (const [key, data] of Object.entries(this.cache)) {
            const lessons = (data.today || []).filter(l => l.date === today && !l.cancelled);
            const cur = lessons.find(l => l.start <= hm && hm < l.end);
            const nxt = lessons.find(l => l.start > hm);
            const txt = l => (l ? `${l.subjectLong || l.subject}${l.room ? ` (${l.room})` : ''}` : '');
            await this.setVal(`${key}.today.currentLesson`, 'Aktuelle Stunde', 'string', 'text', txt(cur));
            await this.setVal(`${key}.today.nextLesson`, 'Nächste Stunde', 'string', 'text', txt(nxt));
            await this.setVal(`${key}.today.nextLessonStart`, 'Beginn nächste Stunde', 'string', 'text', nxt ? nxt.start : '');
            await this.setVal(`${key}.today.schoolOver`, 'Unterricht heute vorbei', 'boolean', 'indicator',
                lessons.length > 0 && hm >= lessons[lessons.length - 1].end);
        }
    }

    onStateChange(id, state) {
        if (state && !state.ack && id === `${this.namespace}.refresh`) {
            this.log.info('Manuelle Aktualisierung');
            this.update();
            this.setState('refresh', false, true);
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) this.clearTimeout(this.pollTimer);
            if (this.tickTimer) this.clearTimeout(this.tickTimer);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new WebuntisParents(options);
} else {
    new WebuntisParents();
}
