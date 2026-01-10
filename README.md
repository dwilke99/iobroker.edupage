![Logo](admin/edupage.png)
# ioBroker.edupage

[![NPM version](https://img.shields.io/npm/v/iobroker.edupage.svg)](https://www.npmjs.com/package/iobroker.edupage)
[![Downloads](https://img.shields.io/npm/dm/iobroker.edupage.svg)](https://www.npmjs.com/package/iobroker.edupage)
![Number of Installations](https://iobroker.live/badges/edupage-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/edupage-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.edupage.png?downloads=true)](https://nodei.co/npm/iobroker.edupage/)

**Tests:** ![Test and Release](https://github.com/dwilke99/ioBroker.edupage/workflows/Test%20and%20Release/badge.svg)

## ioBroker.edupage

Adapter für die Integration von Edupage (Hausaufgaben, Stundenplan, Mensa).

Dieser Adapter ermöglicht es, Daten von Edupage in ioBroker zu integrieren. Er holt automatisch Hausaufgaben, Mitteilungen, Stundenpläne und Mensa-Menüs und stellt diese als JSON-Datenpunkte zur Verfügung.

## Installation

### Installation über GitHub (Experten-Modus)

1. Öffnen Sie die ioBroker Admin-Oberfläche
2. Navigieren Sie zu **Adapter**
3. Klicken Sie auf das **Katze**-Symbol (Experten-Modus)
4. Wählen Sie **Beliebig** aus
5. Geben Sie die GitHub-URL ein: `https://github.com/dwilke99/ioBroker.edupage`
6. Klicken Sie auf **Installieren**

### Wichtiger Hinweis zu Abhängigkeiten

Falls die Installation der Abhängigkeiten fehlschlägt, führen Sie bitte manuell folgenden Befehl aus:

```bash
cd /opt/iobroker/node_modules/iobroker.edupage
npm install edupage-api
```

Starten Sie anschließend den Adapter neu.

## Konfiguration

Nach der Installation können Sie den Adapter in den ioBroker-Einstellungen konfigurieren:

### Erforderliche Einstellungen

- **School Subdomain**: Die Subdomain Ihrer Schule (z.B. `gtheissen` für `gtheissen.edupage.org`)
- **Username**: Ihr Edupage-Benutzername
- **Password**: Ihr Edupage-Passwort
- **Polling Interval**: Abfrageintervall in Minuten (Standard: 30 Minuten)

### Optionale Einstellungen

- **Student Name**: Name des Kindes (Exakt wie in Edupage)
  - Leer lassen, um alle zu laden
  - Bei Fehlern siehe Protokoll für verfügbare Namen
  - Wichtig für Eltern-Accounts mit mehreren Kindern

## Funktionen und Datenpunkte

### Hausaufgaben (`data.homework`)

- **`data.homework.pending_json`**: Liste aller offenen Hausaufgaben (JSON)
- **`data.homework.completed_json`**: Liste aller erledigten Hausaufgaben (JSON)
- **`data.homework_count`**: Gesamtanzahl der Hausaufgaben (Zahl)

Jede Hausaufgabe enthält:
- `id`: Eindeutige ID
- `subject`: Fach
- `title`: Titel
- `description`: Beschreibung
- `dueDate`: Abgabedatum
- `assignedDate`: Zuweisungsdatum
- `isDone`: Status (true/false)
- `teacher`: Lehrer/in

### Stundenplan (`data.classes`)

- **`data.classes.today_json`**: Stundenplan für heute (JSON)
- **`data.classes.tomorrow_json`**: Stundenplan für den nächsten Schultag (JSON)

Jede Unterrichtsstunde enthält:
- `period`: Stundennummer (z.B. "1", "2")
- `startTime`: Startzeit (z.B. "08:00")
- `endTime`: Endzeit (z.B. "08:45")
- `subject`: Fach
- `teacher`: Lehrer/in
- `topic`: Unterrichtsthema / Was wurde gemacht
- `classroom`: Raum
- `date`: Datum (YYYY-MM-DD)

### Mensa (`data.canteen`)

- **`data.canteen.today_json`**: Menü für heute (JSON)
- **`data.canteen.tomorrow_json`**: Menü für den nächsten Schultag (JSON)
- **`data.canteen.tomorrow_text`**: Hauptgericht für den nächsten Schultag (Text)
- **`data.canteen.week_json`**: Menü für die gesamte Woche (Montag bis Freitag, JSON)

Die Wochenübersicht enthält für jeden Tag:
- `date`: Datum (YYYY-MM-DD)
- `day`: Wochentag (Montag, Dienstag, etc.)
- `menu`: Hauptgericht
- `menuData`: Vollständige Menüdaten

### Mitteilungen (`data.notifications`)

- **`data.notifications.today_json`**: Mitteilungen von heute (JSON)
- **`data.notifications.all_json`**: Alle Mitteilungen (JSON)
- **`data.notifications_count`**: Anzahl der Mitteilungen (Zahl)

### Informationen (`info`)

- **`info.connection`**: Verbindungsstatus (true/false)
- **`info.student_name`**: Name des Schülers/der Schülerin
- **`info.teachers_json`**: Liste aller Lehrer (JSON)
- **`info.classes_json`**: Liste aller Fächer/Klassen (JSON)

## Visualisierung

Der Adapter stellt alle Daten als JSON-Datenpunkte zur Verfügung, die ideal für die Verwendung mit HTML-Widgets in VIS (Visualisierung) geeignet sind.

### Beispiel-Verwendung in VIS

Sie können die JSON-Datenpunkte direkt in HTML-Widgets verwenden:

```javascript
// Beispiel: Hausaufgaben anzeigen
let homeworks = JSON.parse(getState('edupage.0.data.homework.pending_json').val);
homeworks.forEach(hw => {
    console.log(`${hw.subject}: ${hw.title} - Fällig: ${hw.dueDate}`);
});
```

```javascript
// Beispiel: Stundenplan für heute
let lessons = JSON.parse(getState('edupage.0.data.classes.today_json').val);
lessons.forEach(lesson => {
    console.log(`${lesson.startTime}-${lesson.endTime}: ${lesson.subject} - ${lesson.topic}`);
});
```

```javascript
// Beispiel: Mensa-Menü für die Woche
let weekMenu = JSON.parse(getState('edupage.0.data.canteen.week_json').val);
weekMenu.forEach(day => {
    console.log(`${day.day} (${day.date}): ${day.menu}`);
});
```

## Besonderheiten

### Wochenend-Logik

Der Adapter erkennt automatisch Wochenenden und zeigt für "morgen" die Daten des nächsten Schultags an:
- Freitag → Montag
- Samstag → Montag
- Sonntag → Montag

### Eltern-Accounts

Bei Eltern-Accounts mit mehreren Kindern:
1. Starten Sie den Adapter einmal ohne "Student Name"
2. Prüfen Sie das Protokoll - alle verfügbaren Kinder werden geloggt
3. Kopieren Sie den exakten Namen aus dem Protokoll
4. Tragen Sie diesen in "Student Name" ein
5. Starten Sie den Adapter neu

Der Adapter filtert dann automatisch alle Daten für das ausgewählte Kind.

## Changelog

### 0.0.1 (2026-01-10)
* (dupan99) Erstveröffentlichung mit Hausaufgaben, Stundenplan und Mensa-Support

## Lizenz

MIT License

Copyright (c) 2026 dupan99 <dupan99@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
