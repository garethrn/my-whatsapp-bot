# WhatsApp Bot Dummy Guide

This guide is for a complete beginner. Follow it step by step and you will have the bot running on your computer or on a cloud host.

## What this bot does

- Shows a product menu when someone sends `hello` or `menu`
- Lets people buy items with `buy <product id> <quantity>`
- Shows the basket total with `checkout`
- Lets the admin send a new `products.csv` file to the bot on WhatsApp to update the catalog
- Sends the WhatsApp login QR code to your Gmail address

## Programs and websites you will use

1. **Node.js** - to run the bot  
   https://nodejs.org
2. **GitHub** - to store your code  
   https://github.com
3. **Gmail** - to receive the QR code email  
   https://mail.google.com
4. **Railway** - optional cloud hosting  
   https://railway.app
5. **WhatsApp on your phone** - to scan the QR code

## Files that matter

- `./index.js` - the bot code
- `./products.csv` - your product list
- `./storage/` - created automatically for login files and QR images

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

## Step 2: Get the project onto your computer

If you already have the files, skip this step.

If not:

1. Put the project in a GitHub repository
2. Download it or clone it to your computer
3. Open a terminal inside:

```bash
cd /path/to/your/project
```

## Step 3: Install the bot packages

Inside the project folder, run:

```bash
npm install
```

This installs all required packages.

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

## Step 8: Test the bot

Send these messages to the connected WhatsApp bot:

- `hello` or `menu` — shows product categories
- `products Signs` — lists all Sign products with pricing details
- `buy 4` — starts ordering an Aluminium Composite Sign (asks for dimensions)
- `1200x600` — provides length × breadth in mm; bot calculates price
- `yes` / `no` — answers pole and installation prompts
- `cart` — shows current cart with totals
- `checkout` — shows full order summary
- `clear` — empties the cart
- `cancel` — exits any in-progress order flow

Expected result:

- `hello` or `menu` shows the 6 product categories
- sqm-priced products ask for dimensions in mm, then calculate a price in Rands (with a minimum price floor)
- products with a mandatory design/layout fee have it added automatically
- Sign products with poles offer a per-pole add-on; Signs with installation offer an installation add-on
- `checkout` shows a line-by-line breakdown (material, design fee, poles, installation) and a grand total in Rands

## Step 9: Edit your products

Open:

`./products.csv`

The CSV has 11 columns:

```csv
ID,Category,Name,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee
```

| Column | Description |
|---|---|
| `ID` | Unique numeric ID |
| `Category` | Product category (e.g. `Banners`, `Signs`, `Stickers`) |
| `Name` | Display name |
| `PriceType` | `sqm` (per square metre) or `fixed` |
| `PricePerSqm` | Price per m² in Rands — used when `PriceType=sqm` |
| `FixedPrice` | Fixed price in Rands — used when `PriceType=fixed` |
| `MinPrice` | Minimum charge in Rands (applies to sqm products) |
| `DesignFee` | Mandatory design/layout fee in Rands (`0.00` if none) |
| `PolesAvailable` | `yes` or `no` — whether pole add-ons are offered |
| `PolePrice` | Price per pole in Rands (leave blank if `PolesAvailable=no`) |
| `InstallationFee` | Installation fee in Rands (`0.00` if none) |

**sqm pricing:** when a client provides length and breadth in mm the bot calculates  
`price = (length_mm ÷ 1000) × (breadth_mm ÷ 1000) × PricePerSqm`, then applies `MinPrice` as a floor.

You can also send a new CSV file to the bot from the admin WhatsApp account to replace the catalog.

## How to deploy on Railway

Use Railway if you want the bot online all the time.

### Step 1: Push the project to GitHub

Make sure your latest code is in your GitHub repository.

### Step 2: Create a Railway project

1. Go to https://railway.app
2. Sign in
3. Create a **New Project**
4. Choose **Deploy from GitHub repo**
5. Select your bot repository

### Step 3: Add Railway environment variables

In Railway, add these variables:

- `ADMIN_JID`
- `EMAIL_USER`
- `EMAIL_PASS`

Use the same values you used locally.

### Step 4: Deploy

Railway will install dependencies and run:

```bash
node index.js
```

The app already listens on the `PORT` Railway provides, so no extra port setup is needed.

### Step 5: Link WhatsApp

After deploy:

1. Open Railway logs
2. Wait for the bot to start
3. Check your Gmail for the QR code
4. Scan it in WhatsApp on your phone

### Step 6: Keep it running

Once linked, Railway keeps the bot online as long as the service is running.

If WhatsApp logs out, the bot will ask for a new QR code again.

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

### Railway deploy fails

Check that:

- the GitHub repo is connected correctly
- the Railway variables are set
- Railway logs do not show missing environment variables

## Quick command list

- `hello` or `menu` - show products
- `buy 1 2` - buy 2 of product 1
- `checkout` - show total and clear the cart

That is the full beginner setup.
