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
- `./products.csv` - your product list
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

Expected result:

- the bot responds with clear next steps
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

`./products.csv`

The CSV has 15 columns:

```csv
ID,Category,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee
```

| Column | Description |
|---|---|
| `ID` | Unique numeric ID |
| `Category` | Product category (for example `Banners`, `Signs`, `Stickers`) |
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

### Step 4: Add persistent storage

This is important.

The bot stores these items in `/storage`:

- WhatsApp login session files
- QR image files
- learned replies
- unanswered learning leads

On Railway, add a persistent volume and mount it to **`/app/storage`**. This keeps the bot data between restarts and deploys. Railway/Nixpacks normally runs this app from `/app`, which is why `./storage` maps to `/app/storage` there. If you do not use persistent storage, the bot may need to be linked again and may lose its learned responses.

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

- keep `products.csv` clean and accurate
- teach common questions with the `teach` command
- review `leads` regularly and add new taught replies
- use `human` handover quickly when a customer sounds upset or needs a special answer
- test sqm pricing flows after every catalog change
- keep Railway storage persistent so sessions and learned replies do not disappear

## Future PayFast payment feature

PayFast is not yet connected in this version.

A good later phase is:

1. create an order reference at checkout
2. generate a PayFast payment link
3. send that payment link on WhatsApp
4. confirm payment status before production starts
5. notify admin when payment succeeds or fails

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

`./products.csv`

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

That is the full setup and operating guide.
