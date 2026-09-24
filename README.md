![Logo](admin/webuntis-parents.png)

# ioBroker.webuntis-parents

Stundenplan aus **WebUntis** für ioBroker – funktioniert mit dem **Elternlogin** (alle Kinder werden automatisch erkannt) und mit dem Schülerlogin.

Der bekannte `webuntis`-Adapter liest nur den *eigenen* Stundenplan des angemeldeten Benutzers. Beim Elternlogin gibt es keinen eigenen Stundenplan, daher kommt dort nur `Cannot read Timetable for today`. Dieser Adapter fragt stattdessen gezielt den Stundenplan jedes Kindes ab – so wie die WebUntis-App.

## Installation

Admin → Adapter → Expertenmodus aktivieren → „Installieren aus eigener URL“ (GitHub-Symbol) →
`https://github.com/timothefimo/ioBroker.webuntis-parents`

## Konfiguration

| Feld | Beschreibung |
|---|---|
| Server | z. B. `xyz.webuntis.com` – aus der Adresszeile von WebUntis |
| Schule | der Wert hinter `?school=` in der Adresszeile |
| Benutzername / Passwort | Eltern- oder Schülerlogin (kein SSO/Office365/IServ) |
| Abfrageintervall | Minuten, mindestens 10 (Standard 30) |
| Schüler-IDs | optional; leer = alle Kinder automatisch |
| formatId | Standard 1; falls der Stundenplan leer bleibt, 2 probieren |

## Datenpunkte

Pro Kind wird ein Gerät `webuntis-parents.0.<name>` angelegt:

```
<name>.id / .name
<name>.today.*          Heute
<name>.next.*           Nächster Schultag (am Freitag also Montag)
    .date               Datum (YYYY-MM-DD)
    .json               alle Stunden als JSON (ideal für Dashboards)
    .lessonCount        Anzahl Stunden ohne Entfall
    .begin / .end       erster Beginn / letztes Ende
    .hasCancellation    mindestens eine Stunde entfällt
    .hasChange          irgendeine Änderung (Vertretung, Raum, Entfall …)
    .lessons.01 … NN    einzelne Stunden: start, end, subject, subjectLong,
                        teacher, teacherOrg, room, roomOrg, state,
                        cancelled, changed, info
<name>.today.currentLesson     aktuelle Stunde, z. B. "Mathematik (R101)"
<name>.today.nextLesson        nächste Stunde
<name>.today.nextLessonStart   Beginn der nächsten Stunde
<name>.today.schoolOver        Unterricht für heute vorbei
```

`state` kann u. a. sein: `STANDARD`, `CANCEL`, `SUBSTITUTION`, `ROOMSUBSTITUTION`, `ADDITIONAL`, `SHIFT`, `EXAM`.

`webuntis-parents.0.refresh` (Button) stößt sofort eine Aktualisierung an.
`info.connection` und `info.lastUpdate` zeigen den Verbindungsstatus.

## Hinweise

- Der Adapter nutzt die (inoffiziellen) Web-Schnittstellen, die auch die WebUntis-Oberfläche verwendet. Ändert Untis diese, muss der Adapter angepasst werden.
- Welche Daten sichtbar sind, legt die Schule über die Benutzerrechte fest.
- Für Fehlersuche Loglevel der Instanz auf `debug` stellen.

## Changelog

### 0.1.0 (2026-09-24)
- Erste Version

## License

MIT License – Copyright (c) 2026 timothefimo
