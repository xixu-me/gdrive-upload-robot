/**
 * A Cloudflare Worker for a Telegram bot that uploads files to Google Drive.
 *
 * Features:
 * - Responds to files sent to a Telegram bot.
 * - Authenticates with Google Drive using a service account.
 * - Uploads files under 20MB directly.
 * - For files 20MB and larger, it uses the Google Drive Resumable Upload API to upload in chunks.
 *
 * Secrets to be set in Cloudflare Worker settings:
 * - ADMIN_CHAT_ID: Your personal Telegram Chat ID to receive notifications/errors.
 * - GOOGLE_CREDENTIALS: The JSON credentials for your Google Cloud service account.
 * - GOOGLE_DRIVE_FOLDER_ID: The ID of the Google Drive folder where files will be uploaded.
 * - TELEGRAM_BOT_TOKEN: The token for your Telegram bot from BotFather.
 */

// Recommended chunk size for Google Drive resumable uploads (must be a multiple of 256KB)
const CHUNK_SIZE = 256 * 1024 * 10; // 2.5 MB

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'POST') {
			try {
				const update = await request.json();
				if (update.message && update.message.document) {
					ctx.waitUntil(this.handleFileUpload(update.message, env));
				} else if (update.message && update.message.text === '/start') {
					await this.sendMessage(
						env.TELEGRAM_BOT_TOKEN,
						update.message.chat.id,
						'Welcome! Send me a file and I will upload it to Google Drive.'
					);
				}
			} catch (e) {
				// If parsing fails or for any other reason, notify the admin.
				if (env.ADMIN_CHAT_ID) {
					await this.sendMessage(env.TELEGRAM_BOT_TOKEN, env.ADMIN_CHAT_ID, `Error in main fetch: ${e.message}`);
				}
			}
		}
		return new Response('OK'); // Respond to Telegram's webhook POST
	},

	async handleFileUpload(message, env) {
		const doc = message.document;
		const chatId = message.chat.id;
		const fileName = doc.file_name;
		const fileId = doc.file_id;
		const fileSize = doc.file_size;

		await this.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Received "${fileName}". Preparing to upload...`);

		try {
			// 1. Get Google Auth Token
			const authToken = await this.getGoogleAuthToken(env.GOOGLE_CREDENTIALS);

			// 2. Get Telegram file path
			const fileInfo = await this.getTelegramFileInfo(env.TELEGRAM_BOT_TOKEN, fileId);
			if (!fileInfo.ok) {
				throw new Error(`Failed to get file info: ${fileInfo.description}`);
			}
			const filePath = fileInfo.result.file_path;
			const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

			// 3. Initiate Resumable Upload
			const uploadUrl = await this.initiateResumableUpload(authToken, fileName, env.GOOGLE_DRIVE_FOLDER_ID);

			// 4. Download from Telegram and Upload to Drive in chunks
			const fileResponse = await fetch(fileUrl);
			if (!fileResponse.ok || !fileResponse.body) {
				throw new Error('Failed to download file from Telegram.');
			}
			const reader = fileResponse.body.getReader();
			let bytesUploaded = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				const chunk = value;
				await this.uploadChunk(uploadUrl, chunk, bytesUploaded, fileSize);
				bytesUploaded += chunk.length;

				// Optional: Send progress updates
				// const progress = Math.round((bytesUploaded / fileSize) * 100);
				// await this.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Uploading... ${progress}%`);
			}

			await this.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ Successfully uploaded "${fileName}" to Google Drive!`);
		} catch (error) {
			console.error(error);
			await this.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ Failed to upload file. Reason: ${error.message}`);
			if (env.ADMIN_CHAT_ID && env.ADMIN_CHAT_ID !== chatId) {
				await this.sendMessage(env.TELEGRAM_BOT_TOKEN, env.ADMIN_CHAT_ID, `Upload failed for chat ${chatId}: ${error.message}`);
			}
		}
	},

	/**
	 * Generates a Google Cloud access token from service account credentials.
	 */
	async getGoogleAuthToken(credentialsJson) {
		const credentials = JSON.parse(credentialsJson);
		const jwtHeader = {
			alg: 'RS256',
			typ: 'JWT',
		};
		const now = Math.floor(Date.now() / 1000);
		const jwtClaimSet = {
			iss: credentials.client_email,
			scope: 'https://www.googleapis.com/auth/drive',
			aud: 'https://oauth2.googleapis.com/token',
			exp: now + 3600,
			iat: now,
		};

		const encodedHeader = btoa(JSON.stringify(jwtHeader)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
		const encodedClaimSet = btoa(JSON.stringify(jwtClaimSet)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
		const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

		const privateKey = await crypto.subtle.importKey(
			'pkcs8',
			this.pemToBinary(credentials.private_key),
			{
				name: 'RSASSA-PKCS1-V1_5',
				hash: 'SHA-256',
			},
			false,
			['sign']
		);

		const signature = await crypto.subtle.sign('RSASSA-PKCS1-V1_5', privateKey, new TextEncoder().encode(signatureInput));
		const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
			.replace(/=/g, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');

		const jwt = `${signatureInput}.${encodedSignature}`;

		const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
		});

		const tokenData = await tokenResponse.json();
		return tokenData.access_token;
	},

	/**
	 * Initiates a resumable upload session with Google Drive.
	 * @returns {string} The unique session URI for uploading chunks.
	 */
	async initiateResumableUpload(authToken, fileName, folderId) {
		const metadata = {
			name: fileName,
			parents: [folderId],
		};

		const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
				'Content-Type': 'application/json; charset=UTF-8',
			},
			body: JSON.stringify(metadata),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Failed to initiate resumable upload: ${response.status} ${response.statusText} - ${errorBody}`);
		}

		return response.headers.get('Location');
	},

	/**
	 * Uploads a single chunk of the file to the resumable session URI.
	 */
	async uploadChunk(uploadUrl, chunk, startByte, totalSize) {
		const endByte = startByte + chunk.length - 1;

		const response = await fetch(uploadUrl, {
			method: 'PUT',
			headers: {
				'Content-Range': `bytes ${startByte}-${endByte}/${totalSize}`,
				'Content-Length': chunk.length,
			},
			body: chunk,
		});

		// For the last chunk, a 200 OK is returned. For all others, a 308 Resume Incomplete.
		if (response.status !== 308 && response.status !== 200) {
			const errorBody = await response.text();
			throw new Error(`Chunk upload failed: ${response.status} ${response.statusText} - ${errorBody}`);
		}
	},

	/**
	 * Helper to get file path info from Telegram.
	 */
	async getTelegramFileInfo(botToken, fileId) {
		const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
		return response.json();
	},

	/**
	 * Helper to send a message via the Telegram API.
	 */
	async sendMessage(botToken, chatId, text) {
		const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}`;
		await fetch(url);
	},

	/**
	 * Converts a PEM-formatted key to a binary format for WebCrypto API.
	 */
	pemToBinary(pem) {
		const lines = pem.split('\n');
		const base64 = lines.filter((line) => !line.startsWith('-----')).join('');
		const binary = atob(base64);
		const len = binary.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes.buffer;
	},
};
