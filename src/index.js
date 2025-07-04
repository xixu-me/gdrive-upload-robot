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
	const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

	// Download file from Telegram
	const fileResponse = await fetch(fileUrl);
	const fileData = await fileResponse.arrayBuffer();

	// Authenticate with Google Drive
	const jwtToken = await getGoogleAuthToken(googleCredentials);

	// Upload file to Google Drive
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
		await sendMessage(adminChatId, `Error uploading file: ${JSON.stringify(uploadResult.error)}`, botToken);
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
