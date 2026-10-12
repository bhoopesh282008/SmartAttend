# SmartAttend

Attendance by a QR code that expires in 60 seconds, with checks that stop a friend marking you present.

Built for Problem Statement 1 (*Smart Attendance via QR*): faculty generate a QR code per lecture that expires in 60 seconds; students scan it to mark attendance. **Everything shown is demo data**: the class, names, roll numbers, past lectures and the data the models were trained on are all invented, and the interface says so.

**Status:** the whole brief works (Tier 1), two models sit on top (Tier 2: a proxy-marking risk model and an at-risk attendance predictor), and an optional on-device face check, with an optional head-turn prompt, feeds the first of them (Tier 3). Location can be set from the device, typed in, or snapped to the real building outline, and a student whose camera will not work can type six digits instead.

## Run it

Needs Node 24 or newer (SQLite is built in; there is no database to install).

```bash
npm install
npm run dev        # server :3001, web app http://localhost:5180, model service :8001
npm test           # 119 server tests + 20 web tests
npm run build      # production build of the web app (the server can serve it)
npm run e2e        # 12 tests in a real Chrome (see "Tested in a real browser" below)
```

On first start the server loads the demo class. **Reset demo** (faculty header) puts it back.

### Risk models (optional, but this is the AI part)

The models are Python (scikit-learn behind FastAPI). They are already trained and saved in `ml/models/`, so you only need the environment:

```bash
py -3.13 -m venv ml/.venv                              # Python 3.13; macOS/Linux: python3.13 -m venv ml/.venv
ml/.venv/Scripts/python -m pip install -r ml/requirements.txt   # macOS/Linux: ml/.venv/bin/python
npm run dev                                            # now starts the model service too
npm run test:ml                                        # 32 Python tests
npm run train                                          # optional: retrain both models (about 30 s, same seeds, same result)
```

Without that environment everything still works: scans are checked by the rules alone, the lecture page says **"Risk model offline"**, and the early-warning list falls back to a rules-only list and says so.

**Trying it with two people.** Sign in as a faculty member in one browser and a student in another. Two students in the *same* browser share one device ID, so the second is blocked: that is the proxy defence working, not a bug. Use separate browsers, profiles or private windows for separate students.

**Trying it with a phone.** A phone only allows the camera and GPS on https. Run `npm run dev:https`, open the faculty page using your computer's Wi-Fi address (not `localhost`), and accept the browser's one-time certificate warning. Pick that address in "Students open this address" on the lecture page. If the venue's Wi-Fi blocks devices from reaching each other, use your laptop's own hotspot.

## How each line of the brief is met

| Brief | How |
|---|---|
| QR code **per lecture** | One *session* is one lecture (course, lecture number, title, date). Faculty press **Generate QR** inside it. |
| **expires in 60 seconds** | The code carries its issue time inside an HMAC-signed token and is valid for exactly 60 s from generation, plus 2 s network grace, judged on the **server's clock** (a wrong phone clock does not matter). Auto-renew shows the next code as the old one runs out; with it off the QR shows *Expired*. |
| students **scan** to mark | In-app camera scanner, or the phone's own camera app (the QR holds a link to `/s/<token>`). Paste-the-link fallback. **No camera? Type the six digits shown under the QR** (see "Rules worth knowing"). |
| **attendance list per class** | Per lecture: every enrolled student, present or absent, live. Per course: a class register (students x lectures) with percentages. |
| **block proxy marking: device ID** | A device that already marked another student in the same lecture is rejected and logged. |
| **block proxy marking: location** | A scan with a good GPS fix that is clearly outside the room is rejected. Vague, borderline or missing location is held for faculty review instead, so honest students are not rejected for indoor GPS drift. |
| **export to CSV** | Per lecture and per course register. UTF-8 with a byte-order mark (Devanagari names open correctly in Excel); cells starting `= + - @` are neutralised so a name cannot run as a spreadsheet formula. |

Also built: faculty review queue (approve / decline with reasons shown), mark-by-hand with a required reason, one open lecture per course, "classes you can still miss" for students (plain arithmetic: attended + remaining - ceil(0.75 x planned)).

## The AI layer

**The model reviews; it never punishes.** Only deterministic rules reject a scan (expired or forged code, repeat scan, a phone that already marked someone else, a clearly-wrong position). The model scores every accepted scan and sends doubtful ones to the faculty review queue **with the reasons**. Reasons are shown to faculty only, never to the student.

### 1. Proxy-marking risk model (`ml/train_proxy.py`)

Logistic regression on nine signals (code age, distance beyond GPS error, GPS accuracy, location not shared, phone used by other students, new phone, scan burst on the same network, face distance, no face check). It ships because its score is a sum, so each flag can be explained in words ("First time this student has used this device", "Scanned 52 s into the code's 60 s life"). Random forest and gradient boosting are trained alongside as benchmarks.

| Test split (15,000 synthetic scans) | Honest scans sent to review | Proxy scans caught | ROC-AUC |
|---|---|---|---|
| **Logistic regression (ships), 3% review cap** | 3.0% | 60% | 0.904 |
| Random forest / gradient boosting | 2.8% / 3.0% | 69% / 72% | 0.952 / 0.958 |
| The rules alone | 15.1% | 73% | |
| The model given the rules' review budget | 15.1% | 82% | |
| **Rules and model together (what the server does)** | **16.1%** | **79%** | |

What this says, plainly: the readable model costs about 12 points of recall against gradient boosting; the rules alone send five times as many honest scans to review as the model's own cap; and because the rules and model both run, the real false-review rate is **16%, not 3%**. A model that replaced the rules' soft reviews would catch more (82% at the same budget) but would lose the "location not shared means a person looks" guarantee; that trade is left as a decision. It also does worst where you would expect: a friend in the room on a second phone is caught 59% of the time, honest students with a new or shared phone are reviewed more often (15% and 34%), and **timing is a weak signal** because honest students scan at any moment while a code is on screen.

### 2. At-risk attendance predictor (`ml/train_atrisk.py`)

Predicts, from the lectures held so far, who will finish below 75% of the planned lectures. Features use only lectures already held; the label comes from the full term; splits are by student, so nobody is in two sets. It is compared with two plain methods and scored separately on students who can still reach 75%, because part of the signal is arithmetic.

| Test split (4,000 synthetic students, 31% finish below 75%) | ROC-AUC |
|---|---|
| **Logistic regression (ships)** | **0.898** |
| Rule: attendance so far below 75% | 0.880 |
| Arithmetic: classes still missable | 0.851 |
| Gradient boosting | 0.877 |

The gain over the simple rule is **modest** (+0.018). Of students the model puts in the "high" band, 84% finished below 75%; "watch" 49%; "low" 11%. Of the 15% ranked highest, 93% finished below 75%. Estimates are weaker early in the term (ROC-AUC 0.85 under 30% of the way through, 0.94 after 45%).

### 3. Face check (optional, per lecture)

A lecturer can switch on **"Ask students for a face check"** when starting a lecture. Students enrol once on the **Face check** page: three photos, a consent step, and a delete button. Then, at scan time, the phone asks for one more photo.

- **No photo is kept or sent.** The browser (`@vladmandic/face-api`, models served from `web/public/models/face`, no CDN) turns each photo into 128 numbers and sends only those. A student's template is the average of three, **encrypted at rest** (AES-256-GCM, bound to the student, key in `server/data/face.key` or `FACE_KEY`, kept apart from the database file). A scan's numbers are compared with the template and discarded; only the distance is stored.
- **It is a signal, never a gate.** A poor match (distance 0.6 or more), or no face check at all, sends the scan to the review queue with the reason; it never rejects anyone. The distance also goes to the risk model (the same `face_distance` feature the synthetic data already included).
- **Quality guards in the browser:** it refuses a picture with no face, several faces, a too-small face, or an unclear one, and says which. The networks are warmed up while the camera starts: the first read took 9.6 s on one machine before that and about 150 ms after.
- **A real measurement, small.** Nine faces cropped from the library's own demo photos: different people were a median 0.74 apart (range 0.56 to 0.89; 1 pair of 36 under the 0.6 line, a 2.8% false-match rate on that sample), and re-framed, re-lit variants of one face were 0.18 to 0.29 apart. That fits the synthetic assumption for different people (0.78) and is lower than real photos of one person would be (the variants are the same photo, so they are easy). Re-measure with real enrolments.
- **Optional head turn.** A lecture can also say **"Also ask them to turn their head"**. The phone then asks the student to look at the camera, turn left or right (chosen at random), and come back, and only then takes the photo that is compared. The turn is measured as a *change from that person's own starting position* (people do not look "straight ahead" at the same angle: a real webcam read +0.07 for a person looking at it), by where the nose sits between the two sides of the jaw in the 68 face landmarks. A photograph held up to the camera never changes, so it fails with "did not look like a head turn", nothing is marked, and the student can skip the face check, which sends the scan to review with the reason `face_missing`.
- **That is a deterrent, not proof.** The turn is judged **in the student's browser**; the server only sees the descriptor that follows, so it cannot verify that a turn happened, and a video of the person turning would pass. It stops the lazy case (a photo of a friend), not a determined one.

### The data is synthetic, and the app says so

No public log of QR-attendance scans with known proxy marking exists, and this project has not been deployed. Both models are trained and tested on **synthetic** data generated from written-down assumptions (`ml/synth_scans.py`, `ml/synth_terms.py`; shown on the **Models** page in the app). The numbers describe how the *method* behaves in an invented world, not how accurately it would catch real proxy marking. The generator includes hard negatives (honest students with poor GPS, honest lecture-start bursts on shared Wi-Fi, a phone really shared by flatmates) so the model cannot learn "far from the room means cheating". Training, validation and test sets come from separate seeds, the alert threshold is chosen on validation data only, and every reported number can be recomputed from the saved model (a test does it).

### Engineering

- **One feature function** (`ml/features.py`) is used by training and by the web service; a test checks the service's score equals scoring the training matrix.
- **Missing is not zero.** An unshared location, a lecture with the location check off, and a skipped face check are three different inputs, each with its own flag; none is read as distance 0 or a perfect match.
- **Reproducible.** Fixed seeds, saved models and metrics in `ml/models/`, a model version that is a hash of the coefficients.
- **Resilient.** The model service is stateless and optional, called with a 1.5 s timeout; if it fails the scan is decided by the rules and stored as `scored_by = rules`.

## Rules worth knowing

- **Reasons are for faculty only.** A student whose scan is held for review is told it is waiting for confirmation, not why.
- **Location uses accuracy.** The reported GPS error is subtracted from the distance, so a vague fix cannot make an honest student look far away. Over 100 m of error, a fix is not used to judge distance at all. A scan is rejected for location only on a good fix that is clearly far away (further than twice the allowed radius, after the error is taken off); anything vaguer goes to review.
- **Three ways to set the classroom.** (1) *Use this device's position*; the reported accuracy is saved with it and a fix worse than 200 m is refused with advice (a laptop that locates itself from Wi-Fi can be off by hundreds of metres). (2) *Type coordinates* (decimal degrees, or with N/S/E/W letters; degrees-minutes-seconds and ambiguous input are refused rather than guessed), for machines with no location source: this PC has none, which is why this exists. (3) *Add the building outline*: the lecturer's room is looked up in OpenStreetMap (Overpass; a closed building way within 40 m), and students are then measured against the walls rather than a circle around one point (the default radius drops from 150 m to 50 m). If the lookup fails, the circle is kept and the lecturer is told.
- **Six-digit code.** Each QR also shows a six-digit code that stays valid for the same 60 seconds. It is only accepted for an open lecture in a course the student is enrolled in, and wrong codes are rate-limited (eight a minute per student, then "wait"), so it cannot be guessed. It goes through exactly the same checks as a scan; it is not a lower-trust door.
- **Lectures close themselves** after two hours by default (the lecturer can pick 5 minutes to 24 hours, or never), so a forgotten lecture does not stay open all night. A scan made more than 10 minutes after the lecture started is flagged **Late** on the register and in the CSV (it is still present).
- **Only distance and accuracy are stored**, not raw coordinates.
- **A new phone is judged against the student's own history.** A first-ever scan has no baseline, so nobody is flagged for starting to use the system.

## Limits (stated plainly)

- **Demo sign-in has no passwords.** A real deployment needs the college's own sign-in (SSO or OTP).
- **The models have never seen real data.** See above. Before relying on a flag, run the model in shadow mode (score, do not flag) for a few weeks and compare it with the lecturer's judgement.
- **"Device ID" is not a hardware ID.** A web page cannot read a phone's IMEI or MAC address. It is a random ID kept in the browser; clearing site data resets it. It shows a phone was reused; it does not prove who is holding it.
- **GPS can be spoofed** with a mock-location app, and a web page cannot reliably detect that. It also cannot tell floors apart in a multi-storey building.
- **A QR code shown on a screen can be photographed and relayed** within its 60 seconds. Device, location and risk checks exist for exactly that gap; none is perfect.
- **Tried on a laptop webcam, not on a phone.** See "Tested in a real browser" below for exactly what was and was not run. Nothing here has run on a real phone, over https from another device, or with real GPS (the development PC has no location source at all, so every location test used a position the test supplied).
- **The face check's liveness is client-side only** (see above), and its error rates on real people, lighting, glasses or masks are unknown beyond one person's webcam. An honest student can mismatch (the result is a review, not a rejection); without the head-turn option, a photograph can match, and with it a video can.
- **The building outline depends on OpenStreetMap.** A building that is not mapped, or is mapped as a relation (a courtyard building), is not found and the circle is used; a wrong outline would be wrong for everyone, so faculty can remove it with one button.
- **Face data is biometric data.** Enrolment asks for consent and can be deleted at any time, and a demo reset wipes it, but a real deployment needs a retention policy, a legal basis, and the key kept somewhere safer than a file next to the database.

## Tested in a real browser

`npm run e2e` starts the whole stack on a throwaway database and drives a real Chrome (via `playwright-core`, with a fresh temporary profile) through 12 end-to-end tests. The camera is Chrome's own fake capture device playing a video file, so the page's real `getUserMedia` code path runs; only the pictures are supplied by the test.

| Area | What a real Chrome checked |
|---|---|
| QR | The in-app scanner decodes the QR shown on screen from a camera stream and marks the student present; a QR from somewhere else does nothing; the paste-a-link fallback works |
| Six digits | Typed with no camera: present. Wrong codes get a plain message; after about eight wrong guesses the student is told to wait |
| Face | Enrolling through the real camera UI; the same person goes straight through, a different face is held for review |
| Head turn | A turn and return passes (8 of 8 repeats, random direction; the photo compared is the one taken *after* the turn); a still photo fails and nothing is recorded; skipping goes to review |
| Location | The room set from the browser's position (a vague fix refused with advice); coordinates typed; the building outline fetched (from a local stand-in for Overpass) and students checked against the walls: inside is 0 m, too far is rejected, vague or denied goes to review |

`npm run e2e:camera` is the one test that needs a person and a real webcam; it was run once with the developer in front of an HP Wide Vision HD camera (640x480): the face was found 23 times in 12 seconds, enrolled, and five later scans of the same person were 0.24, 0.30, 0.39, 0.46 and 0.46 from the template (all under the 0.6 line, all marked present). The real-webcam run also showed that a person's "straight ahead" is not zero turn, which is why the head turn is measured from each person's own starting reading.

**Not covered:** reading a QR with a real webcam (nothing in front of it displayed one), real GPS, a real phone, https from another device, and a real person performing the head turn on camera (the turn was tested with a stream of a turned face, and the signal with a person's real head moving, but not both together).

## Try this in a demo (3 to 4 minutes)

1. **Faculty:** start a lecture; the QR appears with a countdown. 2. **Student A** scans: present, live in the list. 3. **Student B on the same browser** (same phone): rejected, shown as a blocked attempt. 4. **Set the classroom position** from the faculty page ("Use this device's position") and start a location-checked lecture: a scan from far away is rejected, a borderline one lands in the **review queue with reasons and a model score**. 5. Open **Courses, Class register**: the early-warning list with reasons, and "classes you can still miss". 6. **Models** page: the numbers and the limits. 7. **Face check:** as a student, enrol on the Face check page; as faculty, start a lecture with "Ask students for a face check"; scan, take the photo, and see a match go straight through while a different face lands in review with its distance. 8. Stop the model service and show **"Risk model offline"**: scans keep working on rules.

## Attributions

- Face descriptors: [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) (MIT), built on the models of [face-api.js](https://github.com/justadudewhohacks/face-api.js) (MIT). Three model files (about 7 MB) are copied into `web/public/models/face`; their licence text is alongside them.
- QR codes: `qrcode` and `jsqr`. Everything else is standard Node, React and scikit-learn.
- Building outlines: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), fetched on request through the Overpass API; only the outline of the one building is stored, with a note saying where it came from.
- Browser tests: `playwright-core` (development only). The faces used in them are cropped at test time from the demo photos shipped inside `@vladmandic/face-api`; no one's picture is committed here.

## Layout

```
server/    Node + Express + node:sqlite: tokens, scan rules, exports, model client   (npm test)
web/       React + Vite + Tailwind: faculty and student screens, the Models page
ml/        Python + FastAPI + scikit-learn: synthetic data, training, the model service  (npm run test:ml)
e2e/       Real-Chrome tests and the harness that starts the stack          (npm run e2e)
scripts/   py.mjs: runs the project's Python on any OS
```
