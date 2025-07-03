export default {
	async fetch(request, env) {
		if (request.method === 'POST') {
			const payload = await request.json();
			if (payload.message && payload.message.document) {
				await handleDocument(payload.message, env);
			} else if (payload.message && payload.message.photo) {
				await handlePhoto(payload.message, env);
			}
		}
		return new Response('OK');
	},
};

async function handleDocument(message, env) {
	const fileId = message.document.file_id;
	const fileName = message.document.file_name;
	const fileSize = message.document.file_size; // Get file size
	await uploadToDrive(fileId, fileName, fileSize, env);
}

async function handlePhoto(message, env) {
	const photo = message.photo[message.photo.length - 1]; // Get the highest resolution photo
	const fileId = photo.file_id;
	const fileSize = photo.file_size; // Get file size
	const fileName = `${fileId}.jpg`;
	await uploadToDrive(fileId, fileName, fileSize, env);
}

async function uploadToDrive(fileId, fileName, fileSize, env) {
	const botToken = env.TELEGRAM_BOT_TOKEN;
	const driveFolderId = env.GOOGLE_DRIVE_FOLDER_ID;
	const adminChatId = env.ADMIN_CHAT_ID;
	const googleCredentials = JSON.parse(env.GOOGLE_CREDENTIALS);

	// Define the threshold for large files (20MB)
	const RESUMABLE_UPLOAD_THRESHOLD = 20 * 1024 * 1024;

	try {
		// Get file details from Telegram
		const fileDetailsUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
		const fileDetailsResponse = await fetch(fileDetailsUrl);
		const fileDetails = await fileDetailsResponse.json();
		if (!fileDetails.ok) {
			throw new Error(`Failed to get file details: ${fileDetails.description}`);
		}
		const filePath = fileDetails.result.file_path;
		const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

		// Get Google Drive authentication token
		const jwtToken = await getGoogleAuthToken(googleCredentials);

		// Download file from Telegram
		const fileResponse = await fetch(fileUrl);
		if (!fileResponse.ok) {
			throw new Error(`Failed to download file from Telegram: ${fileResponse.statusText}`);
		}

		const metadata = {
			name: fileName,
			parents: [driveFolderId],
		};

		// Choose upload method based on file size
		if (fileSize && fileSize > RESUMABLE_UPLOAD_THRESHOLD) {
			// --- Resumable Upload for large files ---
			await sendMessage(
				adminChatId,
				`File "${fileName}" (${(fileSize / 1024 / 1024).toFixed(2)} MB) is large, starting resumable upload...`,
				botToken
			);

			// 1. Create a resumable session to get the upload URL
			const initiateResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwtToken}`,
					'Content-Type': 'application/json; charset=UTF-8',
				},
				body: JSON.stringify(metadata),
			});

			if (!initiateResponse.ok) {
				throw new Error(`Failed to create resumable session: ${await initiateResponse.text()}`);
			}

			const location = initiateResponse.headers.get('Location'); // Get the unique URL for the upload

			// 2. Upload the file content
			const uploadResponse = await fetch(location, {
				method: 'PUT',
				headers: {
					'Content-Length': fileResponse.headers.get('content-length'),
				},
				body: fileResponse.body, // Stream the body directly for better efficiency
			});

			const uploadResult = await uploadResponse.json();
			if (uploadResult.id) {
				await sendMessage(
					adminChatId,
					`File "${fileName}" has been successfully uploaded to Google Drive using resumable upload!`,
					botToken
				);
			} else {
				throw new Error(`Resumable upload failed: ${JSON.stringify(uploadResult.error)}`);
			}
		} else {
			// --- Simple Multipart Upload for smaller files ---
			const fileData = await fileResponse.arrayBuffer();
			const formData = new FormData();
			formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
			formData.append('file', new Blob([fileData]));

			const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
			const uploadResponse = await fetch(uploadUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwtToken}`,
				},
				body: formData,
			});

			const uploadResult = await uploadResponse.json();
			if (uploadResult.id) {
				await sendMessage(adminChatId, `File "${fileName}" has been successfully uploaded to Google Drive!`, botToken);
			} else {
				throw new Error(`Failed to upload file: ${JSON.stringify(uploadResult.error)}`);
			}
		}
	} catch (error) {
		await sendMessage(adminChatId, `An error occurred: ${error.message}`, botToken);
	}
}

// --- Helper Functions ---

async function getGoogleAuthToken(credentials) {
	const header = { alg: 'RS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iss: credentials.client_email,
		scope: 'https://www.googleapis.com/auth/drive',
		aud: 'https://oauth2.googleapis.com/token',
		exp: now + 3600,
		iat: now,
	};

	const encodedHeader = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const encodedPayload = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const dataToSign = `${encodedHeader}.${encodedPayload}`;

	const privateKey = await crypto.subtle.importKey(
		'pkcs8',
		str2ab(atob(credentials.private_key.replace('-----BEGIN PRIVATE KEY-----\n', '').replace('\n-----END PRIVATE KEY-----\n', ''))),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, str2ab(dataToSign));
	const encodedSignature = btoa(ab2str(signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

	const jwt = `${dataToSign}.${encodedSignature}`;

	const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
	});

	const tokenData = await tokenResponse.json();
	return tokenData.access_token;
}

async function sendMessage(chatId, text, botToken) {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}`;
	await fetch(url);
}

function str2ab(str) {
	const buf = new ArrayBuffer(str.length);
	const bufView = new Uint8Array(buf);
	for (let i = 0, strLen = str.length; i < strLen; i++) {
		bufView[i] = str.charCodeAt(i);
	}
	return buf;
}

function ab2str(buf) {
	return String.fromCharCode.apply(null, new Uint8Array(buf));
}
