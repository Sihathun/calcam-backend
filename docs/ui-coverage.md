# UI coverage: screens to endpoints

This is the result of checking the backend spec against the 21 mock-ups (11 survey screens, 5 onboarding screens
and 5 main-app screens). Every screen is listed with the endpoint that serves it. Screens that are purely
client-side say so.

Paths are relative to `/api/v1`. "public" means no access token is needed.

## Onboarding funnel

| # | Screen (mock-up file) | What the client does | Endpoint |
|---|---|---|---|
| 1 | Welcome & splash | Shows the EN language switch. "Sign in" goes to login. | `GET /onboarding/options` (public, lists `locales`), `POST /auth/login`, `POST /auth/oauth/{apple,google}` |
| 2 | Survey 1: Choose your sex | Male / Female / Other | codes from `GET /onboarding/options` |
| 3 | Survey 2: Workouts per week | 0 - 2, 3 - 5, 6+ (each has a description line) | options include `description` |
| 4 | Survey 3: Referral source | 8 sources | options |
| 5 | Survey 5: Height (ft, in / cm) | Converts to cm | `heightCm` + `heightUnitPref` |
| 6 | Survey 6: Weight (lbs / kg, 0.1) | Converts to kg | `weightKg` (rounded to 0.1) + `weightUnitPref` |
| 7 | Survey 9: Date of birth | Month / day / year pickers | `birthDate` (`YYYY-MM-DD`) |
| 8 | Survey 7: Goal | Lose Weight / Maintain / Gain Weight | `goal` |
| 9 | Survey 4: Other calorie apps? | Yes / No | `triedOtherApps` |
| 10 | Survey 10: Trainer or dietitian? | Yes / No | `worksWithProfessional` |
| 11 | Survey 8: Diet | 10 diets | `diet` |
| 11a | Survey 11: What would you like to accomplish? | Single choice | `accomplishment` (stored only, never enters the formula) |
| 12 | Weight transition graph (3 / 7 / 30 days) | Draws the curve | `POST /onboarding/plan-preview` (public) -> `projection` |
| 13 | Cal AI vs traditional diet | Static chart | none (client only) |
| 14 | Commitment pledge (hold 2 s) | Shows "maintaining 45 kg" | `info.targetWeightKg` from plan-preview; `commitment.committedAt` in the payload |
| 15 | AI setup & BMR calculation (25%) | Animated checklist: Calories, Carbs, Protein, Fats, Health score | `POST /onboarding/plan-preview` (`plan.healthScoreEnabled`) |
| 16 | Daily recommendation plan | Pencil icons edit each value; "Your info" card | plan-preview (`plan`, `info`, `limits`); edits go in `acceptedGoal` |
| - | Sign-up (not in the mock-ups) | Email, Apple or Google, after the funnel | `POST /auth/register` with `onboarding`, or `POST /auth/oauth/*` with `onboarding`, in one call |

Back buttons and progress bars are client-side. The survey answers are only stored when the user signs up, so the
funnel needs no server session.

## Main app

| Screen (mock-up file) | Endpoint(s) |
|---|---|
| 2 - Daily dashboard (Today / Yesterday tabs, calories ring, protein / carbs / fat left, "Recently eaten") | `GET /dashboard/daily?date=today` and `?date=yesterday` |
| 3 - Scan viewfinder: **Scan Food** | `POST /meals/analyze` (multipart, `source=camera`) |
| 3 - Scan viewfinder: barcode | `POST /meals/barcode` (404 `PRODUCT_NOT_FOUND` -> fall back to manual) |
| 3 - Scan viewfinder: gallery image | `POST /meals/analyze` (`source=gallery`) |
| 3 - Scan viewfinder: 4th icon (crossed pencil) | `POST /meals` (manual values, or `description` for an AI text estimate). **Assumption, see below.** |
| 3 - Flash, help (?) | client only |
| 4 - "Analyzing food..." card, 8% ring, "We'll notify you when done!" | the meal is in `GET /dashboard/daily` with `status`, `progress`, a thumbnail; push on completion; device token via `POST /me/devices` |
| 5 - Nutrition detail: photo, time, name | `GET /meals/{id}` |
| 5 - quantity stepper (- 1 +) | `PATCH /meals/{id}` `{quantity}` (0.25 to 20; totals scale) |
| 5 - pencils on Calories / Carbs / Protein / Fat | `PATCH /meals/{id}` (per-serving values) |
| 5 - Health Score 7/10 | `healthScore` in `GET /meals/{id}` |
| 5 - Fix Results | `POST /meals/{id}/fix` |
| 5 - "..." menu | `DELETE /meals/{id}` (soft delete) |
| 5 - Done | client only (every edit is already saved) |
| Analytics tab (**not in the mock-ups**) | `GET /analytics/summary?range=7d\|30d\|90d` |
| Settings tab (**not in the mock-ups**) | `GET /me`, `PATCH /me/profile`, `PATCH /me/preferences`, `GET/PUT /me/goals`, `POST /me/goals/recalculate`, weight logs, `DELETE /me`, `POST /auth/logout` |

## What the check found

### Things the spec said that the screens confirm

- 21 mock-ups, and the numbers on the dashboard add up: 2199 - 460 = 1739, 161 - 25 = 136, 251 - 45 = 206,
  61 - 20 = 41. This is covered by a test (`tests/dashboard.test.ts`).
- "Analyzing food..." shows **2199 calories left**, the full goal. That confirms that meals still being analyzed are
  listed but not counted.
- The "88" / "87" in the corner of the screens is the phone's battery. The pledge screen shows a "88%" battery pill.

### Things the screens showed that the spec did not cover (added)

| Finding | What was done |
|---|---|
| Each workouts option has a second line ("Workouts now and then", "A few workouts per week", "Dedicated athlete") | `GET /onboarding/options` returns a `description` for workouts |
| Exact labels differ from the spec's short forms: "Tik Tok", "Lose Weight", "Gain Weight", "Whole-food focus" | Options return the labels as shown in the design, and a stable `code` |
| The welcome screen has a language switch | `locales` in options (from `SUPPORTED_LOCALES`), `PATCH /me/preferences` |
| The pencil edits on screen 16 happen **before** the user has an account | Plan-preview and options return `limits` so the client can validate while editing. The server clamps `acceptedGoal` again at sign-up |
| The pledge says "maintaining 45 kg", but a Maintain goal has no target weight | For Maintain, the target weight is the current weight (`info.targetWeightKg`, `profile.targetWeightKg`) |
| The thumbnail is visible while the meal is analyzing | A 320 px thumbnail is created at upload time, so the card has an image at once |
| "Fix Results" must not blank the screen | `reanalyzing: true` while the old values stay visible and keep counting. A failed fix keeps the old values and sets `errorCode` |
| Today / Yesterday are the only two tabs | `date=today` and `date=yesterday` are accepted next to `YYYY-MM-DD` |
| A failed analysis (not food, low confidence) leaves the user with nothing | The user can type in the four values with `PATCH /meals/{id}` and the meal becomes a normal, counted meal |

### Open points in the spec itself

These are not bugs in the backend. They are things to confirm with whoever owns the design.

1. **The projection curve.** The spec says progress is "delayed at first and accelerates after day 7", with points at
   10% (day 3), 35% (day 7) and 100% (day 30). Per day, days 3 to 7 gain 6.3 points a day and days 7 to 30 gain only
   2.8 a day. The curve only *looks* like it accelerates because the day labels are evenly spaced on the chart. I kept
   the constants as specified. They live in `src/config/plan.ts` if the design wants a real acceleration.
2. **The mock-up numbers are not from Mifflin-St Jeor.** The plan screen shows 1288 kcal for 45 kg, but the formula
   gives about 1,660 kcal for a 25-year-old woman of 167.6 cm at 45 kg with light activity. The spec already calls them
   placeholders. The weight screen shows 54.0 kg while the plan and pledge screens show 45 kg. This is a mock-up
   inconsistency, not a data flow.
3. **45 kg at 167 cm is BMI 16.** A "lose" plan for that person is refused (`422 GOAL_NOT_SUPPORTED`) as the spec
   requires. The mock-up shows Maintain, which works.
4. **The 4th scan icon.** The icon is a pencil with a slash. The spec's guess (manual or text entry) is implemented
   as `POST /meals`. If it is something else (for example "scan a nutrition label"), that is a new endpoint.
5. **Not designed yet:** sign-up, Analytics, Settings and any paywall. Those endpoints follow the spec's guesses.
   If a paywall exists, add a subscription module and gate `POST /meals/analyze`.
6. **Accomplishments** is single choice (radio buttons). If product wants several, change `accomplishment` to an array.
7. **Node.js version.** The spec says Node 20 LTS. Node 20 reached end of life in April 2026, so the Docker image uses
   Node 22 LTS. The code runs on Node 20.11 or later.
