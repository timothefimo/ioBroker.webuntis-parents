'use strict';

const axios = require('axios');

const pad = n => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' (lokale Zeit) */
function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 20260924 -> '2026-09-24' */
function fmtUntisDate(n) {
    const s = String(n);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
/** 745 -> '07:45' */
function fmtUntisTime(n) {
    const s = String(n).padStart(4, '0');
    return `${s.slice(0, 2)}:${s.slice(2)}`;
}
/** Name -> ioBroker-taugliche ID */
function slug(s) {
    return String(s).toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'student';
}

/**
 * Wandelt die Antwort von /api/public/timetable/weekly/data in eine Stundenliste um.
 * @param {object} data  result.data aus der WebUntis-Antwort
 * @param {number} studentId
 */
function parseWeek(data, studentId) {
    if (!data) return [];
    const el = {};
    (data.elements || []).forEach(e => { el[`${e.type}_${e.id}`] = e; });

    const names = (p, type, long) => (p.elements || []).filter(e => e.type === type).map(e => {
        const x = el[`${type}_${e.id}`];
        return x ? (long ? (x.longName || x.name) : x.name) : '';
    }).filter(Boolean).join(', ');
    const orgNames = (p, type) => (p.elements || [])
        .filter(e => e.type === type && e.orgId && e.orgId !== e.id)
        .map(e => (el[`${type}_${e.orgId}`] || {}).name).filter(Boolean).join(', ');

    const periods = (data.elementPeriods && data.elementPeriods[studentId]) || [];
    return periods.map(p => ({
        date: fmtUntisDate(p.date),
        start: fmtUntisTime(p.startTime),
        end: fmtUntisTime(p.endTime),
        subject: names(p, 3),
        subjectLong: names(p, 3, true),
        teacher: names(p, 2),
        teacherOrg: orgNames(p, 2),
        room: names(p, 4),
        roomOrg: orgNames(p, 4),
        klasse: names(p, 1),
        state: p.cellState || 'STANDARD',
        cancelled: p.cellState === 'CANCEL',
        changed: !!p.cellState && p.cellState !== 'STANDARD',
        info: [p.lessonText, p.substText, p.periodText].filter(Boolean).join(' | '),
    }));
}

/** Duplikate entfernen und nach Datum/Zeit sortieren */
function normalize(lessons) {
    const seen = new Set();
    return lessons
        .filter(l => {
            const k = `${l.date}|${l.start}|${l.subject}|${l.state}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/** Kennzahlen für einen Tag */
function summarize(lessons) {
    const active = lessons.filter(l => !l.cancelled);
    return {
        count: active.length,
        begin: active.length ? active[0].start : '',
        end: active.length ? active[active.length - 1].end : '',
        cancelled: lessons.some(l => l.cancelled),
        changed: lessons.some(l => l.changed),
    };
}

/** Heute + nächster Schultag aus einer Stundenliste */
function splitDays(lessons, today) {
    const heute = lessons.filter(l => l.date === today);
    const nextDate = (lessons.find(l => l.date > today) || {}).date || '';
    const next = nextDate ? lessons.filter(l => l.date === nextDate) : [];
    return { today: heute, nextDate, next };
}

class UntisClient {
    /**
     * @param {{server:string, school:string, username:string, password:string, formatId?:number, timeout?:number}} cfg
     */
    constructor(cfg) {
        const host = String(cfg.server).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        this.base = `https://${host}/WebUntis`;
        this.cfg = cfg;
        this.cookie = null;
        this.auth = null;
        this.session = null;
        this.http = axios.create({
            timeout: cfg.timeout || 20000,
            headers: { 'User-Agent': 'ioBroker.webuntis-parents', 'Accept': 'application/json' },
        });
    }

    async login() {
        const res = await this.http.post(`${this.base}/jsonrpc.do`, {
            id: 'iobroker', method: 'authenticate', jsonrpc: '2.0',
            params: { user: this.cfg.username, password: this.cfg.password, client: 'iobroker' },
        }, { params: { school: this.cfg.school } });

        if (res.data && res.data.error) {
            throw new Error(`Login fehlgeschlagen: ${res.data.error.message} (${res.data.error.code})`);
        }
        if (!res.data || !res.data.result || !res.data.result.sessionId) {
            throw new Error('Login fehlgeschlagen: keine Session erhalten');
        }
        this.session = res.data.result;
        const schoolCookie = `"_${Buffer.from(this.cfg.school).toString('base64')}"`;
        this.cookie = `JSESSIONID=${this.session.sessionId}; schoolname=${schoolCookie}`;

        const tok = await this.http.get(`${this.base}/api/token/new`, {
            headers: { Cookie: this.cookie }, responseType: 'text',
        });
        this.auth = { Cookie: this.cookie, Authorization: `Bearer ${String(tok.data).trim()}` };
        return this.session;
    }

    /** Liefert [{id, name}] – Kinder beim Elternlogin, sonst den Schüler selbst */
    async getStudents() {
        let students = [];
        try {
            const res = await this.http.get(`${this.base}/api/rest/view/v1/app/data`, { headers: this.auth });
            const user = res.data && res.data.user;
            students = ((user && user.students) || []).map(s => ({
                id: s.id,
                name: s.displayName || [s.firstName, s.lastName].filter(Boolean).join(' ') || `student_${s.id}`,
            }));
        } catch (e) {
            // ignorieren -> Fallback
        }
        if (!students.length && this.session && this.session.personType === 5) {
            students = [{ id: this.session.personId, name: this.cfg.username }];
        }
        return students;
    }

    /** Stunden der Woche, in der isoDay liegt */
    async getWeek(studentId, isoDay) {
        const res = await this.http.get(`${this.base}/api/public/timetable/weekly/data`, {
            params: { elementType: 5, elementId: studentId, date: isoDay, formatId: this.cfg.formatId || 1 },
            headers: this.auth,
        });
        const data = res.data && res.data.data && res.data.data.result && res.data.data.result.data;
        if (!data) {
            const err = new Error('Unerwartete Antwort beim Stundenplan');
            err.raw = res.data;
            throw err;
        }
        return parseWeek(data, studentId);
    }

    async logout() {
        if (!this.cookie) return;
        try {
            await this.http.post(`${this.base}/jsonrpc.do`,
                { id: 'iobroker', method: 'logout', params: {}, jsonrpc: '2.0' },
                { params: { school: this.cfg.school }, headers: { Cookie: this.cookie } });
        } catch (e) {
            // egal
        }
        this.cookie = null;
        this.auth = null;
    }
}

module.exports = { UntisClient, parseWeek, normalize, summarize, splitDays, isoDate, slug, fmtUntisDate, fmtUntisTime };
