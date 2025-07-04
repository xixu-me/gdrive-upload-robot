# Google Drive Upload Robot

A Telegram bot built on Cloudflare Workers that automatically uploads files and photos sent to it directly to Google Drive.

## Features

- 📁 **Automatic File Upload**: Uploads any document sent to the bot directly to Google Drive
- 📷 **Photo Support**: Handles photo uploads with automatic naming
- ☁️ **Serverless**: Runs on Cloudflare Workers for zero-cost hosting
- 🔒 **Secure**: Uses Google Service Account authentication
- 📱 **Real-time Notifications**: Sends confirmation messages to admin

## How It Works

1. User sends a file or photo to the Telegram bot
2. Bot downloads the file from Telegram servers
3. Authenticates with Google Drive using service account credentials
4. Uploads the file to a specified Google Drive folder
5. Sends confirmation message to admin

## Quick Start

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xixu-me/gdrive-upload-robot)

Use the Deploy to Cloudflare button above for the fastest setup experience.

## Setup

### Prerequisites

Before you begin, make sure you have:

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier available)
- [Node.js](https://nodejs.org/) (version 16 or higher)
- Git installed on your machine

### Step 1: Google Drive Setup

1. **Create Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Note down your project ID

2. **Enable Google Drive API**
   - In the Google Cloud Console, go to "APIs & Services" > "Library"
   - Search for "Google Drive API" and click "Enable"

3. **Create Service Account**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in the service account details and create
   - Click on the created service account
   - Go to "Keys" tab > "Add Key" > "Create New Key"
   - Choose JSON format and download the file
   - **Keep this JSON file secure - it contains sensitive credentials**

4. **Setup Google Drive Folder**
   - Create a folder in your Google Drive where files will be uploaded
   - Right-click the folder > "Share"
   - Add the service account email (found in the JSON file) as an editor
   - Copy the folder ID from the URL (e.g., `https://drive.google.com/drive/folders/FOLDER_ID_HERE`)

### Step 2: Telegram Bot Setup

1. **Create Telegram Bot**
   - Message [@BotFather](https://t.me/botfather) on Telegram
   - Send `/newbot` command
   - Follow the prompts to choose a name and username
   - Save the bot token provided

2. **Get Your Chat ID**
   - Message [@userinfobot](https://t.me/userinfobot) to get your chat ID
   - Or send a message to your bot and visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":CHAT_ID}` in the response

### Step 3: Environment Variables

You'll need these environment variables. **Keep them secure!**

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` |
| `GOOGLE_DRIVE_FOLDER_ID` | Google Drive folder ID | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` |
| `ADMIN_CHAT_ID` | Your Telegram chat ID | `123456789` |
| `GOOGLE_CREDENTIALS` | Service account JSON (as string) | `{"type":"service_account",...}` |

### Step 4: Local Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/xixu-me/gdrive-upload-robot.git
   cd gdrive-upload-robot
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Login to Cloudflare**

   ```bash
   npx wrangler login
   ```

4. **Configure secrets** (for production)

   ```bash
   # Add bot token
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   
   # Add Google Drive folder ID
   npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID
   
   # Add your chat ID
   npx wrangler secret put ADMIN_CHAT_ID
   
   # Add Google credentials (paste the entire JSON content)
   npx wrangler secret put GOOGLE_CREDENTIALS
   ```

### Step 5: Deploy

1. **Deploy to Cloudflare Workers**

   ```bash
   npx wrangler deploy
   ```

2. **Set up Telegram webhook**

   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
        -H "Content-Type: application/json" \
        -d '{"url": "https://your-worker.your-subdomain.workers.dev"}'
   ```

   Replace `<YOUR_BOT_TOKEN>` with your actual bot token and update the URL with your worker's URL.

3. **Test the bot**
   - Send a file or photo to your Telegram bot
   - Check if it appears in your Google Drive folder
   - You should receive a confirmation message

### Troubleshooting

- **Bot not responding**: Check if the webhook is set correctly
- **Upload fails**: Verify Google Drive folder permissions and service account access
- **Authentication errors**: Ensure all environment variables are set correctly
- **Local development**: Use `npx wrangler dev` for local testing

## API Endpoints

The worker expects POST requests from Telegram webhooks with the following payload structure:

### Document Upload

```json
{
  "message": {
    "document": {
      "file_id": "telegram_file_id",
      "file_name": "document.pdf"
    }
  }
}
```

### Photo Upload

```json
{
  "message": {
    "photo": [
      {
        "file_id": "telegram_file_id",
        "width": 1280,
        "height": 720
      }
    ]
  }
}
```

## Security Considerations

- Environment variables containing sensitive data are stored securely in Cloudflare Workers
- Google Service Account credentials should have minimal required permissions
- Bot token should be kept secret and not committed to version control
- Consider implementing rate limiting for production use

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Uses [Google Drive API](https://developers.google.com/drive/api)
- Integrates with [Telegram Bot API](https://core.telegram.org/bots/api)
