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
	const fileSize = fileData.byteLength;

	// Authenticate with Google Drive
	const jwtToken = await getGoogleAuthToken(googleCredentials);

	// Check if file is larger than 20MB (20 * 1024 * 1024 = 20971520 bytes)
	const MAX_SIMPLE_UPLOAD_SIZE = 20971520;

	if (fileSize > MAX_SIMPLE_UPLOAD_SIZE) {
		await sendMessage(adminChatId, `File "${fileName}" is ${Math.round(fileSize / 1024 / 1024)}MB, using resumable upload...`, botToken);
		await uploadLargeFile(fileData, fileName, driveFolderId, jwtToken, adminChatId, botToken);
	} else {
		await uploadSmallFile(fileData, fileName, driveFolderId, jwtToken, adminChatId, botToken);
	}
}

async function uploadSmallFile(fileData, fileName, driveFolderId, jwtToken, adminChatId, botToken) {
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
		await sendMessage(adminChatId, `Error uploading file: ${JSON.stringify(uploadResult.error)}`, botToken);
	}
}

async function uploadLargeFile(fileData, fileName, driveFolderId, jwtToken, adminChatId, botToken) {
	const metadata = {
		name: fileName,
		parents: [driveFolderId],
	};

	// Step 1: Initiate resumable upload
	const initiateUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
	const initiateResponse = await fetch(initiateUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwtToken}`,
			'Content-Type': 'application/json',
			'X-Upload-Content-Type': 'application/octet-stream',
			'X-Upload-Content-Length': fileData.byteLength.toString(),
		},
		body: JSON.stringify(metadata),
	});

	if (!initiateResponse.ok) {
		const error = await initiateResponse.text();
		await sendMessage(adminChatId, `Error initiating resumable upload: ${error}`, botToken);
		return;
	}

	const resumableUploadUrl = initiateResponse.headers.get('Location');
	if (!resumableUploadUrl) {
		await sendMessage(adminChatId, `Error: No resumable upload URL received`, botToken);
		return;
	}

	// Step 2: Check if any bytes have already been uploaded
	let uploadedBytes = await getUploadStatus(resumableUploadUrl, jwtToken);
	if (uploadedBytes > 0) {
		await sendMessage(adminChatId, `Resuming upload from ${Math.round(uploadedBytes / 1024 / 1024)}MB`, botToken);
	}

	// Step 3: Upload file in chunks
	const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
	const MAX_RETRIES = 3;
	const totalSize = fileData.byteLength;

	while (uploadedBytes < totalSize) {
		const start = uploadedBytes;
		const end = Math.min(start + CHUNK_SIZE, totalSize);
		const chunk = fileData.slice(start, end);
		const chunkSize = end - start;

		let retryCount = 0;
		let success = false;

		while (retryCount < MAX_RETRIES && !success) {
			try {
				const chunkResponse = await fetch(resumableUploadUrl, {
					method: 'PUT',
					headers: {
						Authorization: `Bearer ${jwtToken}`,
						'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
						'Content-Length': chunkSize.toString(),
					},
					body: chunk,
				});

				if (chunkResponse.status === 308) {
					// Chunk uploaded successfully, continue with next chunk
					const rangeHeader = chunkResponse.headers.get('Range');
					if (rangeHeader) {
						const rangeMatch = rangeHeader.match(/bytes=0-(\d+)/);
						if (rangeMatch) {
							uploadedBytes = parseInt(rangeMatch[1]) + 1;
						} else {
							uploadedBytes = end;
						}
					} else {
						uploadedBytes = end;
					}

					// Send progress update (only every 20% to avoid spam)
					const progress = Math.round((uploadedBytes / totalSize) * 100);
					if (progress % 20 === 0 || uploadedBytes === end) {
						await sendMessage(
							adminChatId,
							`Upload progress: ${progress}% (${Math.round(uploadedBytes / 1024 / 1024)}MB / ${Math.round(totalSize / 1024 / 1024)}MB)`,
							botToken
						);
					}
					success = true;
				} else if (chunkResponse.status === 200 || chunkResponse.status === 201) {
					// Upload completed
					const uploadResult = await chunkResponse.json();
					if (uploadResult.id) {
						await sendMessage(adminChatId, `File "${fileName}" uploaded to Google Drive successfully!`, botToken);
					} else {
						await sendMessage(adminChatId, `Error completing upload: ${JSON.stringify(uploadResult)}`, botToken);
					}
					return;
				} else if (chunkResponse.status === 404) {
					// Session expired, need to restart
					await sendMessage(adminChatId, `Upload session expired. Please try uploading the file again.`, botToken);
					return;
				} else if (chunkResponse.status >= 500) {
					// Server error, retry
					retryCount++;
					if (retryCount < MAX_RETRIES) {
						await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
						await sendMessage(adminChatId, `Server error, retrying chunk upload... (${retryCount}/${MAX_RETRIES})`, botToken);
					}
				} else {
					// Other error, don't retry
					const error = await chunkResponse.text();
					await sendMessage(adminChatId, `Error uploading chunk: ${error}`, botToken);
					return;
				}
			} catch (error) {
				retryCount++;
				if (retryCount < MAX_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
					await sendMessage(adminChatId, `Network error, retrying chunk upload... (${retryCount}/${MAX_RETRIES})`, botToken);
				} else {
					await sendMessage(adminChatId, `Network error uploading chunk after ${MAX_RETRIES} retries: ${error.message}`, botToken);
					return;
				}
			}
		}

		if (!success) {
			await sendMessage(adminChatId, `Failed to upload chunk after ${MAX_RETRIES} retries`, botToken);
			return;
		}
	}
}

async function getUploadStatus(resumableUploadUrl, jwtToken) {
	try {
		const statusResponse = await fetch(resumableUploadUrl, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${jwtToken}`,
				'Content-Range': 'bytes */*',
			},
		});

		if (statusResponse.status === 308) {
			const rangeHeader = statusResponse.headers.get('Range');
			if (rangeHeader) {
				const rangeMatch = rangeHeader.match(/bytes=0-(\d+)/);
				if (rangeMatch) {
					return parseInt(rangeMatch[1]) + 1;
				}
			}
		}
		return 0;
	} catch (error) {
		return 0;
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
