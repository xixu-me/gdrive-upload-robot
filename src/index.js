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

// Export helper functions for testing
export { getFileTypeAdvice, handleLargeFileWithChunks };

async function handleDocument(message, env) {
	const fileId = message.document.file_id;
	const fileName = message.document.file_name;
	await uploadToDrive(fileId, fileName, env);
}

async function handlePhoto(message, env) {
	const photo = message.photo[message.photo.length - 1]; // Get the highest resolution photo
	const fileId = photo.file_id;
	const fileName = `${fileId}.jpg`;
	await uploadToDrive(fileId, fileName, env);
}

async function uploadToDrive(fileId, fileName, env) {
	const botToken = env.TELEGRAM_BOT_TOKEN;
	const driveFolderId = env.GOOGLE_DRIVE_FOLDER_ID;
	const adminChatId = env.ADMIN_CHAT_ID;
	const googleCredentials = JSON.parse(env.GOOGLE_CREDENTIALS);

	// Get file path from Telegram
	const fileDetailsUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
	const fileDetailsResponse = await fetch(fileDetailsUrl);
	const fileDetails = await fileDetailsResponse.json();
	if (!fileDetails.ok) {
		await sendMessage(adminChatId, `Error getting file details: ${fileDetails.description}`, botToken);
		return;
	}

	const filePath = fileDetails.result.file_path;
	const fileSize = fileDetails.result.file_size;
	const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

	// Check if file exceeds Telegram's 20MB limit
	if (fileSize > 20 * 1024 * 1024) {
		const advice = await getFileTypeAdvice(fileName);
		await sendMessage(
			adminChatId,
			`❌ File "${fileName}" is ${(fileSize / 1024 / 1024).toFixed(2)}MB, which exceeds Telegram's 20MB limit.\n\n` +
				`💡 Suggestion: ${advice}\n\n` +
				`🔧 Alternatives:\n` +
				`• Compress using ZIP/RAR\n` +
				`• Upload directly to Google Drive\n` +
				`• Use Google Drive mobile app\n` +
				`• Split into smaller files`,
			botToken
		);
		return;
	}

	// Authenticate with Google Drive
	const jwtToken = await getGoogleAuthToken(googleCredentials);

	try {
		// Use resumable upload for better reliability
		if (fileSize > 5 * 1024 * 1024) {
			// Use resumable upload for files > 5MB
			await uploadToDriveResumable(fileUrl, fileName, fileSize, driveFolderId, jwtToken, adminChatId, botToken);
		} else {
			// Use simple upload for smaller files
			await uploadToDriveSimple(fileUrl, fileName, driveFolderId, jwtToken, adminChatId, botToken);
		}
	} catch (error) {
		await sendMessage(adminChatId, `Error uploading file "${fileName}": ${error.message}`, botToken);
	}
}

async function uploadToDriveSimple(fileUrl, fileName, driveFolderId, jwtToken, adminChatId, botToken) {
	// Download file from Telegram
	const fileResponse = await fetch(fileUrl);
	const fileData = await fileResponse.arrayBuffer();

	// Upload file to Google Drive using multipart upload
	const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
	const metadata = {
		name: fileName,
		parents: [driveFolderId],
	};

	const formData = new FormData();
	formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
	formData.append('file', new Blob([fileData]));

	const uploadResponse = await fetch(uploadUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwtToken}`,
		},
		body: formData,
	});

	const uploadResult = await uploadResponse.json();
	if (uploadResult.id) {
		await sendMessage(adminChatId, `File "${fileName}" uploaded to Google Drive successfully!`, botToken);
	} else {
		throw new Error(JSON.stringify(uploadResult.error));
	}
}

async function uploadToDriveResumable(fileUrl, fileName, fileSize, driveFolderId, jwtToken, adminChatId, botToken) {
	// Step 1: Initiate resumable upload session
	const metadata = {
		name: fileName,
		parents: [driveFolderId],
	};

	const initiateResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwtToken}`,
			'Content-Type': 'application/json',
			'X-Upload-Content-Length': fileSize.toString(),
		},
		body: JSON.stringify(metadata),
	});

	if (!initiateResponse.ok) {
		throw new Error(`Failed to initiate resumable upload: ${initiateResponse.statusText}`);
	}

	const uploadUrl = initiateResponse.headers.get('Location');

	// Step 2: Stream upload the file content
	const fileResponse = await fetch(fileUrl);

	if (!fileResponse.ok) {
		throw new Error(`Failed to fetch file from Telegram: ${fileResponse.statusText}`);
	}

	const uploadResponse = await fetch(uploadUrl, {
		method: 'PUT',
		headers: {
			'Content-Length': fileSize.toString(),
		},
		body: fileResponse.body, // Stream the response directly
	});

	if (!uploadResponse.ok) {
		throw new Error(`Upload failed: ${uploadResponse.statusText}`);
	}

	const uploadResult = await uploadResponse.json();
	if (uploadResult.id) {
		await sendMessage(
			adminChatId,
			`Large file "${fileName}" (${(fileSize / 1024 / 1024).toFixed(2)}MB) uploaded to Google Drive successfully using resumable upload!`,
			botToken
		);
	} else {
		throw new Error('Upload completed but no file ID returned');
	}
}

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

// Add support for chunked file processing
async function handleLargeFileWithChunks(fileId, fileName, fileSize, env) {
	const adminChatId = env.ADMIN_CHAT_ID;
	const botToken = env.TELEGRAM_BOT_TOKEN;

	// Suggest chunking for very large files
	if (fileSize > 20 * 1024 * 1024) {
		await sendMessage(
			adminChatId,
			`File "${fileName}" is ${(fileSize / 1024 / 1024).toFixed(2)}MB. ` +
				`Please split it into chunks smaller than 20MB or use these alternatives:\n\n` +
				`📦 Compress the file using ZIP/RAR\n` +
				`🔗 Upload directly to Google Drive\n` +
				`📱 Use Google Drive mobile app\n` +
				`✂️ Split into smaller files`,
			botToken
		);
		return false;
	}
	return true;
}

// Enhanced error handling for different file types
async function getFileTypeAdvice(fileName) {
	const extension = fileName.split('.').pop()?.toLowerCase();

	const compressionAdvice = {
		// Video files
		mp4: 'Consider reducing video quality or using H.265 encoding',
		avi: 'Convert to MP4 with lower bitrate',
		mov: 'Convert to MP4 format for better compression',
		mkv: 'Convert to MP4 or use video compression',

		// Image files
		png: 'Convert to JPEG or reduce image dimensions',
		bmp: 'Convert to JPEG or PNG format',
		tiff: 'Convert to JPEG format',

		// Document files
		pdf: 'Compress PDF or split into multiple files',
		docx: 'Save as PDF or compress embedded images',
		pptx: 'Compress images within presentation',

		// Archive files
		zip: 'Use higher compression ratio or split archive',
		rar: 'Use maximum compression or split archive',
		'7z': 'Already well compressed, consider splitting',

		// Default
		default: 'Consider compressing or splitting the file',
	};

	return compressionAdvice[extension] || compressionAdvice['default'];
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
