# VolunteerHub

A static volunteer management site (HTML, CSS, vanilla JS). No backend, no build step.

## Features
- Dashboard with totals and upcoming events
- Volunteers: search by name/phone, status filter, add/edit/delete (with confirmation), copy phone, `tel:` call link
- Class routines: multiple classes per volunteer, screenshot upload (max 400 KB), verification status (Verified / Pending / Rejected)
- Availability Finder: date, time range, buffer, needed count. Results: Fully, Partially, Unavailable, Routine pending or missing. Uses `start < classEnd && end > classStart` on half-open intervals, with weekly recurring classes. Only verified routines count as available.
- Events: add/edit/delete, assign volunteers, warnings for class conflicts and overlapping events, explicit override
- Settings: JSON export/import, volunteers CSV export, Google Form CSV import with preview, validation, duplicate detection and summary, reset demo data

## Sample data
The 18 volunteers come from your Google Form CSV (the repeated phone 01858092057 was merged). Screenshots are in `assets/screenshots/` and linked to each volunteer. Routines start as **Pending** and have no classes: read each screenshot, enter the classes, then set the status to Verified.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder and visit http://localhost:8000.

## Upload to GitHub
1. Create a new repository on github.com (e.g. `volunteerhub`).
2. Click **Add file → Upload files**, drag in everything in this folder (keep the `assets` folder), then **Commit changes**.
   Or with git: `git init && git add . && git commit -m "VolunteerHub" && git branch -M main && git remote add origin https://github.com/YOU/volunteerhub.git && git push -u origin main`

## Enable GitHub Pages
Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main, folder /(root) → Save**. After a minute the site is at `https://YOU.github.io/volunteerhub/`. All paths are relative, so the subpath works.

## Known limitations
- Data lives in this browser's localStorage. It is **not synced** across devices or browsers. Use JSON export/import to move it.
- The site is public on GitHub Pages, and the repository contains the volunteers' phone numbers, addresses and screenshots. Use a **private repository** (GitHub Pro/Team) or remove real data before publishing.
- Google Sheets is not connected; import via CSV only. Google Drive links need the viewer's Drive access.
- Screenshot uploads are limited to 400 KB each. Opening CSV exports in Excel may drop leading zeros of phone numbers.
- No login: anyone with the link can edit their own browser copy.

## Online database (Supabase)
Data now lives in Supabase (shared across devices) and requires admin login. See **SETUP.md** and `schema.sql`. localStorage is no longer used for saving. It is read only by the one-time "Migrate data from this browser" button.
