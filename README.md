# WhatsApp Bot Setup Guide

This guide is for a beginner. Follow it step by step to run the bot on your computer or on a cloud host.

## What the bot does now

- Shows a product menu when someone sends `hello`, `hi`, or `menu`
- Lets customers browse categories with `products [category]`
- Lets customers order fixed-price products with `buy [ID] [qty]`
- Lets customers price square-metre items by sending **length × height in mm**
- Adds design, pole, and installation costs where needed
- Shows a cart and checkout summary
- Shows the **Artwork Disclaimer** before final confirmation
- Lets a customer ask for a **human takeover** at any time
- Stores unanswered messages so the bot can be improved over time
- Lets the admin teach the bot new replies with a simple learning command
- Lets the admin send a new `products.csv` file to the bot on WhatsApp
- Emails the WhatsApp login QR code to your Gmail address

## What “learning” means in this bot

This bot now has a lightweight learning layer:

- it records unanswered customer messages as **learning leads**
- the admin can teach a reusable reply with `teach question => response`
- the bot tries to match similar future messages to those taught replies

This is not a full AI model training pipeline. It is a practical, controlled way to make the bot smarter without letting it give random answers.

## Programs and websites you will use

1. **Node.js** - to run the bot  
   https://nodejs.org
2. **GitHub** - to store your code  
   https://github.com
3. **Gmail** - to receive the QR code email  
   https://mail.google.com
4. **Railway** - recommended cloud hosting because this repo already includes a working start command and it's straightforward to add persistent storage  
   https://railway.app
5. **WhatsApp on your phone** - to scan the QR code

## Files that matter

- `./index.js` - the bot code
- `./storage/products.csv` - your live product list used by the bot (auto-migrated from `./products.csv` on first run)
- `./storage/` - created automatically for login files, learning data, and QR images
- `./nixpacks.toml` - Railway/Nixpacks start configuration

## Before you start

You need:

- A Gmail account
- A WhatsApp account on your phone
- Node.js installed
- This project downloaded from GitHub

## Step 1: Install Node.js

1. Open https://nodejs.org
2. Download the **LTS** version
3. Install it with the default options
4. After installation, open a terminal and check it works:

```bash
node -v
npm -v
```

If both commands show version numbers, you are ready.

## Step 2: Open the project folder

If you already have the files, open a terminal inside the project:

```bash
cd /path/to/your/project
```

## Step 3: Install the bot packages

Inside the project folder, run:

```bash
npm install
```

## Step 4: Prepare Gmail for QR code emails

The bot emails the WhatsApp login QR code to you.

1. Log in to Gmail
2. Turn on **2-Step Verification** for your Google account
3. Create an **App Password**
4. Copy that app password

You will use:

- your Gmail address as `EMAIL_USER`
- your Google app password as `EMAIL_PASS`

## Step 5: Find your admin WhatsApp ID

The admin number must look like this:

```text
27123456789@s.whatsapp.net
```

Rules:

- use your full phone number
- do not include `+`
- do not include spaces
- add `@s.whatsapp.net` at the end

Example:

- Phone number: `+27 123 456 789`
- Admin ID: `27123456789@s.whatsapp.net`

## Step 6: Start the bot on your computer

### Mac or Linux

```bash
cd /path/to/your/project
ADMIN_JID="27123456789@s.whatsapp.net" EMAIL_USER="you@gmail.com" EMAIL_PASS="your-app-password" npm start
```

### Windows PowerShell

```powershell
cd C:\path\to\your\project
$env:ADMIN_JID="27123456789@s.whatsapp.net"
$env:EMAIL_USER="you@gmail.com"
$env:EMAIL_PASS="your-app-password"
npm start
```

## Step 7: Connect WhatsApp

1. Start the bot
2. Wait for the QR code email to arrive in Gmail
3. Open WhatsApp on your phone
4. Go to **Linked Devices**
5. Tap **Link a Device**
6. Scan the QR code from the email

If the QR code email does not arrive:

- check spam/junk
- make sure the Gmail app password is correct
- restart the bot

## Step 8: Test the customer flow

Send these messages to the connected WhatsApp bot:

- `hello` or `menu` — shows product categories
- `products Signs` — lists Sign products
- `buy 4` — starts an sqm quote flow
- `1200 x 600 mm` — sends length and height in mm
- `yes` / `no` — answers pole and installation prompts
- `cart` — shows the basket
- `checkout` — shows the order summary and artwork disclaimer
- `confirm` — confirms checkout and sends the order to admin review
- `human` — requests a real person to take over
- `help` — shows guidance
- `clear` — empties the cart
- `cancel` — exits the current step
- `back` — returns to the previous bot step
- `home` or `main menu` — restarts at the main menu

Expected result:

- the bot responds with clear next steps
- `back` returns the customer to the previous prompt without losing the earlier flow state
- `home` or `main menu` restarts from the welcome menu
- square-metre products ask for **length × height in mm** and return a price
- design, poles, and installation are added correctly when applicable
- `checkout` shows totals and the artwork disclaimer
- `human` pauses the bot so a person can take over

## Step 9: Test the admin controls

From the admin WhatsApp account, test these commands:

- send a new CSV file — updates products
- `teach do you install signs => Yes, we can quote for installation where available.`
- `leads` — shows the most common unanswered customer messages
- `handovers` — shows customers currently waiting for a human
- `resume 27123456789@s.whatsapp.net` — gives that customer back to the bot

Expected result:

- taught replies should be reused when customers ask similar questions
- unanswered customer wording should appear in `leads`
- customers who ask for `human` should stop getting automated replies until resumed

## Step 10: Edit your products

Open:

`./storage/products.csv`

The CSV has 21 columns:

```csv
ID,SKU,Category,Subcategory,SubSubcategory,SubSubSubcategory,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee,RequiresArtwork,Aliases
```

| Column | Description |
|---|---|
| `ID` | Unique numeric ID |
| `SKU` | *(Optional)* Stock-keeping unit code used as the `product_key` when creating Invoice Ninja line items. Set this to match the SKU code of the corresponding product in Invoice Ninja so that quotes are correctly linked to your product catalogue. When left blank the product name is used instead. Example values: `PP-0001`, `BC-SS-100`. |
| `Category` | Product category (for example `Banners`, `Signs`, `Stickers`) |
| `Subcategory` | Product family within the category (for example `Business Cards`, `Flyers`) |
| `SubSubcategory` | *(Optional)* A second level within the subcategory (for example `Single Sided`, `Double Sided`). Leave blank for products that do not need this level. When products in the same subcategory have different `SubSubcategory` values the bot will ask the customer to choose before showing the product list. |
| `SubSubSubcategory` | *(Optional)* A third level of refinement (for example `Gloss`, `Matte`). Works the same way as `SubSubcategory`. Leave blank when not needed. |
| `Name` | Display name |
| `Size` | Product size or note (for example `A5`, `600x900mm`, `Custom`) |
| `Finish` | Product finish |
| `SingleOrDoubleSided` | `Single` or `Double` |
| `UnitsPerProduct` | Units included in one priced product |
| `PriceType` | `sqm` (per square metre) or `fixed` |
| `PricePerSqm` | Price per m² in Rands |
| `FixedPrice` | Fixed price in Rands |
| `MinPrice` | Minimum charge in Rands for sqm products |
| `DesignFee` | Mandatory design/layout fee in Rands |
| `PolesAvailable` | `yes` or `no` |
| `PolePrice` | Price per pole in Rands |
| `InstallationFee` | Installation fee in Rands |
| `RequiresArtwork` | `yes` (default) or `no`. When `yes`, the bot asks the customer to upload artwork during checkout. When `no`, the artwork upload step is skipped (useful for products with no custom artwork, like standard off-the-shelf items). |
| `Aliases` | Optional extra search words separated by `|` (for example `visiting cards|biz cards`) |

**How sub-sub-categories work (example):**

| Category | Subcategory | SubSubcategory | SubSubSubcategory | Name |
|---|---|---|---|---|
| Paper Printing | Business Cards | Single Sided | | Business Cards 300GSM |
| Paper Printing | Business Cards | Double Sided | | Business Cards 300GSM |
| Paper Printing | Flyers | | | A5 Gloss Flyer |

When a customer types *business cards* the bot will ask:
> *Business Cards – Choose a type:*
> 1. Single Sided
> 2. Double Sided

After the customer replies *1* it shows only the single-sided product list.

If you are unsure about the format, download the template from the products admin page or use `/products/template`.

**sqm pricing:** when a client provides length and height in mm, the bot calculates:

`price = (length_mm / 1000) × (height_mm / 1000) × PricePerSqm`

Then it applies `MinPrice` as the minimum charge.

## Artwork Disclaimer used at checkout

The bot now shows this disclaimer before final confirmation:

**Artwork Disclaimer**

- Duzi Signs is not responsible for any errors in artwork, whether designed by us or supplied by the customer.
- Colours may vary due to different screens, software, materials, and printing processes.
- If you require an exact colour match, please request a sample print before production. Sample prints must be viewed and approved in person. Please note that requesting a sample will delay your order.
- Once artwork has been approved and printing has started, no reprints or refunds will be given for approved colours, layout, spelling, or design.
- AI-generated artwork cannot always be edited, recreated, or printed in high quality, especially for large-format printing.
- Customer-supplied artwork can only be edited if an editable file is provided.

## How to deploy on a cloud system (Railway)

Use Railway if you want the bot online all the time.

### Step 1: Push the project to GitHub

Make sure your latest code is in your GitHub repository.

### Step 2: Create a Railway project

1. Go to https://railway.app
2. Sign in
3. Create a **New Project**
4. Choose **Deploy from GitHub repo**
5. Select your bot repository

### Step 3: Add environment variables

In Railway, add these variables:

- `ADMIN_JID`
- `EMAIL_USER`
- `EMAIL_PASS`
- `QR_ACCESS_TOKEN` (optional but recommended for securing `/qr`)
- `ADMIN_PASSWORD` – **recommended** – password to log into the admin dashboard. If omitted, the dashboard uses `QR_ACCESS_TOKEN` as the password.

#### Google Drive file storage (optional)

When set, design files and artwork uploaded by customers are stored in your Google Drive so they are always accessible and downloadable from the admin dashboard.

1. Create a [Google Cloud service account](https://cloud.google.com/iam/docs/service-accounts-create) with the **Google Drive API** enabled.
2. Create a Drive folder and share it with the service account email (Editor role).
3. Add these environment variables:

| Variable | Description |
|---|---|
| `GOOGLE_DRIVE_CLIENT_EMAIL` | Service account e-mail from the JSON key file |
| `GOOGLE_DRIVE_PRIVATE_KEY` | Private key from the JSON key file (newlines as `\n`) |
| `GOOGLE_DRIVE_FOLDER_ID` | ID of the shared Drive folder (from the URL) |

Without these variables, files are stored on local disk only (still accessible via the dashboard's file download endpoint).

#### Invoice Ninja (optional)

To automatically create quotes in Invoice Ninja when customers check out, add:

- `INVOICE_NINJA_URL` – base URL of your Invoice Ninja instance, e.g. `https://app.invoicing.co`  
  **Important:** do _not_ include `/api/v1` in this URL — the bot appends it automatically.
- `INVOICE_NINJA_API_TOKEN` – API token from Invoice Ninja → Settings → API Tokens
- `INVOICE_NINJA_TAX_NAME` – tax label used on quote line items (default: `VAT`)
- `INVOICE_NINJA_TAX_RATE` – tax rate as a percentage (default: `15`)
- `INVOICE_NINJA_WEBHOOK_SECRET` – optional secret for verifying webhook requests from Invoice Ninja

When `INVOICE_NINJA_URL` and `INVOICE_NINJA_API_TOKEN` are set, the bot will:
1. Ask customers for their email address at checkout (they can type `skip` to omit it)
2. Find or create a client record in Invoice Ninja
3. Create a quote with itemised line items (material, design, poles, installation). The `SKU` column in your products CSV is used as the `product_key` on each line item so that Invoice Ninja matches it to the correct product in your catalogue.
4. Send the customer a link to **view their PDF quote directly** — no Invoice Ninja login required (see below)
5. Notify admin when a quote is approved or paid (via webhook)

#### Direct PDF quote link (no login required)

By default the quote link sent to the customer opens the Invoice Ninja client portal, which may require a login. To bypass this, set the `BOT_PUBLIC_URL` environment variable to the public URL of your bot (e.g. `https://my-app.up.railway.app`). The bot will then send the customer a direct PDF link like:

```
https://my-app.up.railway.app/quote-pdf/<invitation-key>
```

This URL is publicly accessible — no login is needed. The invitation key acts as a secure capability token (only someone who received the WhatsApp message can access it). On Railway the `RAILWAY_PUBLIC_DOMAIN` variable is usually set automatically and will be used if `BOT_PUBLIC_URL` is not set.

**Troubleshooting Invoice Ninja quote creation:**

If quotes are not being created, check the following:

| Symptom | Likely cause | Fix |
|---|---|---|
| Admin receives `⚠️ Quote creation failed – manual follow-up needed.` with an error | Wrong URL or token | Check `INVOICE_NINJA_URL` (no trailing `/api/v1`) and `INVOICE_NINJA_API_TOKEN` in Railway variables |
| `Invoice Ninja API 401` error | Invalid API token | Generate a new token in Invoice Ninja → Settings → API Tokens |
| `Invalid INVOICE_NINJA_URL` error | Malformed URL | Must start with `https://` and have no trailing slash |
| `Invoice Ninja API 422` error | Missing required field | Check Railway logs for the full error body |
| No error but no quote | `isConfigured()` returns false | Both `INVOICE_NINJA_URL` and `INVOICE_NINJA_API_TOKEN` must be set |

Check Railway logs (`node index.js` output) for lines beginning with `❌ Invoice Ninja` for the full error details.

#### PayFast online payments (optional)

PayFast is a South African payment gateway. When configured, the bot sends the customer a payment link immediately after they confirm their order.

**How to get your PayFast credentials:**

1. Log in to [PayFast](https://www.payfast.co.za) (or create a free account).
2. Go to **Settings → Integration**.
3. Copy your **Merchant ID** and **Merchant Key**.
4. Optionally set a **Passphrase** in PayFast → Settings → Integration and copy it.

**Environment variables to add in Railway:**

| Variable | Required | Description |
|---|---|---|
| `PAYFAST_MERCHANT_ID` | ✅ | Your PayFast Merchant ID |
| `PAYFAST_MERCHANT_KEY` | ✅ | Your PayFast Merchant Key |
| `PAYFAST_PASSPHRASE` | ☑️ Recommended | Security passphrase set in PayFast → Settings → Integration |
| `PAYFAST_SANDBOX` | ☑️ For testing | Set to `true` to use the PayFast sandbox. Remove or set to `false` for live payments. |

> **Important:** `BOT_PUBLIC_URL` or `RAILWAY_PUBLIC_DOMAIN` must also be set so the bot can generate the customer-facing payment link and the webhook `notify_url`. On Railway, `RAILWAY_PUBLIC_DOMAIN` is usually set automatically.

**Payment flow once configured:**

1. Customer confirms their order on WhatsApp.
2. Bot sends the customer a payment link: `https://your-app.up.railway.app/pay/<order-id>`
3. Customer opens the link in a browser and is shown the order amount.
4. Customer clicks **Pay now via PayFast** and is redirected to PayFast to complete payment.
5. PayFast sends an ITN (Instant Transaction Notification) to the bot's webhook.
6. Bot verifies the payment and sends a WhatsApp confirmation to both the customer and the admin.

**Testing with the PayFast sandbox:**

1. Set `PAYFAST_SANDBOX=true`.
2. Use the [PayFast sandbox test credentials](https://developers.payfast.co.za/docs#testing):
   - Merchant ID: `10004002`
   - Merchant Key: `q1cd2rdny4a53`
3. Complete a test payment — no real money is charged.
4. Remove `PAYFAST_SANDBOX` (or set it to `false`) before going live.

**Troubleshooting PayFast payments:**

| Symptom | Likely cause | Fix |
|---|---|---|
| No payment link sent to customer | `BOT_PUBLIC_URL` not set | Set `BOT_PUBLIC_URL` or ensure `RAILWAY_PUBLIC_DOMAIN` is set by Railway |
| `⚠️ PayFast ITN signature verification failed` in logs | Wrong passphrase or merchant credentials | Check `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, and `PAYFAST_PASSPHRASE` match your PayFast account |
| `⚠️ PayFast ITN amount mismatch` in logs | Customer tampered with the amount | This is a security check — the order status will not be updated |
| `⚠️ PayFast ITN server validation returned INVALID` | PayFast could not verify the request | Check that `notify_url` is publicly accessible (not `localhost`) |
| Payment link shows "Online payments are not enabled" | Missing env vars | Both `PAYFAST_MERCHANT_ID` and `PAYFAST_MERCHANT_KEY` must be set |

Check Railway logs for lines beginning with `❌ PayFast` or `⚠️ PayFast` for the full error details.

### Step 4: Add persistent storage

This is important.

The bot stores these items in `/storage`:

- WhatsApp login session files
- QR image files
- learned replies
- unanswered learning leads
- confirmed orders (for Invoice Ninja linkage)
- live products CSV (`products.csv`)

On Railway, add a persistent volume and mount it to **`/app/storage`**. This keeps the bot data between restarts and deploys. Railway/Nixpacks normally runs this app from `/app`, which is why `./storage` maps to `/app/storage` there. If you do not use persistent storage, the bot may need to be linked again and may lose its learned responses.

### Invoice Ninja webhook (optional)

To receive status notifications (quote approved, payment received), register a webhook in Invoice Ninja:

1. In Invoice Ninja go to **Settings → Webhooks → New Webhook**.
2. Set the webhook URL to `https://your-app.up.railway.app/webhook/invoice-ninja`.  
   - REST method: **POST**
3. Select quote status events so updates include the quote record ID used by this bot:
   - **Quote Approved**
   - **Quote Updated**
4. (Optional but recommended) Enable webhook signing in Invoice Ninja, copy the generated secret, and set it as `INVOICE_NINJA_WEBHOOK_SECRET` in Railway.
5. Save the webhook. Invoice Ninja may perform a `GET` request to verify the endpoint is live — the bot handles this and returns `200 OK` automatically.
6. Trigger a test quote approval/payment update to confirm bot and admin notifications are received.

> **`Cannot GET /webhook/invoice-ninja`?** This just means Invoice Ninja (or a browser) opened the URL in a browser or via a GET request to verify it. The bot now handles this correctly with a 200 OK response. The real webhook events use POST and will work as expected.

### Step 5: Deploy

Railway installs dependencies and starts the bot with:

```bash
node index.js
```

### Step 6: Link WhatsApp

After deploy:

1. Open Railway logs
2. Wait for the bot to start
3. If the logs show `WhatsApp status: awaiting_qr`, check Gmail for the QR code
4. Scan it in WhatsApp on your phone

If you set `QR_ACCESS_TOKEN`, send it in a request header when opening the QR page:

```bash
curl -H "Authorization: ******" https://your-app.up.railway.app/qr
```

Or use a custom header:

```bash
curl -H "X-QR-Access-Token: your_token_here" https://your-app.up.railway.app/qr
```

Useful log meanings:

- `WhatsApp status: initializing` — the bot is starting the WhatsApp client
- `WhatsApp status: awaiting_qr` — a QR code was generated and emailed
- `WhatsApp status: connected` — WhatsApp linked successfully
- `WhatsApp status: reconnecting` — the bot hit an error or disconnect and will retry

### Step 7: Confirm it is healthy

Check:

- Railway shows the service as running
- the root URL returns `Bot is running!`
- `/health` returns JSON with the current WhatsApp status
- the bot responds to `menu`
- the bot can price an sqm item
- the bot can hand over to a human
- the admin receives checkout and handover alerts

## How to keep customers from getting frustrated

To reduce frustration:

- keep `storage/products.csv` clean and accurate
- teach common questions with the `teach` command
- review `leads` regularly and add new taught replies
- use `human` handover quickly when a customer sounds upset or needs a special answer
- test sqm pricing flows after every catalog change
- keep Railway storage persistent so sessions and learned replies do not disappear

## PayFast payment integration

When `PAYFAST_MERCHANT_ID` and `PAYFAST_MERCHANT_KEY` are set (see the Railway deployment section above), the bot:

1. Generates a unique payment link for each order: `https://your-app.up.railway.app/pay/<order-id>`
2. Sends the link to the customer on WhatsApp immediately after they confirm their order
3. The customer opens the link, sees the total, and clicks **Pay now via PayFast**
4. After payment, the bot notifies both the customer and the admin on WhatsApp
5. The order status in the admin dashboard updates to `paid`

The payment link is publicly accessible — no login is needed. The 12-character random order ID acts as a secure capability token.

Use `PAYFAST_SANDBOX=true` for testing. See the full setup guide under **Railway → PayFast online payments**.

## Common problems

### `Missing required environment variables`

You forgot to set one of these:

- `ADMIN_JID`
- `EMAIL_USER`
- `EMAIL_PASS`

### QR code never arrives

- check Gmail spam
- confirm the Gmail app password is correct
- make sure `EMAIL_USER` is a real Gmail address

### Bot starts but shows the wrong products

Check:

`./storage/products.csv`

### Bot loses its session or learned replies on Railway

You probably did not attach persistent storage to the `/storage` folder.

### Railway deploy fails

Check that:

- the GitHub repo is connected correctly
- the Railway variables are set
- Railway logs do not show missing environment variables

## Quick command list

### Customer commands

- `menu`
- `products Signs`
- `buy 4`
- `1200 x 600 mm`
- `cart`
- `checkout`
- `you@example.com` (email prompt when Invoice Ninja is configured)
- `skip` (skip the email prompt)
- `confirm`
- `human`
- `help`
- `clear`
- `cancel`

### Admin commands

- send CSV file
- `teach question => response`
- `leads`
- `handovers`
- `resume customer_jid`

## Admin Dashboard

The bot includes a live admin dashboard accessible from any browser. It gives you full visibility into customer conversations, orders, and bot status.

### How to access the dashboard

Open your browser and navigate to:

```
https://your-app.up.railway.app/admin
```

You will be prompted to sign in. Use the password you set in `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, the dashboard falls back to accepting `QR_ACCESS_TOKEN` as the password (or allows anyone in if neither is configured).

Sessions are stored server-side in memory with an 8-hour expiry.

### Dashboard tabs

| Tab | What it shows |
|---|---|
| 💬 **Chats** | All customer conversations with live updates. Click any chat to read the history and take over from the bot. |
| 📋 **Orders** | Every order submitted by customers. Shows status, quote link, and downloadable design/artwork files. |
| 📦 **Products** | Download or upload the products CSV without leaving the dashboard. |
| 💡 **Leads** | Unanswered customer messages, sorted by frequency. Use these to teach the bot new replies. |
| 🤝 **Handovers** | All currently active human handover sessions. Resume bot control for any customer from here. |
| 📱 **QR** | WhatsApp connection status. Links to the QR code page when the bot is not yet linked. |

### Taking over from the bot

Type a message in the chat text box and press **Enter** or click **Send**. The first message you send will:

1. Pause the bot for that customer.
2. Notify the customer that a team member has taken over.
3. Send your message to the customer.

All subsequent messages you type also go to the customer while the handover is active.

### Handing back to the bot

Click the **Resume Bot** button in the chat header (visible during a handover), or use the **Handovers** tab. The bot will take over again and notify the customer.

### Downloading design and artwork files

When a customer uploads artwork or design files during an order:

- If Google Drive is configured, files are uploaded to Drive and accessible via the **Orders** tab.
- If Google Drive is not configured, files are stored on disk and still downloadable via the **Orders** tab using a secure backend proxy.

Files are never served directly from an unauthenticated URL — downloads always go through the authenticated dashboard.

### Admin audit log

All admin actions (login, send message, resume bot, file download) are appended to `./storage/admin_audit.log`.

That is the full setup and operating guide.
