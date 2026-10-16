# Supabase setup (beginner guide)

Supabase is a free online database. You only click and paste; no coding.

## Step 1: Create an account
1. Go to https://supabase.com and click **Start your project**.
2. Sign up with GitHub or email and confirm your email.

## Step 2: Create a project
1. Click **New project**. Name it `volunteerhub`.
2. **Database Password**: click Generate, and save it in a password manager (you will rarely need it).
3. Pick the **Region** nearest to you (e.g. Singapore). Click **Create new project** and wait 1-2 minutes.

## Step 3: Create the tables
1. Left menu: **SQL Editor** > **New query**.
2. Open `schema.sql` from this folder, copy everything, paste, click **Run**. You should see "Success. No rows returned".
3. Check: **Table Editor** shows volunteers, class_schedules, events, event_assignments, admins.

## Step 4: Create the admin login
1. Left menu: **Authentication** > **Users** > **Add user** > **Create new user**. Enter your email and a strong password. Tick **Auto Confirm User**. Click **Create user**.
2. **Authentication** > **Sign In / Providers** (or Settings): turn **Allow new users to sign up** OFF.
3. Go back to **SQL Editor** > New query. Paste this with YOUR email, then **Run**:
   ```sql
   insert into public.admins(user_id) select id from auth.users where email='you@example.com';
   ```
   It must say "Success. 1 row". Only people in this list can see data. To add another admin, create the user and repeat with their email.

## Step 5: Copy the project URL and anon key
1. Left menu: **Project Settings** (gear) > **API** (or **Data API / API Keys**).
2. Copy **Project URL** (looks like `https://abcd1234.supabase.co`).
3. Copy the **anon public** key (long text; in newer dashboards: **Publishable key**). 
4. Open `config.js`, paste them between the quotes, save.
5. Do **not** copy the `service_role` / secret key anywhere. It must never go in this project.

## Step 6: Private screenshot storage
Already created by `schema.sql` (a private bucket called `screenshots`). To verify: **Storage** shows `screenshots` with a lock/"Private" label. If missing, re-run schema.sql.

## Step 7: Run and test locally
1. In the project folder run `python3 -m http.server 8000`, open http://localhost:8000 (do not double-click index.html; login needs a web address).
2. The top bar must go from "Checking connection…" to "Sign in required". Sign in with your admin account. It becomes **Connected to database** only after the database test passes.
3. Quick test: add a volunteer, refresh the page (still there); open another browser, sign in (same data); add a class and set the routine to Verified; run Availability Finder; create an event and assign the volunteer; delete the test records.
4. If it says "Not configured" or "Database unavailable", read the message. Common causes: empty config.js, wrong URL, account not in `admins` (redo step 4.3), schema.sql not run.

## Step 8: Migrate your existing data (safe)
1. Open the site at the **same address you used before** (localStorage is per address; `localhost:8000` and `github.io` are different).
2. Sign in, go to **Settings** > **Migrate data from this browser**.
3. Read the preview (new, skipped duplicates). Click **Migrate now**. Duplicate phone numbers are skipped; nothing is deleted from your browser.
4. Check **All Volunteers**. Keep the old browser data for a few weeks as backup. Also click **Export JSON**.
Fresh start instead? **Settings > Reset demo data** loads the 18 sample volunteers, but it DELETES everything in the online database.

## Step 9: Deploy on GitHub Pages
1. Upload all files (including `config.js`, `schema.sql`, `assets/`) to your repository, commit.
2. **Settings > Pages**: Deploy from branch `main`, folder `/ (root)`. Open the new link and sign in.
3. The anon key is public by design. Safety comes from login and the admin allow-list. Never commit a service_role key.
4. Phone numbers and screenshot names in `assets/screenshots` and `seed.js` are public in a public repository. Delete those if you migrated.
